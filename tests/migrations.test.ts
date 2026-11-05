import { describe, expect, test } from 'bun:test';
import { pairParagraphs } from '../src/display/paragraph-view';
import { DEFAULT_SETTINGS, DEFAULT_VIEW, DISPLAY_MODES, normalizeStore, sourceHash, type TranslationRecord } from '../src/shared';
import { computeDisplayText } from '../src/st/display';
import { getStore, loadStore, saveCompat, saveSettings, settings } from '../src/st/store';
import { recordToText, requestsNeeded, translate } from '../src/translate/engine';
import { protect, restore } from '../src/translate/protect';
import { installFake, msg } from './st-fake';

describe('legacy compatibility settings migration', () => {
  test('enabled switch adds the tag once to defaults and every chat, without mutating input', () => {
    const raw = {
      compat: { autopic: true, loreveil: false, thRerender: false, debug: true },
      defaults: { excludeTags: 'choices, AutoPic, autopic' },
      chats: { own: { excludeTags: 'status' }, empty: { excludeTags: '' }, inherited: {} },
    };
    const before = JSON.stringify(raw);
    const store = normalizeStore(raw);
    expect(store.compat).toEqual({ singleInstance: true, loreveil: false, thRerender: false, debug: true });
    expect(store.defaults.excludeTags).toBe('choices, autopic');
    expect(store.chats.own!.excludeTags).toBe('status, autopic');
    expect(store.chats.empty!.excludeTags).toBe('autopic');
    expect(store.chats.inherited!.excludeTags).toBe('choices, autopic');
    expect(store.compat).not.toHaveProperty('autopic');
    expect(normalizeStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
    expect(JSON.stringify(raw)).toBe(before);
  });

  test('disabled switch adds nothing and preserves explicitly excluded tags', () => {
    const store = normalizeStore({ compat: { autopic: false }, defaults: { excludeTags: 'choices' }, chats: { own: { excludeTags: 'autopic' } } });
    expect(store.compat.singleInstance).toBe(false);
    expect(store.defaults.excludeTags).toBe('choices');
    expect(store.chats.own!.excludeTags).toBe('autopic');
    expect(store.legacyExcludeTags).toBeUndefined();
    expect(store.compat).not.toHaveProperty('autopic');
  });

  for (const compat of [{}, { thRerender: false }, { autopic: 'invalid' }]) {
    test(`saved legacy switches retain their enabled default: ${JSON.stringify(compat)}`, () => {
      const store = normalizeStore({ compat });
      expect(store.compat.singleInstance).toBe(true);
      expect(store.defaults.excludeTags).toBe('autopic');
    });
  }

  test('fresh installs and invalid compat objects have no legacy tag or key', () => {
    for (const raw of [undefined, null, {}, { compat: null }, { compat: [] }, { compat: true }]) {
      const store = normalizeStore(raw);
      expect(store.compat.singleInstance).toBe(true);
      expect(store.defaults.excludeTags).toBe('');
      expect(JSON.stringify(store)).not.toContain('autopic');
      expect(normalizeStore(store)).toEqual(store);
    }
  });

  test('current switches do not trigger migration', () => {
    for (const singleInstance of [true, false]) {
      const store = normalizeStore({ compat: { singleInstance } });
      expect(store.compat.singleInstance).toBe(singleInstance);
      expect(JSON.stringify(store)).not.toContain('autopic');
    }
  });

  test('saving drops the old key; unopened chats migrate after reload, only once', () => {
    const f = installFake({
      chatId: 'first', settings: { st_translator: { compat: { autopic: true } } },
      meta: { st_translator: { excludeTags: 'choices' } },
    });
    expect(settings().excludeTags).toBe('choices, autopic');
    saveCompat({ ...getStore().compat, singleInstance: false });
    expect(f.ctx.extensionSettings.st_translator.compat).not.toHaveProperty('autopic');
    expect(f.ctx.chatMetadata.st_translator.excludeTags).toBe('choices, autopic');

    loadStore();
    f.switchChat('unopened', [], { st_translator: { excludeTags: 'status' } });
    expect(settings().excludeTags).toBe('status, autopic');
    expect(getStore().compat.singleInstance).toBe(false);
    saveSettings({ ...settings(), excludeTags: 'status' }, false);
    const saved = JSON.parse(JSON.stringify(f.ctx.chatMetadata));
    f.switchChat('elsewhere');
    f.switchChat('unopened', [], saved);
    expect(settings().excludeTags).toBe('status');
    saveSettings(settings(), false);
    loadStore();
    expect(settings().excludeTags).toBe('status');
  });

  test('disabled legacy switch stays disabled when another old chat opens', () => {
    const f = installFake({ settings: { st_translator: { compat: { autopic: false } } } });
    saveCompat(getStore().compat);
    f.switchChat('old', [], { st_translator: { excludeTags: '' } });
    expect(settings().excludeTags).toBe('');
    expect(getStore().compat.singleInstance).toBe(false);
  });
});

// Original protection fixture: the legacy autopic:true path held this entire block as one piece.
const block = '<autopic>\n<scene>a girl</scene>\n<apchar ref="x">tall</apchar>\n<uc>bad</uc>\n</autopic>';
const code = '```html\n<div>demo</div>\n```';
const choices = '<choices>A</choices>';
const source = `Intro {{user}} ⟦9⟧.\n\n${choices}\n\n${block}\n\n${code}\n\nOutro.`;
// Literal markers are held first, then excluded elements, code, and finally macros.
const oldProtected = {
  text: 'Intro ⟦5⟧ ⟦1⟧.\n\n⟦2⟧\n\n⟦3⟧\n\n⟦4⟧\n\nOutro.',
  pieces: ['⟦9⟧', choices, block, code, '{{user}}'],
  blocks: [choices, block, code], blockMarkers: [2, 3, 4], ordered: [],
};
const oldRecord: TranslationRecord = {
  parts: ['도입 ⟦5⟧ ⟦1⟧.', '⟦2⟧', '⟦3⟧', '⟦4⟧', '끝.'], pieces: oldProtected.pieces,
  unit: 'paragraph', total: 5, truncatedPart: -1, status: 'done', updatedAt: 1,
};
const oldSettings = { protectHtml: false, protectCode: true, excludeTags: 'choices', translationUnit: 'paragraph' };
const migrated = () => normalizeStore({ compat: { autopic: true }, defaults: oldSettings });

describe('legacy record compatibility through explicit tags', () => {
  test('the generic excluded tag produces the exact old protected output', () => {
    const s = { ...DEFAULT_SETTINGS, ...oldSettings, translationUnit: 'paragraph' as const, excludeTags: 'choices, autopic' };
    expect(protect(source, s)).toEqual(oldProtected);
    const p = protect(`She smiles.\n\n${block}\n\nThe end.`, { ...s, protectCode: false });
    expect(p.text).toBe('She smiles.\n\n⟦1⟧\n\nThe end.');
    expect(p.pieces).toEqual([block]);
    expect(restore(p.text, p.pieces)).toBe(`She smiles.\n\n${block}\n\nThe end.`);
    expect(protect(block, { ...s, excludeTags: '' }).pieces).toEqual([]);
  });

  test('old paragraph records retain exact pairs, without the stale fallback', () => {
    const s = migrated().defaults;
    expect(protect(source, s)).toEqual(oldProtected);
    const paired = pairParagraphs(source, oldRecord, s);
    expect(paired.kind).toBe('paragraph');
    expect(paired.pairs).toEqual([
      { source: 'Intro {{user}} ⟦9⟧.', translation: '도입 {{user}} ⟦9⟧.' },
      { source: choices, translation: choices }, { source: block, translation: block },
      { source: code, translation: code }, { source: 'Outro.', translation: '끝.' },
    ]);
    expect(requestsNeeded(source, s, oldRecord)).toBe(0);
  });

  for (const displayMode of DISPLAY_MODES) {
    test(`old saved records display once in ${displayMode} mode after migration`, () => {
      const record = displayMode === 'paragraph' ? oldRecord : { ...oldRecord, unit: 'whole' as const, total: 1, parts: [oldRecord.parts.join('\n\n')] };
      const message = msg(source, { extra: { st_translator: { v: 1, entries: { [sourceHash(source)]: record } } } });
      const before = JSON.stringify(message);
      installFake({ chatId: 'old', chat: [message], settings: { st_translator: { compat: { autopic: true } } }, meta: { st_translator: { ...oldSettings, displayMode } } });
      const out = computeDisplayText(message, settings(), DEFAULT_VIEW, getStore().compat)!;
      expect(out).toContain('도입 {{user}} ⟦9⟧.');
      expect(out).toContain('끝.');
      expect(out.split(block)).toHaveLength(2);
      expect(out.split(code)).toHaveLength(2);
      expect(out).not.toContain('stt-pr-note');
      expect(JSON.stringify(message)).toBe(before);
    });
  }

  test('an old partial record resumes only its remaining paragraph', async () => {
    const s = migrated().defaults;
    const partial: TranslationRecord = { ...oldRecord, parts: oldRecord.parts.slice(0, 4), status: 'partial' };
    expect(requestsNeeded(source, s, partial)).toBe(1);
    let calls = 0;
    const record = await translate({ source, settings: s, direction: 'incoming', presets: [], previous: [], resume: partial }, {
      async complete(req) {
        calls++;
        expect(req.user).toContain('Outro.');
        expect(req.user).not.toMatch(/autopic|scene|girl|Intro/);
        return { text: '끝.' };
      },
    });
    expect(calls).toBe(1);
    expect(record.parts).toEqual(oldRecord.parts);
    expect(record.pieces).toEqual(oldRecord.pieces);
    expect(record.status).toBe('done');
    expect(recordToText(record)).toContain(block);
  });
});
