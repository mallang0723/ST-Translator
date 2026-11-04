import { describe, expect, test } from 'bun:test';
import { clearTranslation, DELETE_TRANSLATION_LABEL, isTranslationHidden, messageIdFromScope, recordFor, showsToggle, skipFresh, targetLabel, toolbarState, wantsBar } from '../src/message-ui';
import { type MessageTranslations, type MessageView, sourceHash } from '../src/shared';

function view(over: Partial<MessageView> & { messageId: string }): MessageView {
  return {
    role: 'assistant',
    text: null,
    status: null,
    hasMore: false,
    progress: null,
    error: null,
    hidden: false,
    busy: false,
    index: 0,
    name: '',
    sourceKey: '',
    ...over,
  };
}

const translated = (id: string, index: number, _updatedAt: number, over: Partial<MessageView> = {}) =>
  view({ messageId: id, index, text: 'ok', status: 'done', ...over });

describe('message label', () => {
  test('label is "#index name"', () => {
    expect(targetLabel({ index: 225, name: '정수빈' })).toBe('#225 정수빈');
    expect(targetLabel({ index: 3, name: '  ' })).toBe('#3');
  });
});

describe('toolbar state', () => {
  test('no translation: plain translate, nothing to delete', () => {
    const s = toolbarState(view({ messageId: 'a' }));
    expect(s).toMatchObject({ action: 'translate', force: false, label: '번역', canDelete: false, busy: false });
  });

  test('a saved translation: the same button re-translates (forced) and the delete button appears', () => {
    const s = toolbarState(translated('a', 1, 1));
    expect(s.action).toBe('translate');
    expect(s.force).toBe(true);
    expect(s.label).toContain('다시 번역');
    expect(s.canDelete).toBe(true);
  });

  test('partial translation: re-translate and delete are both offered', () => {
    const s = toolbarState(translated('a', 1, 1, { status: 'partial', hasMore: true }));
    expect(s).toMatchObject({ force: true, canDelete: true });
  });

  test('error without any text: retry (forced), nothing to delete', () => {
    const s = toolbarState(view({ messageId: 'a', status: 'error', error: 'x' }));
    expect(s).toMatchObject({ force: true, canDelete: false });
  });

  test('while running the button cancels, and delete is hidden', () => {
    const s = toolbarState(translated('a', 1, 1, { busy: true }));
    expect(s).toMatchObject({ action: 'cancel', canDelete: false, busy: true });
  });

  test('before the views arrive', () => {
    expect(toolbarState(null)).toMatchObject({ action: 'translate', canDelete: false });
  });

  test('the delete button cannot be mistaken for the host\'s delete-message button', () => {
    expect(DELETE_TRANSLATION_LABEL).toContain('번역');
    expect(DELETE_TRANSLATION_LABEL).toContain('메시지는 그대로');
  });

  test('the labels say the scope is the visible swipe only', () => {
    expect(DELETE_TRANSLATION_LABEL).toContain('스와이프');
  });
});

describe('scope', () => {
  test('message id is read from the host decorator scope', () => {
    expect(messageIdFromScope('message:fe0300af-3402:actions')).toBe('fe0300af-3402');
    expect(messageIdFromScope('message:abc:minimal:footer')).toBeNull();
    expect(messageIdFromScope('chat:x:actions')).toBeNull();
  });
});

describe('translate / re-translate decision', () => {
  test('a finished translation is only redone when forced', () => {
    expect(skipFresh('fresh', { status: 'done' }, false)).toBe(true);
    expect(skipFresh('fresh', { status: 'done' }, true)).toBe(false);
  });

  test('missing, partial and failed translations always run', () => {
    expect(skipFresh('fresh', undefined, false)).toBe(false);
    expect(skipFresh('fresh', { status: 'partial' }, false)).toBe(false);
    expect(skipFresh('fresh', { status: 'error' }, false)).toBe(false);
  });

  test('"continue" is never skipped', () => {
    expect(skipFresh('continue', { status: 'done' }, false)).toBe(false);
  });
});

describe('delete translation (per swipe)', () => {
  const record = (text: string) => ({ parts: [text], pieces: [], total: 1, truncatedPart: -1, status: 'done' as const, updatedAt: 1 });
  const swipes = ['첫 번째 스와이프', '두 번째 스와이프', '세 번째 스와이프'];
  const stored = (hidden = false): MessageTranslations => ({
    v: 1,
    entries: { [sourceHash(swipes[0]!)]: record('A'), [sourceHash(swipes[1]!)]: record('B'), [sourceHash(swipes[2]!)]: record('C') },
    hidden,
  });

  test('deleting one swipe leaves the other swipes\' translations', () => {
    const mt = stored();
    clearTranslation(mt, sourceHash(swipes[1]!));
    expect(Object.keys(mt.entries).sort()).toEqual([sourceHash(swipes[0]!), sourceHash(swipes[2]!)].sort());
    expect(mt.entries[sourceHash(swipes[0]!)]!.parts).toEqual(['A']);
    expect(mt.entries[sourceHash(swipes[2]!)]!.parts).toEqual(['C']);
    expect(recordFor(mt, swipes[1]!)).toBeNull();
  });

  test('the message-level hidden flag stays while other translations remain, and resets when none are left', () => {
    const mt = stored(true);
    clearTranslation(mt, sourceHash(swipes[0]!));
    clearTranslation(mt, sourceHash(swipes[1]!));
    expect(mt.hidden).toBe(true);
    clearTranslation(mt, sourceHash(swipes[2]!));
    expect(mt).toEqual({ v: 1, entries: {}, hidden: false });
  });

  test('an unknown key changes nothing', () => {
    const mt = stored();
    clearTranslation(mt, 'nope');
    expect(Object.keys(mt.entries)).toHaveLength(3);
  });

  test('stored format stays the 0.1.1 shape', () => {
    const mt = stored();
    clearTranslation(mt, sourceHash(swipes[0]!));
    expect(Object.keys(mt).sort()).toEqual(['entries', 'hidden', 'v']);
    expect(Object.keys(mt.entries[sourceHash(swipes[1]!)]!).sort()).toEqual(['parts', 'pieces', 'status', 'total', 'truncatedPart', 'updatedAt']);
  });

  test('0.1.1 data (no hidden field, keyed by sourceHash) is read and cleared the same way', () => {
    const old = { v: 1 as const, entries: { [sourceHash(swipes[0]!)]: record('A') } };
    expect(recordFor(old, swipes[0]!)?.parts).toEqual(['A']);
    clearTranslation(old, sourceHash(swipes[0]!));
    expect(old.entries).toEqual({});
  });
});

describe('toolbar follows the visible swipe', () => {
  const record = (text: string, status: 'done' | 'partial' = 'done') => ({ parts: [text], pieces: [], total: 1, truncatedPart: -1, status, updatedAt: 1 });
  const swipes = ['스와이프 0', '스와이프 1', '스와이프 2'];
  const mt: MessageTranslations = { v: 1, entries: { [sourceHash(swipes[0]!)]: record('A'), [sourceHash(swipes[2]!)]: record('C') } };

  /** What the backend builds for the message while `content` is the visible swipe. */
  const stateAt = (content: string, source: MessageTranslations | null = mt) => {
    const r = recordFor(source, content);
    return toolbarState(view({ messageId: 'm', text: r && r.parts.some((p) => p.trim()) ? r.parts.join('\n\n') : null, status: r?.status ?? null }));
  };

  test('delete shows only for a swipe that has a translation', () => {
    expect(stateAt(swipes[0]!).canDelete).toBe(true);
    expect(stateAt(swipes[1]!).canDelete).toBe(false);
    expect(stateAt(swipes[2]!).canDelete).toBe(true);
  });

  test('the translate button on an untranslated swipe is a plain translate, not a re-translate', () => {
    expect(stateAt(swipes[1]!)).toMatchObject({ force: false, label: '번역' });
    expect(stateAt(swipes[0]!)).toMatchObject({ force: true });
  });

  test('switching swipes updates it, and deleting the visible swipe hides the button without touching the others', () => {
    const live: MessageTranslations = structuredClone(mt);
    const seen = [swipes[0]!, swipes[1]!, swipes[2]!, swipes[0]!].map((c) => stateAt(c, live).canDelete);
    expect(seen).toEqual([true, false, true, true]);
    clearTranslation(live, sourceHash(swipes[0]!));
    expect(stateAt(swipes[0]!, live).canDelete).toBe(false);
    expect(stateAt(swipes[2]!, live).canDelete).toBe(true);
  });

  test('a message without stored translations offers no delete on any swipe', () => {
    for (const c of swipes) expect(stateAt(c, null).canDelete).toBe(false);
  });

  test('a failed attempt with no text keeps delete hidden', () => {
    const failed: MessageTranslations = { v: 1, entries: { [sourceHash(swipes[1]!)]: { parts: [], pieces: [], total: 1, truncatedPart: -1, status: 'error', updatedAt: 1 } } };
    expect(stateAt(swipes[1]!, failed)).toMatchObject({ canDelete: false, force: true });
  });
});

describe('slim status bar', () => {
  const modes = ['below', 'above', 'only', 'collapsed', 'collapsed-source'] as const;

  test('paragraph view: no bar and no toggle for a normally translated message', () => {
    const v = translated('a', 1, 1);
    expect(wantsBar(v, 'paragraph')).toBe(false);
    expect(showsToggle(v, 'paragraph')).toBe(false);
  });

  test('paragraph view: a bar for error, partial and busy', () => {
    expect(wantsBar(view({ messageId: 'a', status: 'error', error: 'x' }), 'paragraph')).toBe(true);
    expect(wantsBar(translated('a', 1, 1, { status: 'partial', hasMore: true }), 'paragraph')).toBe(true);
    expect(wantsBar(view({ messageId: 'a', busy: true }), 'paragraph')).toBe(true);
    expect(wantsBar(translated('a', 1, 1, { busy: true }), 'paragraph')).toBe(true);
  });

  test('paragraph view: even a partial or errored message gets no toggle', () => {
    expect(showsToggle(translated('a', 1, 1, { status: 'partial', hasMore: true }), 'paragraph')).toBe(false);
  });

  test('paragraph view: an untranslated message and a system message have no bar', () => {
    expect(wantsBar(view({ messageId: 'a' }), 'paragraph')).toBe(false);
    expect(wantsBar(view({ messageId: 'a', role: 'system', busy: true }), 'paragraph')).toBe(false);
  });

  test('other modes keep the bar and the show / hide toggle', () => {
    for (const mode of modes) {
      const v = translated('a', 1, 1);
      expect(wantsBar(v, mode)).toBe(true);
      expect(showsToggle(v, mode)).toBe(true);
      expect(wantsBar(translated('a', 1, 1, { status: 'partial', hasMore: true }), mode)).toBe(true);
      expect(showsToggle(translated('a', 1, 1, { status: 'partial', hasMore: true }), mode)).toBe(true);
      expect(wantsBar(view({ messageId: 'a', status: 'error', error: 'x' }), mode)).toBe(true);
      expect(wantsBar(view({ messageId: 'a', busy: true }), mode)).toBe(true);
      expect(wantsBar(view({ messageId: 'a' }), mode)).toBe(false);
      expect(wantsBar(view({ messageId: 'a', role: 'system', status: 'done' }), mode)).toBe(false);
      expect(wantsBar(view({ messageId: 'a', role: 'system', busy: true }), mode)).toBe(false);
      expect(showsToggle(view({ messageId: 'a' }), mode)).toBe(false);
      expect(showsToggle(view({ messageId: 'a', busy: true }), mode)).toBe(false);
      expect(showsToggle(view({ messageId: 'a', status: 'error', error: 'x' }), mode)).toBe(false);
    }
    expect(showsToggle(view({ messageId: 'a', status: 'error', error: 'x' }), 'below')).toBe(false);
  });

  test('a stale hidden flag never hides the paragraph view, but still hides other modes', () => {
    expect(isTranslationHidden(true, 'paragraph')).toBe(false);
    for (const mode of modes) {
      expect(isTranslationHidden(true, mode)).toBe(true);
      expect(isTranslationHidden(false, mode)).toBe(false);
      expect(isTranslationHidden(undefined, mode)).toBe(false);
    }
  });
});
