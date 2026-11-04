// Pure helpers for living next to LoreVeil, AutoPic and Tavern Helper.
// No host access here; the ST layer feeds in extensionSettings.loreVeil and our own compat switches.

import type { CompatSettings } from './shared';
import type { ProtectExtra } from './translate/engine';
import { type LoreVeilConfig, LOREVEIL_DEFAULT_TAG } from './translate/protect';

const LOREVEIL_TAG_NAME = /^[a-z][a-z0-9_:-]*$/;

/**
 * Reads LoreVeil's settings object (`extensionSettings.loreVeil`). Tag names are split on commas,
 * trimmed, lowercased and must look like `[a-z][a-z0-9_:-]*`; the default tag is always included.
 * Anything missing falls back to LoreVeil's defaults (attribute form on).
 */
export function loreveilConfig(raw: unknown): LoreVeilConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as { tags?: unknown; attribute?: unknown };
  const list = (Array.isArray(v.tags) ? v.tags : [v.tags]).flatMap((x) => (typeof x === 'string' ? x.split(',') : []));
  const tags = [LOREVEIL_DEFAULT_TAG];
  for (const piece of list) {
    const tag = piece.trim().toLowerCase();
    if (LOREVEIL_TAG_NAME.test(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return { tags, attribute: v.attribute !== false };
}

/** Extra protect options for one translation direction. LoreVeil only matters for my outgoing messages. */
export function protectExtraFor(compat: Pick<CompatSettings, 'loreveil' | 'autopic'>, direction: 'incoming' | 'outgoing', loreveil: unknown): ProtectExtra {
  return {
    autopic: compat.autopic,
    loreveil: compat.loreveil && direction === 'outgoing' ? loreveilConfig(loreveil) : null,
  };
}

/** Marks where a dropped block used to be; chosen so it does not occur in the text. */
export function blockSentinel(...texts: string[]): string {
  let s = '\uE000';
  while (texts.some((t) => t.includes(s))) s += '\uE001';
  return s;
}

/** `pieces` with the given marker numbers (1-based) replaced by `sentinel`. */
export function blankPieces(pieces: string[], drop: Iterable<number>, sentinel: string): string[] {
  const out = pieces.slice();
  for (const n of drop) if (n >= 1 && n <= out.length) out[n - 1] = sentinel;
  return out;
}

/**
 * Removes every `sentinel` from `text`, and the blank space it leaves between block-level neighbours.
 * The blocks are found by position (their marker), never by searching for their text.
 */
export function removeSentinels(text: string, sentinel: string): string {
  let out = text;
  for (;;) {
    const at = out.indexOf(sentinel);
    if (at < 0) return out;
    let before = out.slice(0, at);
    let after = out.slice(at + sentinel.length);
    if (/(^|\n)[ \t]*$/.test(before) && /^[ \t]*(\r?\n|$)/.test(after)) {
      before = before.replace(/[ \t]*$/, '');
      after = after.replace(/^[ \t]*(?:\r?\n[ \t]*)*/, '');
      if (!after.trim()) before = before.replace(/\s+$/, '');
      const gap = !before.trim() || !after.trim() ? '' : /\n\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
      out = before + gap + after;
    } else {
      out = before + after;
    }
  }
}
