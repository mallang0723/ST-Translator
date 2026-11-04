import { afterEach, describe, expect, test } from 'bun:test';
import { installFake, msg } from './st-fake';
import { mountDisplay, TH_RENDER_EVENT } from '../src/st/display';
import { isPendingSwipe, onMessageReceived, onMessageSwiped, onMessageUpdated } from '../src/st/events';
import { confirmUnsaved, setUnsavedGuard } from '../src/st/guard';
import { abortJobsOfDeletedSwipes, errorText, setHidden, translateAt, translateMessage, viewOf } from '../src/st/jobs';
import { readTranslations } from '../src/st/records';
import { handleClick } from '../src/st/toolbar';
import { saveConnection, saveSettings } from '../src/st/store';
import { DEFAULT_SETTINGS, sourceHash } from '../src/shared';

// Display follows job updates, as in index.ts.
mountDisplay();

const profiles = [{ id: 'p1', name: 'P1', api: 'openai', model: 'm' }];
const only = () => saveSettings({ ...DEFAULT_SETTINGS, displayMode: 'only' }, true);
const deferred = () => {
  let resolve!: (s: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const realDocument = (globalThis as any).document;
afterEach(() => {
  if (realDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = realDocument;
  setUnsavedGuard(null);
});
/** A DOM just big enough for messageElement()/isEditing(). */
function fakeDom(editing = false) {
  (globalThis as any).document = {
    getElementById: (id: string) => (id === 'chat' ? { querySelector: () => ({ querySelector: (sel: string) => (editing && sel === '.edit_textarea' ? {} : null) }) } : null),
  };
}
function watchBlocks(f: ReturnType<typeof installFake>, th = false) {
  const blocks: number[] = [];
  const emitted: unknown[][] = [];
  f.ctx.updateMessageBlock = (id: number) => { blocks.push(id); };
  f.ctx.eventSource = { on() {}, removeListener() {}, events: th ? { [TH_RENDER_EVENT]: [() => {}] } : {}, emit: (...a: unknown[]) => { emitted.push(a); } };
  return { blocks, emitted };
}

describe('error text (cause chains, cancel)', () => {
  test('errorText unwraps Error.cause to the provider message', () => {
    const e = new Error('API request failed', { cause: new Error('Invalid API key XYZ') });
    expect(errorText(e)).toBe('Invalid API key XYZ');
  });
  test('an abort anywhere in the chain is a cancel', () => {
    const inner = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(errorText(new Error('API request failed', { cause: inner }))).toBe('번역을 취소했습니다.');
  });

  test('profile path: provider error is shown, not the wrapper', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m], profiles, selectedProfile: 'p1' });
    f.ctx.ConnectionManagerRequestService.sendRequest = async () => { throw new Error('API request failed', { cause: new Error('Invalid API key XYZ') }); };
    await translateAt(0, false);
    const rec = Object.values(readTranslations(m)!.entries)[0]!;
    expect(rec.status).toBe('error');
    expect(rec.error).toBe('Invalid API key XYZ');
    expect(f.toasts.some((t) => t.text === '번역 실패: Invalid API key XYZ')).toBe(true);
  });

  test('profile path: cancel mid-request takes the cancel path', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m], profiles, selectedProfile: 'p1' });
    const d = deferred();
    f.ctx.ConnectionManagerRequestService.sendRequest = async (_id: string, _m: unknown, _t: number, custom: { signal: AbortSignal }) => {
      await d.promise.catch(() => {});
      custom.signal.throwIfAborted?.();
      throw new Error('API request failed', { cause: Object.assign(new Error('fetch failed'), { name: 'TypeError' }) });
    };
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    const { cancelMessage } = await import('../src/st/jobs');
    cancelMessage(m);
    d.resolve('');
    await job;
    const rec = Object.values(readTranslations(m)!.entries)[0]!;
    expect(rec.error).toBe('번역을 취소했습니다.');
  });
});

describe('swipe and update events', () => {
  async function translatedOnly(extra: Record<string, unknown> = {}) {
    const m: any = msg('Hello there.', extra);
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    await translateAt(0, false);
    return { m, f };
  }

  test('isPendingSwipe', () => {
    expect(isPendingSwipe({ swipes: ['a'], swipe_id: 1 })).toBe(true);
    expect(isPendingSwipe({ swipes: ['a'], swipe_id: 0 })).toBe(false);
    expect(isPendingSwipe({})).toBe(false);
  });

  test('MESSAGE_SWIPED to a pending regeneration does not put the old translation back', async () => {
    const { m } = await translatedOnly({ swipes: ['Hello there.'], swipe_id: 0, swipe_info: [{}] });
    expect(m.extra.display_text).toBe('안녕하세요.');
    // ST: swipe past the last one -> clearMessageData deletes display_text, st_translator stays, mes is still old
    m.swipe_id = 1;
    delete m.extra.display_text;
    onMessageSwiped(0);
    expect(m.extra.display_text).toBeUndefined();
    // when the new reply arrives (different mes), received recompute drops the stale ownership
    m.mes = 'A brand new reply.';
    m.swipes.push(m.mes);
    onMessageReceived(0, 'swipe');
    expect(m.extra.display_text).toBeUndefined();
  });

  test('a normal swipe to a translated swipe still recomputes', async () => {
    const { m } = await translatedOnly({ swipes: ['Hello there.', 'Other.'], swipe_id: 0, swipe_info: [{}, {}] });
    delete m.extra.display_text;
    onMessageSwiped(0);
    expect(m.extra.display_text).toBe('안녕하세요.');
  });

  test('MESSAGE_RECEIVED after Continue drops the stale display_text before auto-translate', async () => {
    const { m } = await translatedOnly();
    expect(m.extra.display_text).toBe('안녕하세요.');
    m.mes = 'Hello there. And more words.';
    onMessageReceived(0, 'continue');
    expect(m.extra.display_text).toBeUndefined();
  });

  test('MESSAGE_UPDATED drops stale owned text and redraws display_text after an edit is closed', async () => {
    const { m, f } = await translatedOnly();
    fakeDom();
    const seen = watchBlocks(f, true);
    onMessageUpdated(0);
    expect(seen.blocks).toEqual([0]);
    expect(seen.emitted).toEqual([[TH_RENDER_EVENT, 0]]);
    // stale: text edited -> deleted (applyDisplay redraws once)
    m.mes = 'Edited.';
    seen.blocks.length = 0;
    onMessageUpdated(0);
    expect(m.extra.display_text).toBeUndefined();
    expect(seen.blocks).toEqual([0]);
  });

  test('no redraw while the message is being edited, or without display_text', async () => {
    const { m, f } = await translatedOnly();
    fakeDom(true);
    const seen = watchBlocks(f);
    onMessageUpdated(0);
    expect(seen.blocks).toEqual([]);
    fakeDom(false);
    delete m.extra.display_text;
    delete m.extra.st_translator;
    onMessageUpdated(0);
    expect(seen.blocks).toEqual([]);
  });
});

describe('jobs write to the swipe they translated', () => {
  test('swiping away mid-job keeps the record (and display_text) on the original swipe only', async () => {
    const a = 'Swipe A text.';
    const m: any = msg(a, { swipes: [a, 'Swipe B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    // ST's swipe: copy extra into swipe_info[A], then load B
    m.swipe_info[0].extra = structuredClone(m.extra ?? {});
    m.swipe_id = 1;
    m.mes = 'Swipe B text.';
    m.extra = structuredClone(m.swipe_info[1].extra ?? {});
    d.resolve('번역 A');
    await job;
    expect(readTranslations(m)).toBeNull();
    expect(m.extra.display_text).toBeUndefined();
    const saved = m.swipe_info[0].extra;
    expect(Object.values(saved.st_translator.entries as Record<string, any>)[0].parts).toEqual(['번역 A']);
    expect(saved.display_text).toBe('번역 A');
    expect(m.swipe_info[1].extra?.st_translator).toBeUndefined();
  });

  /** ST's swipe delete: splice swipes and swipe_info, the visible swipe becomes `to`. */
  const deleteSwipe = (m: any, at: number, to: number) => {
    m.swipes.splice(at, 1);
    m.swipe_info.splice(at, 1);
    m.swipe_id = to;
    m.mes = m.swipes[to];
    m.extra = structuredClone(m.swipe_info[to]?.extra ?? {});
  };

  test('deleting a lower swipe mid-job: the record still lands on the same swipe (start index follows the deletion)', async () => {
    const m: any = msg('B text.', { swipes: ['A text.', 'B text.', 'C text.'], swipe_id: 1, swipe_info: [{}, {}, {}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    m.swipe_info[1].extra = structuredClone(m.extra ?? {});
    deleteSwipe(m, 0, 0); // B is now index 0 and visible
    abortJobsOfDeletedSwipes({ messageId: 0, swipeId: 0, newSwipeId: 0 });
    d.resolve('번역 B');
    await job;
    const mt = readTranslations(m)!;
    expect(Object.values(mt.entries)[0]!.parts).toEqual(['번역 B']);
    expect(m.swipe_info[1].extra?.st_translator).toBeUndefined();
    expect(m.mes).toBe('B text.');
  });

  test('deleting the job swipe drops the write and aborts the job', async () => {
    const m: any = msg('A text.', { swipes: ['A text.', 'B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    deleteSwipe(m, 0, 0);
    abortJobsOfDeletedSwipes({ messageId: 0, swipeId: 0, newSwipeId: 0 });
    d.resolve('번역 A');
    await job;
    expect(readTranslations(m)).toBeNull();
    expect(m.swipe_info[0].extra?.st_translator).toBeUndefined();
    expect(viewOf(m, 0).busy).toBe(false);
  });

  test('without swipe_info at start the swipe is found by its text hash', async () => {
    const m: any = msg('B text.', { swipes: ['A text.', 'B text.'], swipe_id: 1 });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    // ST backfills swipe_info, then the lower swipe is deleted
    m.swipe_info = [{}, {}];
    m.swipes.splice(0, 1);
    m.swipe_info.splice(0, 1);
    m.swipe_id = 0;
    abortJobsOfDeletedSwipes({ messageId: 0, swipeId: 0, newSwipeId: 0 });
    d.resolve('번역 B');
    await job;
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역 B']);
  });

  /** Runs a job on `m` (deferred), lets `mid` change the message, resolves, and returns after the job. */
  async function runWith(m: any, mid: () => void, result = '번역') {
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    mid();
    d.resolve(result);
    await job;
    return f;
  }
  const savedParts = (info: any) => Object.values((info?.extra?.st_translator?.entries ?? {}) as Record<string, any>).map((r) => r.parts[0]);

  test('ST replaces the swipe_info objects mid-job (Continue): the result is kept on the same swipe', async () => {
    const m: any = msg('A part one.', { swipes: ['A part one.', 'B text.'], swipe_id: 0, swipe_info: [{ extra: {} }, {}] });
    await runWith(m, () => {
      // saveReply tail: mes extended, swipes synced, swipe_info[0] replaced by a new object
      m.mes = 'A part one. More.';
      m.swipes[0] = m.mes;
      m.swipe_info[0] = { extra: structuredClone(m.extra ?? {}) };
    });
    // job hash is of the text at job start; the swipe text changed, so the write is dropped, not misplaced
    expect(savedParts(m.swipe_info[1])).toEqual([]);
  });

  test('swipe_info replaced with unchanged text: the result lands on the same swipe', async () => {
    const m: any = msg('A text.', { swipes: ['A text.', 'B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    await runWith(m, () => { m.swipe_info = [{ extra: {} }, { extra: {} }]; });
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
    expect(savedParts(m.swipe_info[1])).toEqual([]);
  });

  test('Continue with mes extended before the job starts: the job hashes the extended text', async () => {
    const m: any = msg('A part one. More.', { swipes: ['A part one.', 'B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    await runWith(m, () => { m.swipes[0] = m.mes; m.swipe_info[0] = { extra: structuredClone(m.extra ?? {}) }; });
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
  });

  test('non-streamed Continue: swipes[] still holds the old text during the job → record kept on the same swipe', async () => {
    // ST's appendFinal path emits MESSAGE_RECEIVED with mes extended but swipes[swipe_id] not yet synced.
    const m: any = msg('A part one. More.', { swipes: ['A part one.', 'B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    await runWith(m, () => {});
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
    expect(viewOf(m).busyElsewhere).toBe(false);
  });

  test('swipe_info absent at start, backfilled later: the record is written to the swipe', async () => {
    const m: any = msg('A text.', { swipes: ['A text.', 'B text.'], swipe_id: 0 });
    await runWith(m, () => { m.swipe_info = [{}, {}]; });
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
  });

  test('deleting a swipe above the job swipe changes nothing', async () => {
    const m: any = msg('A text.', { swipes: ['A text.', 'B text.', 'C text.'], swipe_id: 0, swipe_info: [{}, {}, {}] });
    await runWith(m, () => { deleteSwipe(m, 2, 0); abortJobsOfDeletedSwipes({ messageId: 0, swipeId: 2, newSwipeId: 0 }); });
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
  });

  test('deleting a lower swipe while the job swipe is not visible writes to the shifted swipe_info', async () => {
    const m: any = msg('C text.', { swipes: ['A text.', 'B text.', 'C text.'], swipe_id: 2, swipe_info: [{}, {}, {}] });
    await runWith(m, () => {
      // user moves to A, then deletes B (index 1 < start 2): C becomes index 1
      m.swipe_info[2].extra = structuredClone(m.extra ?? {});
      m.swipe_id = 0; m.mes = 'A text.'; m.extra = {};
      deleteSwipe(m, 1, 0);
      abortJobsOfDeletedSwipes({ messageId: 0, swipeId: 1, newSwipeId: 0 });
    });
    expect(savedParts(m.swipe_info[1])).toEqual(['번역']);
    expect(savedParts(m.swipe_info[0])).toEqual([]);
  });

  test('identical swipe texts: deletion tracking keeps the job on its own swipe', async () => {
    const m: any = msg('Same.', { swipes: ['Same.', 'Same.'], swipe_id: 1, swipe_info: [{}, {}] });
    await runWith(m, () => { deleteSwipe(m, 0, 0); abortJobsOfDeletedSwipes({ messageId: 0, swipeId: 0, newSwipeId: 0 }); });
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
    expect(m.swipes.length).toBe(1);
  });

  test('a normal message without swipes is translated', async () => {
    const m: any = msg('Question?', { is_user: true });
    await runWith(m, () => {});
    expect(Object.values(readTranslations(m)!.entries)[0]!.parts).toEqual(['번역']);
  });

  test('deleting the translation of the visible swipe leaves a job on another swipe running', async () => {
    const m: any = msg('A text.', { swipes: ['A text.', 'B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    // user moves to B, which already has a translation, and deletes it
    m.swipe_info[0].extra = structuredClone(m.extra ?? {});
    m.swipe_id = 1; m.mes = 'B text.';
    m.extra = { st_translator: { v: 1, entries: { [sourceHash('B text.')]: { parts: ['비'], pieces: [], total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 } } } };
    m.swipe_info[1].extra = structuredClone(m.extra);
    expect(viewOf(m, 0).busyElsewhere).toBe(true);
    const { deleteTranslation } = await import('../src/st/jobs');
    await deleteTranslation(m);
    expect(viewOf(m, 0).busyElsewhere).toBe(true); // job still running
    expect(viewOf(m, 0).text).toBeNull();
    d.resolve('번역 A');
    await job;
    expect(savedParts(m.swipe_info[0])).toEqual(['번역 A']);
    void f;
  });

  test('the toolbar is inert and neutral while another swipe is translating', async () => {
    const { toolbarState } = await import('../src/message-ui');
    const s = toolbarState({ busy: false, busyElsewhere: true, text: 'x', status: 'done' });
    expect(s).toMatchObject({ action: 'elsewhere', busy: false, canDelete: true, label: '다른 스와이프를 번역하는 중입니다' });
  });

  test('a finished job clears hidden on every swipe', async () => {
    const m: any = msg('A.', { swipes: ['A.', 'B.', 'C.'], swipe_id: 1, swipe_info: [{}, {}, {}] });
    installFake({ chatId: 'c', chat: [m] });
    await translateAt(0, false);
    setHidden(m, true);
    await translateAt(0, true);
    for (const i of [0, 1, 2]) expect(m.swipe_info[i].extra.st_translator.hidden).toBe(false);
    expect(readTranslations(m)!.hidden).toBe(false);
  });

  test('unchanged swipe writes the live extra and the mirror', async () => {
    const m: any = msg('Hello there.', { swipes: ['Hello there.'], swipe_id: 0, swipe_info: [{}] });
    installFake({ chatId: 'c', chat: [m] });
    await translateAt(0, false);
    expect(readTranslations(m)).not.toBeNull();
    expect(m.swipe_info[0].extra.st_translator.entries).toEqual(readTranslations(m)!.entries);
  });
});

describe('hidden flag is per message', () => {
  test('setHidden marks every swipe', async () => {
    const m: any = msg('A.', { swipes: ['A.', 'B.', 'C.'], swipe_id: 1, swipe_info: [{}, {}, {}] });
    installFake({ chatId: 'c', chat: [m] });
    await translateAt(0, false);
    setHidden(m, true);
    for (const i of [0, 1, 2]) expect(m.swipe_info[i].extra.st_translator.hidden).toBe(true);
    expect(readTranslations(m)!.hidden).toBe(true);
    // swiping to another swipe keeps it hidden
    m.swipe_id = 2;
    m.extra = structuredClone(m.swipe_info[2].extra);
    expect(viewOf(m).hidden).toBe(true);
    m.swipe_id = 1;
    setHidden(m, false);
    for (const i of [0, 1, 2]) expect(m.swipe_info[i].extra.st_translator.hidden).toBe(false);
  });
});

describe('connection is global', () => {
  test('a job uses the global connection even when old chat metadata pins another', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m], profiles: [...profiles, { id: 'p2', name: 'P2', api: 'openai', model: 'm' }], selectedProfile: 'p1', meta: { st_translator: { connectionId: 'p1' } } });
    saveConnection('p2');
    await translateAt(0, false);
    expect(f.requests[0].id).toBe('p2');
  });
});

describe('unsaved-settings guard', () => {
  function popup(f: ReturnType<typeof installFake>, answer: number) {
    const asked: unknown[][] = [];
    f.ctx.POPUP_TYPE = { CONFIRM: 2 };
    f.ctx.POPUP_RESULT = { AFFIRMATIVE: 1 };
    f.ctx.callGenericPopup = async (...a: unknown[]) => { asked.push(a); return answer; };
    return asked;
  }

  test('clean or no guard: no question', async () => {
    const f = installFake({ chatId: 'c' });
    const asked = popup(f, 1);
    expect(await confirmUnsaved()).toBe(true);
    setUnsavedGuard({ isDirty: () => false, save: () => true });
    expect(await confirmUnsaved()).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test('dirty: asks with the original wording; yes saves first, no cancels', async () => {
    const f = installFake({ chatId: 'c' });
    const asked = popup(f, 1);
    let saved = 0;
    setUnsavedGuard({ isDirty: () => true, save: () => { saved++; return true; } });
    expect(await confirmUnsaved()).toBe(true);
    expect(saved).toBe(1);
    expect(String(asked[0]![0])).toContain('저장하지 않은 변경이 있어요');
    expect(String(asked[0]![0])).toContain('지금 저장하고 번역할까요?');
    expect((asked[0]![3] as any).okButton).toBe('저장하고 번역');
    popup(f, 0);
    expect(await confirmUnsaved()).toBe(false);
    expect(saved).toBe(1);
    // saving failed -> do not translate
    popup(f, 1);
    setUnsavedGuard({ isDirty: () => true, save: () => false });
    expect(await confirmUnsaved()).toBe(false);
  });

  test('the per-message translate button waits for the answer', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    popup(f, 0);
    setUnsavedGuard({ isDirty: () => true, save: () => true });
    const btn: any = { classList: { contains: (c: string) => c === 'stt-btn-translate' }, closest: () => ({ getAttribute: () => '0' }), dataset: {} };
    const target: any = { closest: () => btn };
    handleClick({ target, preventDefault() {}, stopPropagation() {} } as any);
    await tick();
    await tick();
    expect(f.raw.calls).toHaveLength(0);
    popup(f, 1);
    handleClick({ target, preventDefault() {}, stopPropagation() {} } as any);
    await tick();
    await tick();
    expect(f.raw.calls).toHaveLength(1);
  });
});

describe('abort detection, cancel records and busy swipe (F6, R2-2, R2-3)', () => {
  test('isAbortError: only real aborts count', async () => {
    const { isAbortError } = await import('../src/st/complete');
    expect(isAbortError(new Error('Connection aborted'))).toBe(false);
    expect(isAbortError(new Error('request was aborted by server'))).toBe(false);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('outer', { cause: new DOMException('stop', 'AbortError') }))).toBe(true);
    const c = new AbortController();
    expect(isAbortError(new Error('anything'), c.signal)).toBe(false);
    c.abort();
    expect(isAbortError(new Error('anything'), c.signal)).toBe(true);
    expect(errorText(new Error('Connection aborted'))).not.toBe('번역을 취소했습니다.');
  });

  test('a cancelled job stores a cancelled record; old records are recognised by the message', async () => {
    const { isCancelledRecord } = await import('../src/shared');
    const m: any = msg('Hello there.', { swipes: ['Hello there.'], swipe_id: 0, swipe_info: [{}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    expect(viewOf(m, 0).busy).toBe(true);
    const { cancelMessage } = await import('../src/st/jobs');
    cancelMessage(m);
    d.resolve('x');
    await job;
    const v = viewOf(m, 0);
    expect(v.status).toBe('error');
    expect(v.cancelled).toBe(true);
    expect(Object.values(readTranslations(m)!.entries)[0]!.cancelled).toBe(true);
    expect(isCancelledRecord({ status: 'error', error: '번역을 취소했습니다.' })).toBe(true);
    expect(isCancelledRecord({ status: 'error', error: 'boom' })).toBe(false);
  });

  test('busy is only on the swipe being translated; others get busyElsewhere', async () => {
    const m: any = msg('A text.', { swipes: ['A text.', 'B text.'], swipe_id: 0, swipe_info: [{}, {}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    only();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const job = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    expect(viewOf(m, 0)).toMatchObject({ busy: true, busyElsewhere: false });
    m.swipe_info[0].extra = structuredClone(m.extra ?? {});
    m.swipe_id = 1;
    m.mes = 'B text.';
    m.extra = {};
    expect(viewOf(m, 0)).toMatchObject({ busy: false, busyElsewhere: true });
    const { wantsBar, toolbarState } = await import('../src/message-ui');
    expect(wantsBar(viewOf(m, 0), 'below' as any)).toBe(true);
    expect(toolbarState(viewOf(m, 0)).busy).toBe(false);
    d.resolve('번역 A');
    await job;
    expect(viewOf(m, 0)).toMatchObject({ busy: false, busyElsewhere: false });
  });
});
