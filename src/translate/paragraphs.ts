// Paragraph handling from Paragraph Reader 0.2.0.

/** Blank-line paragraphs; blank lines inside fenced code stay in one block. */
export function splitParagraphs(text: string): string[] {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let pending: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    const value = pending.join('\n').trim();
    if (value) blocks.push(value);
    pending = [];
  };
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) {
        flush();
        fence = { char: marker[1]![0]!, length: marker[1]!.length };
      } else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.trim() === marker[1]) {
        pending.push(line);
        fence = null;
        flush();
        continue;
      }
    }
    if (!line.trim() && !fence) flush();
    else pending.push(line);
  }
  flush();
  return blocks;
}

// Real HTML tag names do not count as text; <Status Window>-style bracket phrases do.
const HTML_TAG =
  /<\/?(?:div|span|p|br|hr|b|strong|i|em|u|s|small|sub|sup|mark|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|blockquote|pre|code|figure|figcaption|details|summary|img|a|center|font|section|article|header|footer|main|aside|nav|del|svg|g|path|circle|ellipse|line|polyline|polygon|rect|text|tspan|defs|style)(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*\s*\/?>/g;

/**
 * True when a paragraph has no letters or digits (separators such as ---, * * *, ═══,
 * markup only, protected ⟦n⟧ markers only). Such paragraphs are not sent to the model:
 * on their own it would answer "nothing to translate" instead.
 */
export function hasNoText(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(String(text).replace(/⟦\s*\d+\s*⟧/g, '').replace(HTML_TAG, ''));
}

const BLOCK = 'div|svg|table|ul|ol|details|blockquote|figure|pre|section|article|header|footer|main|aside|nav';
const OPEN = new RegExp(`<(?:${BLOCK})(?:\\s[^<>]*)?>`, 'gi');
const CLOSE = new RegExp(`<\\/(?:${BLOCK})\\s*>`, 'gi');

/** Open minus closed block-level HTML tags. */
export function blockDepth(text: string): number {
  const opens = (text.match(OPEN) || []).filter((t) => !t.endsWith('/>')).length;
  const closes = (text.match(CLOSE) || []).length;
  return opens - closes;
}

/**
 * Groups consecutive paragraph indices whose HTML spans several paragraphs
 * (an opening <div> in one paragraph and its </div> in a later one).
 */
export function htmlGroups(sources: string[]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < sources.length; ) {
    const group: number[] = [];
    let open = 0;
    let j = i;
    do {
      group.push(j);
      open += blockDepth(sources[j]!);
      j++;
    } while (open > 0 && j < sources.length);
    groups.push(group);
    i = j;
  }
  return groups;
}
