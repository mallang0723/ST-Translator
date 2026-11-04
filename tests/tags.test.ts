import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared';
import { ExcludeRuleError, lenientTags, parseTags, protect, restore } from '../src/translate/protect';

const base = { protectHtml: true, protectCode: true, excludeRules: '' };
const withTags = (excludeTags: string) => ({ ...base, excludeTags });

describe('excluded tag list', () => {
  test('parseTags accepts names, <tag>, </tag>, <tag/>; lowercases and de-duplicates', () => {
    expect(parseTags('Choices, <status>  </ui> <br/> choices')).toEqual(['choices', 'status', 'ui', 'br']);
    expect(parseTags('')).toEqual([]);
    expect(() => parseTags('ok, 1bad')).toThrow(ExcludeRuleError);
    expect(() => parseTags('a.b')).toThrow(ExcludeRuleError);
    expect(lenientTags('ok, 1bad, fine')).toEqual(['ok', 'fine']);
  });

  test('the whole element is replaced by one placeholder and restored verbatim', () => {
    const src = 'Hi <choices a="1">\n1. Go\n2. <b>Stay</b>\n</choices> bye';
    const p = protect(src, withTags('choices'));
    expect(p.text).toBe('Hi ⟦1⟧ bye');
    expect(p.pieces[0]).toBe('<choices a="1">\n1. Go\n2. <b>Stay</b>\n</choices>');
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('same-name nesting is counted', () => {
    const src = '<card>a<card>b</card>c</card> tail';
    const p = protect(src, withTags('card'));
    expect(p.text).toBe('⟦1⟧ tail');
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('an element that is never closed runs to the end', () => {
    const p = protect('Hello <choices>1. a\n2. b', withTags('choices'));
    expect(p.text).toBe('Hello ⟦1⟧');
  });

  test('void and self-closing tags are not ranges; other markup is still a marker', () => {
    const p = protect('a<br>b <choices/> c', withTags('br, choices'));
    expect(p.text).toBe('a⟦1⟧b ⟦2⟧ c');
    expect(restore(p.text, p.pieces)).toBe('a<br>b <choices/> c');
  });

  test('emphasis is kept: listing strong/em does not hide the words inside', () => {
    const p = protect('so <strong>very</strong> <em>good</em>', withTags('strong, em'));
    expect(p.text).toBe('so ⟦1⟧very⟦2⟧ ⟦3⟧good⟦4⟧');
  });

  test('tags inside code fences and comments do not start an element', () => {
    const src = '```\n<choices>\n```\nText <!-- <choices> --> end';
    const p = protect(src, withTags('choices'));
    expect(p.text).toBe('⟦1⟧\nText ⟦2⟧ end');
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('style and script are protected even with HTML protection off and no list', () => {
    const src = 'a <style>.x{}</style> b <script>go()</script> c <i>d</i>';
    const p = protect(src, { protectHtml: false, protectCode: false, excludeRules: '' });
    expect(p.text).toBe('a ⟦1⟧ b ⟦2⟧ c <i>d</i>');
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('a literal ⟦n⟧ inside an excluded element survives', () => {
    const src = '<choices>⟦7⟧ x</choices> ⟦1⟧';
    const p = protect(src, withTags('choices'));
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('stored settings are normalized; a bad name is dropped, not fatal', () => {
    expect(DEFAULT_SETTINGS.excludeTags).toBe('');
    expect(normalizeSettings({ excludeTags: 'Choices <status> 9x' }).excludeTags).toBe('choices, status');
    expect(normalizeSettings({}).excludeTags).toBe('');
  });
});
