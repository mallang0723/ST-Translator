import { describe, expect, test } from 'bun:test';
import { deleteBundle, effectiveGuides, newBundleId, saveBundle } from '../src/bundles';
import { promptPresets } from '../src/presets';
import { DEFAULT_SETTINGS, normalizeSettings, normalizeStore, settingsFor, type UserBundle } from '../src/shared';
import { translate } from '../src/translate/engine';
import { buildTranslationRequest, SYSTEM_PROMPT_MAX, TranslationLimitError, type Direction, type TranslationRequest } from '../src/translate/prompt';

const bundle = (over: Partial<UserBundle> = {}): UserBundle => ({
  id: 'bundle-one', name: 'Fantasy', glossary: '마법사 = wizard\n기사 = knight',
  freeContext: 'Bundle setting', incomingVoicePrompt: 'Bundle voice', ...over,
});
const room = {
  ...DEFAULT_SETTINGS, bundleId: 'bundle-one', glossary: '마법사 = mage\n왕 = king',
  freeContext: 'Room setting', incomingVoicePrompt: 'Room voice',
  freeContextEnabled: true, incomingVoiceEnabled: true,
};

describe('bundle normalization and compatibility', () => {
  test('old stores keep their guide text, toggles, presets and version', () => {
    const { bundleId, ...oldRoom } = room;
    const old = { version: 1, defaults: oldRoom, chats: { c1: oldRoom }, userPresets: [{ id: 'custom-one', name: 'Mine', prompt: 'Translate' }] };
    const store = normalizeStore(old);
    expect(store.version).toBe(1);
    expect(store.userBundles).toEqual([]);
    expect(store.defaults).toEqual({ ...oldRoom, bundleId: '' });
    expect(store.chats.c1).toEqual(store.defaults);
    expect(store.userPresets).toEqual(old.userPresets);
    expect(normalizeStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
  });

  test('missing or malformed libraries become empty', () => {
    for (const value of [undefined, null, {}, 'bad']) expect(normalizeStore({ userBundles: value }).userBundles).toEqual([]);
  });

  test('drops bundles without id/name and duplicate ids; normalizes text safely', () => {
    const store = normalizeStore({ userBundles: [null, [], {}, { id: 'x', name: ' ' }, { name: 'No id' }, bundle(), bundle({ name: 'Duplicate' }), { id: ' b ', name: ' Empty ', glossary: 42, freeContext: null }] });
    expect(store.userBundles).toEqual([bundle(), bundle({ id: 'b', name: 'Empty', glossary: '', freeContext: '', incomingVoicePrompt: '' })]);
  });

  test('missing, malformed and unknown bundle ids normalize to none, even with bundled defaults', () => {
    for (const id of [undefined, null, 42, {}, '', 'missing']) {
      expect(normalizeSettings({ bundleId: id }, room, [bundle()]).bundleId).toBe('');
    }
    const store = normalizeStore({ userBundles: [bundle()], defaults: room, chats: { valid: room, missing: {}, bad: { bundleId: 'gone' } } });
    expect(store.defaults.bundleId).toBe(bundle().id);
    expect(store.chats.valid?.bundleId).toBe(bundle().id);
    expect(store.chats.missing?.bundleId).toBe('');
    expect(store.chats.bad?.bundleId).toBe('');
    expect(settingsFor(store, 'new-chat').bundleId).toBe(bundle().id);
    expect(normalizeStore({ defaults: room }).defaults.bundleId).toBe('');
    expect(normalizeStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
  });
});

describe('effective guides', () => {
  test('room glossary overrides matching left terms; context and voice append after a blank line', () => {
    const store = normalizeStore({ userBundles: [bundle()] });
    const before = JSON.stringify({ store, room });
    expect(effectiveGuides(store, room)).toEqual({
      glossary: '기사 = knight\n마법사 = mage\n왕 = king',
      freeContext: 'Bundle setting\n\nRoom setting', incomingVoicePrompt: 'Bundle voice\n\nRoom voice',
    });
    expect(JSON.stringify({ store, room })).toBe(before);
  });

  test('glossary matching trims terms and accepts CRLF and equals signs inside translations', () => {
    const store = { userBundles: [bundle({ glossary: ' A = old\r\nB = keep\ninvalid\nC = old' })] };
    expect(effectiveGuides(store, { ...room, glossary: ' A = new=value\r\nC = \n' }).glossary).toBe('B = keep\nC = old\nA = new=value');
  });

  test('empty parts do not add blank separators', () => {
    expect(effectiveGuides({ userBundles: [bundle({ freeContext: ' \n', incomingVoicePrompt: '' })] }, room)).toMatchObject({ freeContext: 'Room setting', incomingVoicePrompt: 'Room voice' });
    expect(effectiveGuides({ userBundles: [bundle()] }, { ...room, glossary: '', freeContext: ' ', incomingVoicePrompt: '' })).toEqual({ glossary: bundle().glossary, freeContext: 'Bundle setting', incomingVoicePrompt: 'Bundle voice' });
    expect(effectiveGuides({ userBundles: [bundle({ freeContext: '', incomingVoicePrompt: '' })] }, { ...room, freeContext: '', incomingVoicePrompt: '' }).freeContext).toBe('');
  });

  test('missing or unselected bundles use room text unchanged', () => {
    for (const bundleId of ['', 'deleted']) expect(effectiveGuides({ userBundles: [bundle()] }, { ...room, bundleId })).toEqual({ glossary: room.glossary, freeContext: room.freeContext, incomingVoicePrompt: room.incomingVoicePrompt });
  });

  test('edits affect every linked chat without copying text or changing toggles', () => {
    const store = normalizeStore({ userBundles: [bundle()], defaults: room, chats: { a: room, b: { ...room, incomingVoiceEnabled: false } } });
    const before = JSON.stringify([store.defaults, store.chats]);
    saveBundle(store, bundle({ name: 'Renamed', freeContext: 'Updated shared context' }));
    expect(store.userBundles).toHaveLength(1);
    for (const settings of [store.defaults, ...Object.values(store.chats)]) expect(effectiveGuides(store, settings).freeContext).toBe('Updated shared context\n\nRoom setting');
    expect(JSON.stringify([store.defaults, store.chats])).toBe(before);
  });

  test('deletion clears defaults and all references but preserves additions and other selections', () => {
    const other = bundle({ id: 'bundle-two' });
    const store = normalizeStore({ userBundles: [bundle(), other], defaults: room, chats: { a: room, b: room, c: { ...room, bundleId: other.id } } });
    deleteBundle(store, bundle().id);
    expect(store.userBundles).toEqual([other]);
    expect(store.defaults).toEqual({ ...room, bundleId: '' });
    expect(store.chats.a).toEqual(store.defaults);
    expect(store.chats.b).toEqual(store.defaults);
    expect(store.chats.c?.bundleId).toBe(other.id);
    const before = JSON.stringify(store);
    deleteBundle(store, 'already-gone');
    expect(JSON.stringify(store)).toBe(before);
    expect(normalizeStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
  });
});

describe('bundle creation', () => {
  const uuid = /^bundle-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  test('creates a generated id, allows empty contents and requires a nonblank name', () => {
    const store = normalizeStore(null);
    const saved = saveBundle(store, bundle({ id: '', name: '  Empty  ', glossary: '', freeContext: '', incomingVoicePrompt: '' }));
    expect(saved.id).toMatch(uuid);
    expect(saved.name).toBe('Empty');
    expect(store.userBundles).toEqual([saved]);
    expect(() => saveBundle(store, bundle({ name: ' ' }))).toThrow('묶음 이름');
    expect(store.userBundles).toHaveLength(1);
  });

  test('uses native UUID when available', () => {
    expect(newBundleId({ randomUUID: () => '00000000-0000-4000-8000-000000000000' })).toBe('bundle-00000000-0000-4000-8000-000000000000');
  });

  test('plain HTTP fallback works without randomUUID', () => {
    const cryptoApi = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
    const ids = Array.from({ length: 50 }, () => newBundleId(cryptoApi));
    expect(ids.every((id) => uuid.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('also handles hosts with no crypto methods', () => {
    expect(newBundleId({})).toMatch(uuid);
  });
});

describe('bundle prompts and translation engine', () => {
  const store = normalizeStore({ userBundles: [bundle()], chats: { c1: room } });
  const request = (direction: Direction, overrides = {}) => buildTranslationRequest({
    direction, text: '마법사 기사 왕', settings: { ...room, ...overrides }, store,
    presets: promptPresets([]), previous: [], hasMarkers: false,
  });

  test('incoming prompt includes combined glossary, context and voice', () => {
    const req = request('incoming');
    expect(req.user).toContain('"기사" → "knight"');
    expect(req.user).toContain('"마법사" → "mage"');
    expect(req.user).toContain('"왕" → "king"');
    expect(req.user).not.toContain('wizard');
    expect(req.system).toContain('Bundle setting\n\nRoom setting');
    expect(req.system).toContain('Bundle voice\n\nRoom voice');
  });

  test('outgoing includes glossary and context, but never either voice', () => {
    const req = request('outgoing');
    expect(req.user).toContain('"기사" → "knight"');
    expect(req.system).toContain('Bundle setting\n\nRoom setting');
    expect(req.system).not.toContain('Bundle voice');
    expect(req.system).not.toContain('Room voice');
  });

  test('room toggles gate both shared and room text', () => {
    const req = request('incoming', { freeContextEnabled: false, incomingVoiceEnabled: false });
    for (const text of ['Bundle setting', 'Room setting', 'Bundle voice', 'Room voice']) expect(req.system).not.toContain(text);
    expect(req.user).toContain('knight');
  });

  test('combined guides obey the existing prompt length limit', () => {
    expect(() => request('incoming', { freeContext: 'x'.repeat(SYSTEM_PROMPT_MAX) })).toThrow(TranslationLimitError);
  });

  test('saved bundle selection reaches the engine in both directions after reload', async () => {
    const reloaded = normalizeStore(JSON.parse(JSON.stringify(store)));
    for (const direction of ['incoming', 'outgoing'] as const) {
      const seen: TranslationRequest[] = [];
      await translate({ direction, source: '마법사 기사 왕', settings: settingsFor(reloaded, 'c1'), store: reloaded, presets: promptPresets([]), previous: [] }, {
        complete: async (req) => { seen.push(req); return { text: 'translated', finishReason: 'stop' }; },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(request(direction));
    }
  });
});
