import { describe, expect, test } from 'bun:test';
import { installFake, msg } from './st-fake';
import { abortJobsExcept, autoTranslate, contextBefore, deleteTranslation, isBusy, onViewUpdate, setHidden, translateAt, translateMessage, translateOutgoing, viewOf } from '../src/st/jobs';
import { onMessageSent, resetDraftMemory } from '../src/st/input';
import { readTranslations } from '../src/st/records';
import { DEFAULT_SETTINGS } from '../src/shared';
import { saveSettings } from '../src/st/store';

const auto = () => saveSettings({ ...DEFAULT_SETTINGS, autoTranslate: true }, true);
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: (s: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('auto translate', () => {
  test('translates an assistant message and stores the record with a swipe mirror', async () => {
    const m: any = msg('Hello there.', { swipes: ['Hello there.'], swipe_id: 0, swipe_info: [{}] });
    const f = installFake({ chatId: 'c', chat: [m] });
    auto();
    const views: number[] = [];
    const off = onViewUpdate(() => views.push(1));
    await autoTranslate(0, 'normal');
    off();
    const mt = readTranslations(m)!;
    expect(Object.values(mt.entries)[0]!.status).toBe('done');
    expect(Object.values(mt.entries)[0]!.parts).toEqual(['안녕하세요.']);
    expect(m.swipe_info[0].extra.st_translator.entries).toEqual(mt.entries);
    expect(f.saves.chat).toBeGreaterThan(0);
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(isBusy(m)).toBe(false);
    expect(viewOf(m).text).toBe('안녕하세요.');
  });

  test.each([
    ['setting off', () => {}, msg('Hi.'), 'normal'],
    ['user message', auto, msg('Hi.', { is_user: true }), 'normal'],
    ['hidden message', auto, msg('Hi.', { is_system: true }), 'normal'],
    ['impersonate', auto, msg('Hi.'), 'impersonate'],
    ['first_message', auto, msg('Hi.'), 'first_message'],
    ['empty', auto, msg('   '), 'normal'],
  ])('skips: %s', async (_name, setup, m, type) => {
    const f = installFake({ chatId: 'c', chat: [m as any] });
    (setup as () => void)();
    await autoTranslate(0, type as string);
    expect(f.raw.calls.length).toBe(0);
    expect(readTranslations(m as any)).toBeNull();
  });

  test('already translated is skipped; manual force retranslates', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    auto();
    await autoTranslate(0, 'normal');
    await autoTranslate(0, 'normal');
    expect(f.raw.calls.length).toBe(1);
    await translateAt(0, false);
    expect(f.raw.calls.length).toBe(1);
    await translateAt(0, true);
    expect(f.raw.calls.length).toBe(2);
  });

  test('a second manual request while running toasts; an automatic one waits', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    const d = deferred();
    f.raw.impl = () => d.promise;
    const first = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    await translateMessage('c', m, 'fresh', { force: false, automatic: false });
    expect(f.toasts.some((t) => t.text === '이 메시지는 이미 번역 중입니다.')).toBe(true);
    d.resolve('번역');
    await first;
  });
});

describe('job lifecycle', () => {
  test('chat switch aborts silently and never saves into the new chat', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    auto();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const p = autoTranslate(0, 'normal');
    await tick();
    expect(isBusy(m)).toBe(true);
    f.switchChat('other', [msg('x')]);
    abortJobsExcept('other');
    await p;
    d.resolve('늦은 번역');
    expect(isBusy(m)).toBe(false);
    expect(f.saves.chat).toBe(0);
    expect(f.toasts.filter((t) => t.kind === 'error').length).toBe(0);
  });

  test('message deleted mid-job: nothing written, no error', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    auto();
    const d = deferred();
    f.raw.impl = () => d.promise;
    const p = autoTranslate(0, 'normal');
    await tick();
    f.ctx.chat.splice(0, 1);
    d.resolve('번역');
    await p;
    expect(readTranslations(m)).toBeNull();
    expect(f.toasts.length).toBe(0);
    expect(f.saves.chat).toBe(0);
  });

  test('user cancel records an error state and toasts', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    const d = deferred();
    f.raw.impl = () => d.promise;
    const p = translateMessage('c', m, 'fresh', { force: false, automatic: false });
    await tick();
    const { cancelMessage } = await import('../src/st/jobs');
    cancelMessage(m);
    await p;
    const rec = Object.values(readTranslations(m)!.entries)[0]!;
    expect(rec.status).toBe('error');
    expect(f.toasts.some((t) => t.kind === 'error' && t.text.includes('번역을 취소했습니다.'))).toBe(true);
  });

  test('failure stores the error on the record', async () => {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    f.raw.impl = async () => { throw new Error('boom'); };
    await translateAt(0, false);
    expect(viewOf(m).status).toBe('error');
    expect(viewOf(m).error).toBe('boom');
  });

  test('hide and delete act on the visible swipe only', async () => {
    const m: any = msg('Hello there.', { swipes: ['Hello there.', 'Other.'], swipe_id: 0, swipe_info: [{}, {}] });
    installFake({ chatId: 'c', chat: [m] });
    await translateAt(0, false);
    setHidden(m, true);
    expect(viewOf(m).hidden).toBe(true);
    await deleteTranslation(m);
    expect(viewOf(m).text).toBeNull();
    expect(readTranslations(m)?.hidden).toBe(false);
  });

  test('context uses saved translations and skips hidden messages', async () => {
    const a: any = msg('Hello there.');
    const b: any = msg('secret', { is_system: true });
    const u: any = msg('Question?', { is_user: true });
    installFake({ chatId: 'c', chat: [a, b, u] });
    await translateAt(0, false);
    const ctxMsgs = contextBefore([a, b, u], 3);
    expect(ctxMsgs.map((x) => [x.role, x.translation])).toEqual([['assistant', '안녕하세요.'], ['user', null]]);
  });
});

describe('outgoing', () => {
  const outgoingSettings = () => saveSettings({ ...DEFAULT_SETTINGS, translateMyMessages: true }, true);

  test('translateOutgoing returns the translated text', async () => {
    const f = installFake({ chatId: 'c' });
    f.raw.impl = async () => 'Hello.';
    expect(await translateOutgoing('c', '안녕')).toBe('Hello.');
  });

  test('MESSAGE_SENT replaces mes and the swipe text, then saves', async () => {
    const m: any = msg('안녕', { is_user: true, swipes: ['안녕'], swipe_id: 0 });
    const f = installFake({ chatId: 'c', chat: [m] });
    outgoingSettings();
    resetDraftMemory();
    f.raw.impl = async () => 'Hello.';
    await onMessageSent(0);
    expect(m.mes).toBe('Hello.');
    expect(m.swipes[0]).toBe('Hello.');
    expect(f.saves.chat).toBe(1);
  });

  test('failure keeps the original and tells the user', async () => {
    const m: any = msg('안녕', { is_user: true });
    const f = installFake({ chatId: 'c', chat: [m] });
    outgoingSettings();
    f.raw.impl = async () => { throw new Error('nope'); };
    await onMessageSent(0);
    expect(m.mes).toBe('안녕');
    expect(f.toasts.some((t) => t.kind === 'error' && t.text === '번역 실패: nope 원문을 보냅니다.')).toBe(true);
  });

  test('disabled setting and assistant messages are left alone', async () => {
    const m: any = msg('안녕', { is_user: true });
    const f = installFake({ chatId: 'c', chat: [m, msg('Hi')] });
    await onMessageSent(0);
    outgoingSettings();
    await onMessageSent(1);
    expect(f.raw.calls.length).toBe(0);
  });
});
