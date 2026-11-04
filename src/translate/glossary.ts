// Shared glossary parser, extracted from prompt.ts (Translation Tools 1.5.4 port).
// See THIRD_PARTY_NOTICES.md for the upstream MIT notice.
export function parseGlossary(raw: string): Array<{ left: string; right: string }> {
  const pairs: Array<{ left: string; right: string }> = [];
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const left = line.slice(0, separator).trim();
    const right = line.slice(separator + 1).trim();
    if (left && right) pairs.push({ left, right });
  }
  return pairs;
}
