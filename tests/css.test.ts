import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// ST's message sanitizer rewrites every class in message HTML to `custom-<class>` (scripts/chats.js,
// DOMPurify uponSanitizeAttribute), so message-content selectors must match both spellings.
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const sources = ['../src/display/render.ts', '../src/display/paragraph-view.ts'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');

describe('style.css message content', () => {
  const classes = [...new Set([...sources.matchAll(/\b(stt-(?:pr|separator|translation)[a-z-]*)\b/g)].map((m) => m[1]!))];

  test('finds the emitted classes', () => {
    expect(classes).toEqual(expect.arrayContaining(['stt-pr', 'stt-pr-src', 'stt-pr-tgt', 'stt-separator', 'stt-translation', 'stt-pr-orig']));
  });

  test.each(classes)('%s is styled in both spellings', (cls) => {
    expect(css).toContain(`.custom-${cls}`);
    expect(css).toContain(`:is(.${cls}, .custom-${cls})`);
  });

  test('no bare message-content selector is left', () => {
    for (const cls of classes) {
      for (const m of css.matchAll(new RegExp(`\\.${cls}(?![\\w-])`, 'g'))) {
        expect(css.slice(m.index! - 4, m.index!)).toBe(':is(');
      }
    }
  });
});
