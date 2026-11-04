// Protects the parts of a message that must not be translated by swapping them for
// ⟦n⟧ markers before translation and putting them back afterwards.
//
// Protected, in this order:
//   1. user exclude rules (<tag> elements, /regex/, "start ... end" ranges)
//   1b. elements named in the excluded tag list (excludeTags), nested tags counted
//       (plus <autopic> when the autopic option is on, whatever the list says)
//   2. fenced code blocks                      (protectCode)
//   3. <style>/<script> elements (always)
//   3a. LoreVeil tags and markers (loreveil option, my outgoing messages only)
//   3b. LV-Illust tags, image Markdown and status markers (always)
//   4. HTML comments and tags, attributes and all (protectHtml) — inner text stays translatable
//   5. {{macros}}

import { replaceIllustrations } from '../illustrations';

export interface ProtectOptions {
  protectHtml: boolean;
  protectCode: boolean;
  excludeRules: string;
  /** Tag names whose whole element (tags and contents) is kept verbatim. Comma / space separated. */
  excludeTags?: string;
  /** Hold <autopic> elements whole, as if they were in excludeTags. */
  autopic?: boolean;
  /** Hold LoreVeil tags and markers. null / undefined = off. */
  loreveil?: LoreVeilConfig | null;
}

/** Tags and forms LoreVeil is configured with (extensionSettings.loreVeil). */
export interface LoreVeilConfig {
  tags: string[];
  /** `<div tag>` form: the opening tag is held. */
  attribute: boolean;
}

export const LOREVEIL_DEFAULT_TAG = 'st-loreveil';

export interface Protected {
  text: string;
  pieces: string[];
  /** Whole-element excluded blocks and fenced code blocks that are still top-level in `text`, in order of appearance. */
  blocks: string[];
  /** Marker numbers of `blocks` (same order), so a held block can be dropped by position rather than by text. */
  blockMarkers: number[];
  /** Marker numbers of the LoreVeil pieces that are still top-level in `text`; their relative order must survive translation. */
  ordered: number[];
}

export class ExcludeRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExcludeRuleError';
  }
}

const MARKER = /⟦\s*(\d+)\s*⟧/g;

export const MARKER_INSTRUCTION =
  'The text contains placeholder tokens such as ⟦1⟧. Each one stands for markup or content that must stay untranslated. ' +
  'Copy every token exactly as written, keep each one in the same place relative to the surrounding text, ' +
  'and never add, remove, renumber, translate or explain them.';

export const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
/** Emphasis tags are never excluded as a range: their tags stay, the words inside are still translated. */
const EMPHASIS_TAGS = new Set(['strong', 'em']);

/**
 * Tag names from a user list ("choices, status <ui>"), lowercased and de-duplicated. Accepts `<name>`,
 * `</name>` and `<name/>` spellings. Invalid names throw ExcludeRuleError.
 */
export function parseTags(raw: string): string[] {
  const names = String(raw ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^<\/?|\/?\s*>$/g, '').toLowerCase());
  const bad = names.find((n) => !/^[a-z_][a-z0-9_-]*$/.test(n));
  if (bad !== undefined) throw new ExcludeRuleError(`태그 이름 "${bad}" 를 쓸 수 없습니다. 영문, 숫자, 하이픈, 언더바만 쓸 수 있습니다.`);
  return [...new Set(names)];
}

/** Same as parseTags, but drops invalid names instead of throwing (for loading stored settings). */
export function lenientTags(raw: string): string[] {
  const out: string[] = [];
  for (const piece of String(raw ?? '').split(/[,\s]+/).filter(Boolean)) {
    try {
      out.push(...parseTags(piece));
    } catch {
      // ignored
    }
  }
  return [...new Set(out)];
}

// Comments, fenced code and inline code are skipped so tags written inside them are not matched.
const TAG_SCAN = /<!--[\s\S]*?(?:-->|$)|```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)|`[^`\n]+`|<\/?([a-z_][\w-]*)(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gi;

/**
 * Replaces every element named in `names` (opening tag through its matching closing tag, same-name
 * nesting counted; an element that is never closed runs to the end) with hold(element).
 */
export function protectElements(text: string, names: string[], hold: (piece: string) => string): string {
  const wanted = new Set(names.filter((n) => !EMPHASIS_TAGS.has(n) && !VOID_TAGS.has(n)));
  if (!wanted.size) return text;
  const matches = [...text.matchAll(TAG_SCAN)];
  let out = '';
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = m[1]?.toLowerCase();
    if (m.index! < cursor || !name || !wanted.has(name) || m[0].startsWith('</') || m[0].endsWith('/>')) continue;
    let end = text.length;
    let depth = 1;
    for (let j = i + 1; j < matches.length; j++) {
      const n = matches[j]!;
      if (n[1]?.toLowerCase() !== name) continue;
      if (n[0].startsWith('</')) depth--;
      else if (!n[0].endsWith('/>')) depth++;
      if (!depth) {
        end = n.index! + n[0].length;
        i = j;
        break;
      }
    }
    out += text.slice(cursor, m.index!) + hold(text.slice(m.index!, end));
    cursor = end;
  }
  return out + text.slice(cursor);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turns the exclude rules text into regular expressions. Invalid lines throw ExcludeRuleError. */
export function parseExcludeRules(raw: string): RegExp[] {
  const out: RegExp[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const rule = line.trim();
    if (!rule || rule.startsWith('#')) return;
    const where = `제외 규칙 ${index + 1}번째 줄`;
    const tag = /^<\s*([A-Za-z][\w:.-]*)\s*\/?>$/.exec(rule);
    if (tag) {
      const name = escapeRegExp(tag[1]!);
      out.push(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}\\s*>|<${name}(?:\\s[^>]*)?\\/>`, 'gi'));
      return;
    }
    const re = /^\/(.+)\/([a-z]*)$/s.exec(rule);
    if (re) {
      let flags = re[2]!;
      if (/[^gimsuy]/.test(flags)) throw new ExcludeRuleError(`${where}: 정규식 플래그 "${flags}" 는 쓸 수 없습니다.`);
      if (!flags.includes('g')) flags += 'g';
      try {
        const r = new RegExp(re[1]!, flags);
        if (r.test('')) throw new ExcludeRuleError(`${where}: 빈 문자열과 일치하는 정규식은 쓸 수 없습니다.`);
        r.lastIndex = 0;
        out.push(r);
      } catch (e) {
        if (e instanceof ExcludeRuleError) throw e;
        throw new ExcludeRuleError(`${where}: 정규식 오류 (${(e as Error).message})`);
      }
      return;
    }
    const range = rule.split(' ... ');
    if (range.length === 2 && range[0]!.trim() && range[1]!.trim()) {
      out.push(new RegExp(`${escapeRegExp(range[0]!.trim())}[\\s\\S]*?${escapeRegExp(range[1]!.trim())}`, 'g'));
      return;
    }
    throw new ExcludeRuleError(`${where}: "${rule}" 를 이해하지 못했습니다. <태그>, /정규식/, 시작 ... 끝 중 하나로 적어 주세요.`);
  });
  return out;
}

const LOREVEIL_SCAN =
  /```[\s\S]*?```|<!--[\s\S]*?(?:-->|$)|!--[A-Z][A-Z0-9_]*_(?:START|END)--!|<\/?([A-Za-z][\w:-]*)(?![\w:-])(?:\s|"[^"]*"|'[^']*'|[^'">\s/]|\/(?!>))*\/?>/g;
const LOREVEIL_MARKER = /!--[A-Z][A-Z0-9_]*_(?:START|END)--!/g;

function attributeNames(tag: string): string[] {
  const body = tag.replace(/^<\/?[A-Za-z][\w:-]*/, '').replace(/\/?>$/, '');
  return [...body.matchAll(/(?:^|\s)([^\s"'=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g)].map((m) => m[1]!.toLowerCase());
}

/**
 * Holds every LoreVeil opening/closing tag and marker, one piece each; the text between them stays
 * translatable. Fenced code is skipped (as protectCode treats it), tags inside HTML comments are ignored
 * (LoreVeil ignores them too) but markers inside comments count.
 */
function holdLoreVeil(text: string, config: LoreVeilConfig, hold: (piece: string) => string): string {
  const names = new Set([LOREVEIL_DEFAULT_TAG, ...config.tags.map((t) => t.toLowerCase())]);
  return text.replace(LOREVEIL_SCAN, (m: string, rawName?: string) => {
    if (m.startsWith('```')) return m;
    if (m.startsWith('<!--')) return m.replace(LOREVEIL_MARKER, (x) => hold(x));
    if (m.startsWith('!--')) return hold(m);
    const name = rawName!.toLowerCase();
    if (names.has(name)) return hold(m);
    if (config.attribute && !m.startsWith('</') && attributeNames(m).some((a) => names.has(a))) return hold(m);
    return m;
  });
}

export function protect(source: string, options: ProtectOptions): Protected {
  const pieces: string[] = [];
  // Pieces are stored fully expanded (markers inside them already put back), so restore
  // is a single pass and a literal ⟦n⟧ from the source is never expanded again.
  const hold = (piece: string) => {
    pieces.push(piece.replace(MARKER, (m, n: string) => pieces[Number(n) - 1] ?? m));
    return `⟦${pieces.length}⟧`;
  };
  // Markers already in the source would be confused with ours.
  // (Pushed as is: expanding them would turn a literal ⟦1⟧ into an earlier literal marker's text.)
  let text = source.replace(MARKER, (m) => {
    pieces.push(m);
    return `⟦${pieces.length}⟧`;
  });
  const blockIdx = new Set<number>();
  const orderedIdx = new Set<number>();
  const holdBlock = (piece: string) => {
    const marker = hold(piece);
    blockIdx.add(pieces.length);
    return marker;
  };
  for (const rule of parseExcludeRules(options.excludeRules)) text = text.replace(rule, (m) => hold(m));
  const tagNames = lenientTags(options.excludeTags ?? '');
  if (options.autopic && !tagNames.includes('autopic')) tagNames.push('autopic');
  text = protectElements(text, tagNames, holdBlock);
  if (options.protectCode) text = text.replace(/```[\s\S]*?```/g, (m) => holdBlock(m));
  // <style> and <script> are never translated, whatever the HTML setting says.
  text = text.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m) => hold(m));
  if (options.loreveil) {
    text = holdLoreVeil(text, options.loreveil, (piece) => {
      const marker = hold(piece);
      orderedIdx.add(pieces.length);
      return marker;
    });
  }
  // Always hold illustrations atomically, including failure/skip text and paired tags.
  text = replaceIllustrations(text, hold);
  if (options.protectHtml) {
    text = text.replace(/<!--[\s\S]*?-->/g, (m) => hold(m));
    // Tags: opening, closing, self-closing, with quoted attributes that may contain ">".
    text = text.replace(/<\/?[A-Za-z][\w:.-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">\s/]+|\/(?!>))*)*\s*\/?>/g, (m) => hold(m));
  }
  text = text.replace(/\{\{[\s\S]*?\}\}/g, (m) => hold(m));
  const present = markersIn(text);
  return {
    text,
    pieces,
    blocks: present.filter((n) => blockIdx.has(n)).map((n) => pieces[n - 1]!),
    blockMarkers: present.filter((n) => blockIdx.has(n)),
    ordered: present.filter((n) => orderedIdx.has(n)),
  };
}

/** Marker numbers in a text, in order of appearance. */
export function markersIn(text: string): number[] {
  return [...text.matchAll(MARKER)].map((m) => Number(m[1]));
}

/**
 * Checks that a translation kept exactly the markers of its source.
 * Returns a Korean description of the problem, or null when it is fine.
 */
export function checkMarkers(sourceText: string, translated: string, ordered: number[] = []): string | null {
  const expected = markersIn(sourceText).sort((a, b) => a - b);
  const got = markersIn(translated).sort((a, b) => a - b);
  if (expected.join(',') === got.join(',')) {
    if (ordered.length) {
      const only = new Set(ordered);
      const sequence = (t: string) => markersIn(t).filter((n) => only.has(n)).join(',');
      if (sequence(sourceText) !== sequence(translated)) return '번역문에서 LoreVeil 태그의 순서가 바뀌었습니다.';
    }
    return null;
  }
  const missing = expected.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !expected.includes(n));
  const dup = got.filter((n, i) => got.indexOf(n) !== i);
  const parts: string[] = [];
  if (missing.length) parts.push(`빠짐 ${missing.map((n) => `⟦${n}⟧`).join(' ')}`);
  if (extra.length) parts.push(`없던 표시 ${extra.map((n) => `⟦${n}⟧`).join(' ')}`);
  if (dup.length) parts.push(`중복 ${[...new Set(dup)].map((n) => `⟦${n}⟧`).join(' ')}`);
  return `번역문에서 보호 표시가 어긋났습니다 (${parts.join(', ')}).`;
}

/** Puts protected pieces back. Unknown markers are left as they are. */
export function restore(text: string, pieces: string[]): string {
  return text.replace(MARKER, (m, n: string) => pieces[Number(n) - 1] ?? m);
}
