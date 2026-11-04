import { describe, expect, test } from 'bun:test';
import { buildParagraphView } from '../src/display/paragraph-view';
import { renderMessage } from '../src/display/render';
import { DEFAULT_SETTINGS, DEFAULT_VIEW, DISPLAY_MODES, normalizeSettings, normalizeStore, normalizeView, type ChatSettings, type TranslationRecord } from '../src/shared';

const record: TranslationRecord = { parts: ['번역 하나\n\n번역 둘'], pieces: [], total: 1, truncatedPart: -1, status: 'done', updatedAt: 0 };
const content = 'One.\n\nTwo.';
const settings = (displayMode: ChatSettings['displayMode']): ChatSettings => ({ ...DEFAULT_SETTINGS, displayMode });
const at = (text: string, needle: string) => text.indexOf(needle);

describe('display modes', () => {
  for (const unit of ['whole', 'paragraph'] as const) {
    test(`old ${unit} records render clean in every mode without mutation`, () => {
      const old: TranslationRecord = {
        ...record, unit, total: 2,
        parts: ['\n[ text to translate ]\n번역 하나\n[ end text ]\n', '[Previous Context — Reference Only]\n번역 둘\n[End Text]'],
      };
      const snapshot = JSON.stringify(old);
      const clean = { ...old, parts: ['번역 하나', '번역 둘'] };
      for (const mode of DISPLAY_MODES) {
        expect(renderMessage(content, old, settings(mode), DEFAULT_VIEW)).toBe(renderMessage(content, clean, settings(mode), DEFAULT_VIEW));
      }
      expect(JSON.stringify(old)).toBe(snapshot);
    });
  }

  test('display preserves interior literals and protected source text restored at the edges', () => {
    const literal = '앞 [End Text] 중간 [Text to Translate] [Previous Context — Reference Only] 뒤';
    expect(renderMessage(content, { ...record, parts: [literal] }, settings('only'), DEFAULT_VIEW)).toBe(literal);
    const protectedRecord = { ...record, parts: ['[Text to Translate]\n⟦1⟧번역⟦2⟧\n[End Text]'], pieces: ['[Text to Translate]', '[End Text]'] };
    expect(renderMessage(content, protectedRecord, settings('only'), DEFAULT_VIEW)).toBe('[Text to Translate]번역[End Text]');
  });

  test('below: original first, translation after', () => {
    const t = renderMessage(content, record, settings('below'), DEFAULT_VIEW);
    expect(at(t, 'One.')).toBeLessThan(at(t, '번역 하나'));
  });

  test('above: translation first, original after', () => {
    const t = renderMessage(content, record, settings('above'), DEFAULT_VIEW);
    expect(t.startsWith('번역 하나')).toBe(true);
    expect(at(t, '번역 둘')).toBeLessThan(at(t, 'One.'));
  });

  test('only and collapsed', () => {
    expect(renderMessage(content, record, settings('only'), DEFAULT_VIEW)).toBe('번역 하나\n\n번역 둘');
    const c = renderMessage(content, record, settings('collapsed'), DEFAULT_VIEW);
    expect(c.startsWith(content)).toBe(true);
    expect(c).toContain('<details class="stt-translation">');
  });

  test('collapsed-source: translation first, original in a closed expandable section', () => {
    const rendered = renderMessage(content, record, settings('collapsed-source'), DEFAULT_VIEW);
    expect(rendered).toBe(`번역 하나\n\n번역 둘\n\n<details class="stt-translation"><summary>원문</summary>\n\n${content}\n\n</details>`);
    expect(rendered).not.toContain(' open');
  });

  test('collapsed-source preserves source Markdown/HTML and restores translation markup', () => {
    const source = '**One.**\n\n<div>Two.</div>';
    const protectedRecord = { ...record, parts: ['**번역 하나**\n\n⟦1⟧번역 둘⟦2⟧'], pieces: ['<div>', '</div>'] };
    expect(renderMessage(source, protectedRecord, settings('collapsed-source'), DEFAULT_VIEW)).toBe(
      `**번역 하나**\n\n<div>번역 둘</div>\n\n<details class="stt-translation"><summary>원문</summary>\n\n${source}\n\n</details>`,
    );
  });

  for (const mode of ['only', 'collapsed-source'] as const) {
    test(`${mode}: missing, pending and failed translations leave the original unfolded`, () => {
      const unavailable = [
        null,
        undefined,
        { ...record, parts: [], status: 'partial' as const },
        { ...record, parts: [], status: 'error' as const, error: 'Translation failed' },
        { ...record, parts: [' ', '\n'] },
      ];
      for (const entry of unavailable) {
        expect(renderMessage(content, entry, settings(mode), DEFAULT_VIEW)).toBe(content);
      }
    });
  }

  test('collapsed-source keeps available partial text visible like only mode', () => {
    const partial = { ...record, status: 'partial' as const, total: 2 };
    const text = renderMessage(content, partial, settings('only'), DEFAULT_VIEW);
    expect(renderMessage(content, partial, settings('collapsed-source'), DEFAULT_VIEW)).toStartWith(`${text}\n\n<details`);
  });

  test('paragraph view: order inside each pair', () => {
    const src = renderMessage(content, record, settings('paragraph'), { ...DEFAULT_VIEW, paragraphOrder: 'source-first' });
    expect(at(src, '원문 1')).toBeLessThan(at(src, '번역 1'));
    expect(src).not.toContain('stt-pr-tfirst');
    const tr = renderMessage(content, record, settings('paragraph'), { ...DEFAULT_VIEW, paragraphOrder: 'translation-first' });
    expect(at(tr, '번역 1')).toBeLessThan(at(tr, '원문 1'));
    expect(at(tr, '원문 2')).toBeGreaterThan(at(tr, '번역 2'));
    expect(tr).toContain('stt-pr-tfirst');
  });

  test('tap view ignores the order (translation is always on top)', () => {
    const t = buildParagraphView(content, record, settings('paragraph'), 'tap', 'source-first');
    expect(at(t, '번역 1')).toBeLessThan(at(t, '원문 1'));
    expect(t).not.toContain('stt-pr-tfirst');
  });

  test('settings: new mode and order are stored, unknown values fall back', () => {
    expect(normalizeSettings({ displayMode: 'above' }).displayMode).toBe('above');
    expect(normalizeSettings({ displayMode: 'collapsed-source' }).displayMode).toBe('collapsed-source');
    expect(normalizeSettings({ displayMode: 'nope' }).displayMode).toBe('below');
    expect(normalizeView({ paragraphOrder: 'translation-first' }).paragraphOrder).toBe('translation-first');
    expect(normalizeView({}).paragraphOrder).toBe('source-first');
  });

  test('stores preserve existing modes and round-trip collapsed-source without changing defaults', () => {
    expect(DISPLAY_MODES).toEqual(['below', 'above', 'only', 'collapsed', 'collapsed-source', 'paragraph']);
    for (const mode of DISPLAY_MODES) {
      const raw = { version: 1, defaults: { displayMode: mode }, chats: { existing: { displayMode: mode }, inherited: {} } };
      const store = normalizeStore(JSON.parse(JSON.stringify(raw)));
      expect(store.defaults.displayMode).toBe(mode);
      expect(store.chats.existing?.displayMode).toBe(mode);
      expect(store.chats.inherited?.displayMode).toBe(mode);
      expect(normalizeStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
    }
    expect(normalizeStore(null).defaults.displayMode).toBe('below');
  });
});
