import { describe, expect, test } from 'bun:test';
import { joinContinuation, splitForTranslation } from '../src/translate/chunk';
import { checkMarkers, ExcludeRuleError, markersIn, parseExcludeRules, protect, restore } from '../src/translate/protect';

const opts = { protectHtml: true, protectCode: true, excludeRules: '' };

describe('protect / restore', () => {
  test('HTML tags and attributes are kept; text between tags is translatable', () => {
    const src = '<div class="box" data-x=\'a>b\'>Hello <b>world</b><br/>bye</div>';
    const p = protect(src, opts);
    expect(p.text).toBe('⟦1⟧Hello ⟦2⟧world⟦3⟧⟦4⟧bye⟦5⟧');
    expect(restore(p.text, p.pieces)).toBe(src);
    expect(restore('⟦1⟧안녕 ⟦2⟧세상⟦3⟧⟦4⟧잘가⟦5⟧', p.pieces)).toBe('<div class="box" data-x=\'a>b\'>안녕 <b>세상</b><br/>잘가</div>');
  });

  test('<style>, <script>, comments, code blocks and macros stay whole', () => {
    const src = 'A <style>.x{color:red}</style> B <script>alert("hi")</script> <!-- note --> ```js\nlet a = "t";\n``` {{char}} C';
    const p = protect(src, opts);
    expect(p.text).toBe('A ⟦2⟧ B ⟦3⟧ ⟦4⟧ ⟦1⟧ ⟦5⟧ C');
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('exclude rules: tag element, regex, start ... end', () => {
    const src = 'Story.\n<status hp="3">HP: 3\n<b>Mood</b></status>\n[STAT] a | b [/STAT] Next. Coins: 42g';
    const p = protect(src, { ...opts, excludeRules: '<status>\n[STAT] ... [/STAT]\n/Coins: \\d+g/' });
    expect(p.text).toBe('Story.\n⟦1⟧\n⟦2⟧ Next. ⟦3⟧');
    expect(p.pieces[0]).toBe('<status hp="3">HP: 3\n<b>Mood</b></status>');
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('protection can be turned off', () => {
    const src = '<b>x</b> ```y```';
    expect(protect(src, { protectHtml: false, protectCode: false, excludeRules: '' }).text).toBe(src);
  });

  test('a literal ⟦n⟧ in the source survives, even inside an excluded part', () => {
    const src = 'see ⟦5⟧ and <status>keep ⟦7⟧</status>';
    const p = protect(src, opts);
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('invalid exclude rules are reported', () => {
    expect(() => parseExcludeRules('/(/')).toThrow(ExcludeRuleError);
    expect(() => parseExcludeRules('/a*/')).toThrow(ExcludeRuleError);
    expect(() => parseExcludeRules('what')).toThrow(ExcludeRuleError);
    expect(parseExcludeRules('# comment\n\n<status>')).toHaveLength(1);
  });

  test('marker check finds missing, extra and duplicated markers', () => {
    expect(checkMarkers('a ⟦1⟧ b ⟦2⟧', 'x ⟦2⟧ y ⟦1⟧')).toBeNull();
    expect(checkMarkers('a ⟦1⟧ b ⟦2⟧', 'x ⟦1⟧')).toContain('빠짐 ⟦2⟧');
    expect(checkMarkers('a ⟦1⟧', 'x ⟦1⟧ ⟦1⟧')).toContain('중복');
    expect(checkMarkers('a ⟦1⟧', 'x ⟦1⟧ ⟦9⟧')).toContain('없던 표시');
    expect(markersIn('⟦ 3 ⟧x⟦4⟧')).toEqual([3, 4]);
  });
});

describe('split / join', () => {
  test('long text is split on paragraphs and stays complete', () => {
    const para = (n: number) => `Paragraph ${n} ` + 'word '.repeat(150);
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = splitForTranslation(text, 3200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 3200)).toBe(true);
    expect(chunks.join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' ').trim());
  });

  test('a hard cut never splits a marker', () => {
    const text = 'a'.repeat(3198) + '⟦12⟧' + 'b'.repeat(100);
    const chunks = splitForTranslation(text, 3200);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((c) => !/⟦\d*$/.test(c) && !/^\d*⟧/.test(c))).toBe(true);
    expect(chunks.every((c) => c.length <= 3200)).toBe(true);
  });

  test('short paragraphs are packed together; blank and \\r\\n input is normalized', () => {
    expect(splitForTranslation('aaa\r\n\r\nbbb\n\n\n\n  \n\nccc', 20)).toEqual(['aaa\n\nbbb\n\nccc']);
    expect(splitForTranslation('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc']);
    expect(splitForTranslation('one line\ntwo line', 50)).toEqual(['one line\ntwo line']);
    expect(splitForTranslation('  \n\n \n', 10)).toEqual([]);
  });

  test('an overlong paragraph is cut after sentence ends', () => {
    const sentence = (n: number) => `Sentence number ${n} walks along the quiet harbour road.`;
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
    const chunks = splitForTranslation(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500 && c.endsWith('.'))).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });

  test('CJK sentence ends and line breaks are cut points', () => {
    const text = '静かな港町を歩いた。'.repeat(30);
    const chunks = splitForTranslation(text, 45);
    expect(chunks.every((c) => c.length <= 45 && c.endsWith('。'))).toBe(true);
    expect(chunks.join('')).toBe(text);
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i} without a full stop`).join('\n');
    const byLine = splitForTranslation(lines, 70);
    expect(byLine.every((c) => c.length <= 70 && !c.startsWith('\n') && !c.endsWith(' '))).toBe(true);
    expect(byLine.join('\n')).toBe(lines);
  });

  test('without sentence ends it cuts at spaces, and mid-word only as a last resort', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const chunks = splitForTranslation(words, 40);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.join(' ')).toBe(words);
    const solid = 'x'.repeat(95);
    expect(splitForTranslation(solid, 40)).toEqual(['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(15)]);
  });

  test('a space exactly at the limit is used as the cut', () => {
    expect(splitForTranslation('abcde fghij', 5)).toEqual(['abcde', 'fghij']);
  });

  test('continuations join without repeats or broken words', () => {
    expect(joinContinuation('그녀는 문을 열', '었다. 바람이 불었다.')).toBe('그녀는 문을 열었다. 바람이 불었다.');
    expect(joinContinuation('그녀는 문을 열었다.', '바람이 불었다.')).toBe('그녀는 문을 열었다. 바람이 불었다.');
    expect(joinContinuation('그녀는 문을 열었다. 바람이', '열었다. 바람이 불었다.')).toBe('그녀는 문을 열었다. 바람이 불었다.');
    expect(joinContinuation('끝.', '   ')).toBe('끝.');
  });
});
