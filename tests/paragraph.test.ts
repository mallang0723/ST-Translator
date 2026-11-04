import { describe, expect, test } from 'bun:test';
import { buildParagraphView, groupPairs, pairParagraphs, PENDING_TEXT } from '../src/display/paragraph-view';
import { promptPresets } from '../src/presets';
import { DEFAULT_SETTINGS, type ChatSettings, type TranslationRecord } from '../src/shared';
import { type Completion, requestsNeeded, translate } from '../src/translate/engine';
import { blockDepth, hasNoText, htmlGroups, splitParagraphs } from '../src/translate/paragraphs';
import type { TranslationRequest } from '../src/translate/prompt';

const settings = (over: Partial<ChatSettings> = {}): ChatSettings => ({ ...DEFAULT_SETTINGS, ...over });

function target(req: TranslationRequest): string {
  const m = /\[Text to Translate\]\n([\s\S]*)\n\[End Text\]/.exec(req.user);
  return m ? m[1]! : req.user.replace(/^Translate the following text to [^:]+:\n\n/, '');
}
function model() {
  const calls: string[] = [];
  return {
    calls,
    async complete(req: TranslationRequest): Promise<Completion> {
      const t = target(req);
      calls.push(t);
      return { text: t.split('\n').map((l) => (l.trim() ? `[KO]${l}` : l)).join('\n'), finishReason: 'stop' };
    },
  };
}
const run = (source: string, s: ChatSettings, m = model(), resume?: TranslationRecord) =>
  translate({ direction: 'incoming', source, settings: s, presets: promptPresets([]), previous: [], resume }, m);

const STORY = [
  '"For fuck\'s sake, Langley, just ask them on a date," Cillian said.',
  '* * *',
  '"A date? With them?" Irving almost choked.',
  '<status>HP: 3</status>',
  '```\ncode\n\nmore code\n```',
].join('\n\n');

describe('paragraph helpers (Paragraph Reader 0.2.0)', () => {
  test('blank lines split paragraphs except inside fenced code', () => {
    expect(splitParagraphs(STORY)).toHaveLength(5);
    expect(splitParagraphs(STORY)[4]).toBe('```\ncode\n\nmore code\n```');
  });

  test('separators, markup and markers have no text; bracket phrases do', () => {
    for (const t of ['* * *', '---', '═══', '<hr>', '<div class="x"></div>', '⟦3⟧', '⟦1⟧ ⟦2⟧']) expect(hasNoText(t)).toBe(true);
    for (const t of ['<Status Window>', 'a', '3', '<b>hi</b>']) expect(hasNoText(t)).toBe(false);
  });

  test('HTML spanning paragraphs is grouped', () => {
    const sources = ['<div class="card">', 'Hello', '</div>', 'After'];
    expect(blockDepth(sources[0]!)).toBe(1);
    expect(htmlGroups(sources)).toEqual([[0, 1, 2], [3]]);
  });
});

describe('paragraph unit translation', () => {
  test('one request per paragraph with text; separators and protected parts are kept without a request', async () => {
    const m = model();
    const s = settings({ translationUnit: 'paragraph', excludeRules: '<status>' });
    expect(requestsNeeded(STORY, s, null)).toBe(2);
    const r = await run(STORY, s, m);
    expect(m.calls).toEqual([splitParagraphs(STORY)[0]!, splitParagraphs(STORY)[2]!]);
    expect(r.unit).toBe('paragraph');
    expect(r.total).toBe(5);
    expect(r.status).toBe('done');
    expect(requestsNeeded(STORY, s, r)).toBe(0);
  });

  test('pairs follow the paragraphs exactly', async () => {
    const s = settings({ translationUnit: 'paragraph', excludeRules: '<status>' });
    const r = await run(STORY, s);
    const pairing = pairParagraphs(STORY, r, s);
    expect(pairing.kind).toBe('paragraph');
    expect(pairing.pairs.map((p) => p.source)).toEqual(splitParagraphs(STORY));
    expect(pairing.pairs[0]!.translation).toBe(`[KO]${splitParagraphs(STORY)[0]}`);
    expect(pairing.pairs[1]!.translation).toBe('* * *');
    expect(pairing.pairs[3]!.translation).toBe('<status>HP: 3</status>');
  });

  test('an unfinished paragraph translation shows the rest as pending and counts remaining requests', async () => {
    const s = settings({ translationUnit: 'paragraph' });
    const full = await run('One.\n\nTwo.\n\nThree.', s);
    const partial: TranslationRecord = { ...full, parts: full.parts.slice(0, 1), status: 'partial' };
    expect(requestsNeeded('One.\n\nTwo.\n\nThree.', s, partial)).toBe(2);
    const html = buildParagraphView('One.\n\nTwo.\n\nThree.', partial, s, 'interleave');
    expect(html.split(PENDING_TEXT)).toHaveLength(3);
  });
});

describe('whole-message translation shown as paragraphs', () => {
  test('same paragraph count: matched pairs', async () => {
    const s = settings();
    const r = await run('One.\n\nTwo.', s);
    const p = pairParagraphs('One.\n\nTwo.', r, s);
    expect(p.kind).toBe('matched');
    expect(p.pairs).toEqual([{ source: 'One.', translation: '[KO]One.' }, { source: 'Two.', translation: '[KO]Two.' }]);
  });

  test('different paragraph count: one whole pair with a note', () => {
    const r: TranslationRecord = { parts: ['하나. 둘.'], pieces: [], total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 };
    const p = pairParagraphs('One.\n\nTwo.', r, settings());
    expect(p.kind).toBe('whole');
    expect(buildParagraphView('One.\n\nTwo.', r, settings(), 'interleave')).toContain('원문 전체');
  });
});

describe('view HTML', () => {
  const r: TranslationRecord = { parts: ['[KO]A.', '* * *', '[KO]B.'], pieces: [], unit: 'paragraph', total: 3, truncatedPart: -1, status: 'done', updatedAt: 1 };
  const src = 'A.\n\n* * *\n\nB.';
  const s = settings({ translationUnit: 'paragraph' });

  test('interleave: labelled original and translation, Markdown kept between blank lines', () => {
    const html = buildParagraphView(src, r, s, 'interleave');
    expect(html).toContain('<div class="stt-pr-src"><div class="stt-pr-label">원문 1</div>\n\nA.\n\n</div>');
    expect(html).toContain('<div class="stt-pr-tgt"><div class="stt-pr-label">번역 1</div>\n\n[KO]A.\n\n</div>');
    // the separator is shown once and numbering continues
    expect(html).toContain('<div class="stt-pr-pair stt-pr-same">\n\n* * *\n\n</div>');
    expect(html).toContain('번역 2');
    expect(html).not.toContain('번역 3');
  });

  test('tap: translation first, original in a disclosure', () => {
    const html = buildParagraphView(src, r, s, 'tap');
    expect(html.startsWith('<div class="stt-pr stt-pr-tap">')).toBe(true);
    expect(html).toContain('<details class="stt-pr-orig"><summary>원문 1 · 눌러서 원문 열기 / 닫기</summary>\n\nA.\n\n</details>');
  });

  test('HTML that spans paragraphs is rendered as one pair', () => {
    const pairs = groupPairs([
      { source: '<div class="c">', translation: '<div class="c">' },
      { source: 'Hi', translation: '안녕' },
      { source: '</div>', translation: '</div>' },
    ]);
    expect(pairs).toEqual([{ source: '<div class="c">\n\nHi\n\n</div>', translation: '<div class="c">\n\n안녕\n\n</div>' }]);
  });
});
