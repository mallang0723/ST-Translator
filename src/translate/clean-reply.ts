// Prompt wrappers sometimes get echoed by the model. Strip only boundary headers,
// before joining replies or restoring protected text; interior literals must survive.
// Leave whitespace alone when there is no wrapper (continuations may need it).
export function cleanReply(text: string): string {
  return text
    .replace(/^(?:\s*\[\s*(?:Text to Translate|Previous Context\s*—\s*Reference Only)\s*\]\s*)+/i, '')
    .replace(/(?:\s*\[\s*(?:End Text|Previous Context\s*—\s*Reference Only)\s*\]\s*)+$/i, '');
}
