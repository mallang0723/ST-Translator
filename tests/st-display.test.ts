import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { installFake, msg } from './st-fake';
import { applyDisplay, computeDisplayText, enableMarkdownInWrappers, recompute } from '../src/st/display';
import { translateAt, setHidden } from '../src/st/jobs';
import { readTranslations, writeTranslations } from '../src/st/records';
import { getStore, saveSettings } from '../src/st/store';
import { DEFAULT_SETTINGS, DEFAULT_VIEW, sourceHash, type ChatSettings } from '../src/shared';

const withMode = (displayMode: ChatSettings['displayMode']): ChatSettings => ({ ...DEFAULT_SETTINGS, displayMode });

async function translated(mes = 'Hello there.', extra: Record<string, unknown> = {}) {
  const m: any = msg(mes, extra);
  const f = installFake({ chatId: 'c', chat: [m] });
  await translateAt(0, false);
  return { m, f };
}

describe('computeDisplayText', () => {
  test('null without a record, with the original for other swipes', async () => {
    installFake({ chatId: 'c' });
    expect(computeDisplayText(msg('x') as any, DEFAULT_SETTINGS, DEFAULT_VIEW)).toBeNull();
  });

  test('renders per display mode', async () => {
    const { m } = await translated();
    expect(computeDisplayText(m, withMode('only'), DEFAULT_VIEW)).toBe('안녕하세요.');
    expect(computeDisplayText(m, withMode('below'), DEFAULT_VIEW)).toBe('Hello there.\n\n<hr class="stt-separator">\n\n안녕하세요.');
    expect(computeDisplayText(m, withMode('above'), DEFAULT_VIEW)).toContain('안녕하세요.\n\n<hr');
  });

  test('hidden flag: original in every mode except paragraph', async () => {
    const { m } = await translated();
    setHidden(m, true);
    expect(computeDisplayText(m, withMode('only'), DEFAULT_VIEW)).toBeNull();
    expect(computeDisplayText(m, withMode('paragraph'), DEFAULT_VIEW)).not.toBeNull();
  });

  test('edited message no longer matches the record', async () => {
    const { m } = await translated();
    m.mes = 'Hello there, edited.';
    expect(computeDisplayText(m, withMode('only'), DEFAULT_VIEW)).toBeNull();
  });

  test('paragraph wrappers carry markdown="1" except label and note', () => {
    const html = enableMarkdownInWrappers('<div class="stt-pr stt-pr-tap"><div class="stt-pr-note">n</div><div class="stt-pr-pair"><div class="stt-pr-src"><div class="stt-pr-label">원문 1</div>\n\nx\n\n</div></div><details class="stt-pr-orig"><summary>s</summary></details></div><div class="other">');
    expect(html).toContain('<div class="stt-pr stt-pr-tap" markdown="1">');
    expect(html).toContain('<div class="stt-pr-src" markdown="1">');
    expect(html).toContain('<details class="stt-pr-orig" markdown="1">');
    expect(html).toContain('<div class="stt-pr-label">');
    expect(html).toContain('<div class="stt-pr-note">');
    expect(html).toContain('<div class="other">');
  });

  test("paragraph view Markdown is parsed by ST's showdown configuration", async () => {
    const showdown = createRequire(import.meta.url)('showdown');
    // Same options as reloadMarkdownProcessor() in SillyTavern public/script.js.
    const conv = new showdown.Converter({ emoji: true, literalMidWordUnderscores: true, parseImgDimensions: true, tables: true, underline: true, simpleLineBreaks: true, strikethrough: true, disableForced4SpacesIndentedSublists: true });
    const { m } = await translated('*Hello* there.');
    m.extra.st_translator.entries[sourceHash('*Hello* there.')].parts = ['*안녕* 하세요.'];
    const settings = withMode('paragraph');
    const text = computeDisplayText(m, settings, DEFAULT_VIEW)!;
    const html = conv.makeHtml(text);
    expect(html).toContain('<em>Hello</em>');
    expect(html).toContain('<em>안녕</em>');
    // without the attribute the Markdown stays literal
    expect(conv.makeHtml(text.replaceAll(' markdown="1"', ''))).toContain('*Hello*');
  });
});

describe('applyDisplay ownership', () => {
  test('writes display_text, ownership hash and the swipe mirror', async () => {
    const { m } = await translated('Hello there.', { swipes: ['Hello there.'], swipe_id: 0, swipe_info: [{}] });
    saveSettings(withMode('only'), true);
    expect(recompute(m, 0)).toBe(true);
    expect(m.extra.display_text).toBe('안녕하세요.');
    expect(m.swipe_info[0].extra.display_text).toBe('안녕하세요.');
    expect(readTranslations(m)!.display).toBe(sourceHash('안녕하세요.'));
    expect(m.swipe_info[0].extra.st_translator.display).toBe(sourceHash('안녕하세요.'));
    // unchanged: no rewrite
    expect(recompute(m, 0)).toBe(false);
  });

  test('a foreign display_text is untouched when we have nothing to show', () => {
    const m: any = msg('Hi', { extra: { display_text: '안녕 (ST 번역)' } });
    installFake({ chatId: 'c', chat: [m] });
    expect(recompute(m, 0)).toBe(false);
    expect(m.extra.display_text).toBe('안녕 (ST 번역)');
    expect(applyDisplay(m, 0, null)).toBe(false);
  });

  test('a foreign display_text is replaced when we have a record to show', async () => {
    const { m } = await translated();
    m.extra.display_text = '다른 번역';
    saveSettings(withMode('only'), true);
    recompute(m, 0);
    expect(m.extra.display_text).toBe('안녕하세요.');
  });

  test('owned stale text is deleted after an edit', async () => {
    const { m } = await translated();
    saveSettings(withMode('only'), true);
    recompute(m, 0);
    expect(m.extra.display_text).toBe('안녕하세요.');
    m.mes = 'Something else entirely.';
    expect(recompute(m, 0)).toBe(true);
    expect(m.extra.display_text).toBeUndefined();
    expect(readTranslations(m)!.display).toBeUndefined();
  });

  test('hiding the translation removes our text; ST toggle removal drops stale ownership', async () => {
    const { m } = await translated();
    saveSettings(withMode('only'), true);
    recompute(m, 0);
    setHidden(m, true);
    recompute(m, 0);
    expect(m.extra.display_text).toBeUndefined();
    setHidden(m, false);
    recompute(m, 0);
    expect(m.extra.display_text).toBe('안녕하세요.');
    // built-in translate button toggles back to the original by deleting display_text
    delete m.extra.display_text;
    applyDisplay(m, 0, null);
    expect(readTranslations(m)!.display).toBeUndefined();
    expect(m.extra.display_text).toBeUndefined();
  });

  test('settings change rewrites display_text for the open chat message', async () => {
    const { m } = await translated();
    saveSettings(withMode('only'), true);
    recompute(m, 0);
    saveSettings(withMode('below'), true);
    recompute(m, 0);
    expect(m.extra.display_text).toBe('Hello there.\n\n<hr class="stt-separator">\n\n안녕하세요.');
    expect(getStore().defaults.displayMode).toBe('below');
  });

  test('writeTranslations keeps the ownership field', async () => {
    const { m } = await translated();
    saveSettings(withMode('only'), true);
    recompute(m, 0);
    writeTranslations(m, (mt) => { mt.hidden = false; });
    expect(readTranslations(m)!.display).toBe(sourceHash('안녕하세요.'));
  });
});
