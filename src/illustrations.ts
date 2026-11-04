// LV-Illust's core.mjs renders these three states for each <pic> occurrence.
// Keep this independent of translation settings: illustration details are never prose.
const MALFORMED_ANNOTATION = '⟦삽화가: 그림 태그 형식 오류 — 고치면 다시 시도됩니다⟧';
const START = /<pic(?=[\s/>]|$)|<pic⟦삽화가:|!\[그림:|\[⚠️ 그림 생성 실패\(|\[한 답변당 그림 상한\(|<pic-(?:failed|skipped)\b/g;
const TAG = /^<pic(?:⟦삽화가: 그림 태그 형식 오류 — 고치면 다시 시도됩니다⟧)?(?=[\s/>]|$)(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/;
const STATUS = /^\[(?:⚠️ 그림 생성 실패\(|한 답변당 그림 상한\()[\s\S]*?<pic-(?:failed|skipped) id="[a-z0-9]+">\]/;
const SENTINEL = /^<pic-(?:failed|skipped)\s+id="[a-z0-9]+"\s*\/?>/;

/** End of LV-Illust image Markdown, including balanced/escaped URL parentheses. */
function imageLength(text: string): number {
  const alt = /^!\[그림:[^\]\n]*\]\(/.exec(text);
  if (!alt) return 0;
  let depth = 1;
  for (let i = alt[0].length; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return 0;
}

/** Replace complete illustration occurrences in document order, preserving all other text. */
export function replaceIllustrations(text: string, replace: (markup: string, index: number) => string): string {
  const scan = new RegExp(START);
  let out = '', cursor = 0, count = 0;
  for (let match; (match = scan.exec(text));) {
    const start = match.index;
    const rest = text.slice(start);
    let length = 0;
    if (rest.startsWith('![')) length = imageLength(rest);
    else if (rest.startsWith('[')) length = STATUS.exec(rest)?.[0].length ?? 0;
    else if (rest.startsWith('<pic-')) length = SENTINEL.exec(rest)?.[0].length ?? 0;
    else {
      length = TAG.exec(rest)?.[0].length ?? 0;
      if (!length) {
        // The companion only inserts an annotation after a broken <pic opener.
        // Protect its malformed line too, without consuming a later valid tag.
        const offset = rest.startsWith(`<pic${MALFORMED_ANNOTATION}`) ? 4 + MALFORMED_ANNOTATION.length : 4;
        const stop = /[<>\r\n]/.exec(rest.slice(offset));
        length = stop ? offset + stop.index + (stop[0] === '>' ? 1 : 0) : rest.length;
      }
    }
    if (!length) continue;
    // Accept self-closing and explicitly closed forms as well as the companion's
    // bare opener. It may replace only the opener, leaving </pic> after an image.
    length += /^\s*<\/pic\s*>/.exec(rest.slice(length))?.[0].length ?? 0;
    out += text.slice(cursor, start) + replace(text.slice(start, start + length), count++);
    cursor = start + length;
    scan.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/** A key depends on prose and illustration positions/count, never prompt/URL/status. */
export function normalizeIllustrations(text: string): string {
  return replaceIllustrations(text, (_markup, index) => `⟪lv-illustration:${index + 1}⟫`);
}

/** Apply current illustrations across one or more translated parts, in order. */
export function currentIllustrations(content: string) {
  const pieces: string[] = [];
  replaceIllustrations(content, (piece) => { pieces.push(piece); return piece; });
  let index = 0;
  return {
    replace(text: string): string { return replaceIllustrations(text, () => pieces[index++] ?? ''); },
    remaining(): string { return pieces.slice(index).join('\n\n'); },
  };
}

export function restoreCurrentIllustrations(translated: string, content: string): string {
  const current = currentIllustrations(content);
  const text = current.replace(translated);
  const rest = current.remaining();
  return rest ? `${text}\n\n${rest}` : text;
}
