// Splitting long sources and joining continued translations.

export const TRANSLATION_CHUNK_CHARS = 3200;

/** Positions just after a sentence end: Latin punctuation followed by a space, or CJK punctuation. */
const SENTENCE_BREAK = /[.!?…]+["'”’」』)\]]*(?=\s)|[。！？]+["'”’」』)\]]*/g;

/**
 * Where to end a piece that starts at `from` and may be at most `limit` characters long.
 * Prefers the last line break or sentence end, then the last space, and only then cuts
 * mid-word. The returned position never falls inside a ⟦n⟧ marker.
 */
function findCut(text: string, from: number, limit: number): number {
  const end = from + limit;
  const span = text.slice(from, end + 1); // one extra character: a space right at the limit is a fine cut
  let best = -1;
  for (const m of span.matchAll(SENTENCE_BREAK)) {
    const at = m.index! + m[0].length;
    if (at <= limit) best = Math.max(best, at);
  }
  const newline = span.lastIndexOf('\n', limit);
  if (newline > 0) best = Math.max(best, newline);
  if (best <= 0) {
    for (let i = Math.min(limit, span.length - 1); i > 0; i--) {
      if (/\s/.test(span[i]!)) {
        best = i;
        break;
      }
    }
  }
  let cut = best > 0 ? from + best : end;
  // Step back to the start of a marker the cut would split; step past it if it is the whole piece.
  const open = text.lastIndexOf('⟦', cut - 1);
  if (open >= from) {
    const close = text.indexOf('⟧', open);
    if (close >= cut) cut = open > from ? open : close + 1;
  }
  return cut;
}

/** Cuts one paragraph that is longer than `limit` into pieces of at most `limit` characters. */
function cutParagraph(paragraph: string, limit: number): string[] {
  const pieces: string[] = [];
  let from = 0;
  while (paragraph.length - from > limit) {
    const cut = findCut(paragraph, from, limit);
    pieces.push(paragraph.slice(from, cut));
    from = cut;
    // Whitespace at a cut would be trimmed anyway; skipping it keeps the next piece within the limit.
    while (from < paragraph.length && /\s/.test(paragraph[from]!)) from++;
  }
  pieces.push(paragraph.slice(from));
  return pieces;
}

/**
 * Splits a long source into parts that are translated one request each. Paragraphs (blank-line
 * separated) are packed together up to `limit` characters per part; a paragraph longer than that
 * is cut at line breaks, sentence ends or spaces. Each part is trimmed, and paragraphs inside a
 * part are joined with a blank line.
 */
export function splitForTranslation(text: string, limit = TRANSLATION_CHUNK_CHARS): string[] {
  const max = Math.max(1, Math.floor(limit));
  const pieces = String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .flatMap((paragraph) => (paragraph.length > max ? cutParagraph(paragraph, max) : [paragraph]));
  const parts: string[] = [];
  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    const last = parts.length - 1;
    if (last >= 0 && parts[last]!.length + 2 + piece.length <= max) parts[last] += `\n\n${piece}`;
    else parts.push(piece);
  }
  return parts;
}

const SENTENCE_END = /[.!?。！？…"”’'」』)\]]$/;

/** Joins a translation that stopped early with its continuation. */
export function joinContinuation(partial: string, continuation: string): string {
  let cont = continuation.replace(/^\s*\n/, '\n');
  if (!cont.trim()) return partial;
  // Drop a repeated tail (the model restating the last words it already wrote).
  const tail = partial.slice(-200);
  for (let k = Math.min(tail.length, cont.length); k >= 8; k--) {
    if (tail.endsWith(cont.slice(0, k))) {
      cont = cont.slice(k);
      break;
    }
  }
  if (!cont.trim()) return partial;
  if (/\s$/.test(partial) || /^\s/.test(cont)) return partial + cont;
  // A sentence ended right at the cut: separate with a space. Otherwise the cut was mid-word.
  return SENTENCE_END.test(partial) ? `${partial} ${cont}` : partial + cont;
}

/** Whether a provider finish reason means the output limit cut the text. */
export function isTruncatedFinish(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  const r = reason.toLowerCase();
  return r === 'length' || r.includes('max_tokens') || r.includes('max_output') || r === 'max_tokens';
}
