// Markdown turns a line indented by 4+ spaces (or a tab) into a code block when it follows a blank line
// (or opens the text). Source messages often use such indentation on lines that continue a shorter-indented
// line before them, so they are fine in the source; in a translation a blank line (or a dropped header line)
// can land in front of them and the text then shows up as a boxed code block. Fenced code is left alone.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Caps the indentation of a non-blank line that follows a blank line (or starts the text) at 3 spaces. Fenced code is untouched. */
export function softenIndentedCode(text: string): string {
  if (!/(^|\n)[ \t]{4}|(^|\n)[ ]{0,3}\t/.test(text)) return text;
  const lines = text.split('\n');
  let fence: { char: string; length: number } | null = null;
  let afterBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const bare = line.replace(/\r$/, '');
    const marker = FENCE.exec(bare);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && bare.trim() === marker[1]) fence = null;
      afterBlank = false;
      continue;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      afterBlank = false;
      continue;
    }
    if (!bare.trim()) {
      afterBlank = true;
      continue;
    }
    if (afterBlank) {
      const lead = /^[ \t]*/.exec(line)![0];
      if (lead.replace(/\t/g, '    ').length >= 4) lines[i] = `   ${line.slice(lead.length)}`;
    }
    afterBlank = false;
  }
  return lines.join('\n');
}
