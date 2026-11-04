// How a translated message is shown for each display mode. Pure, so it can be tested directly.

import { blankPieces, blockSentinel, removeSentinels } from '../compat';
import type { ChatSettings, TranslationRecord, ViewSettings } from '../shared';
import { type ProtectExtra, recordToText } from '../translate/engine';
import { cleanReply } from '../translate/clean-reply';
import { markersIn, protect, restore } from '../translate/protect';
import { buildParagraphView } from './paragraph-view';

export interface RenderOptions {
  /** AutoPic / LoreVeil protection used when the record was made (must match for paragraph pairing). */
  protect?: ProtectExtra;
  /**
   * In modes that show both sides, whole-element excluded blocks and fenced code appear once: on the side
   * that carries the original (below / collapsed: original; above / collapsed-source: translation).
   */
  singleInstance?: boolean;
}

function blocksOf(content: string, settings: ChatSettings, options: RenderOptions) {
  if (!options.singleInstance) return null;
  try {
    const p = protect(content, { ...settings, ...options.protect });
    return p.blockMarkers.length ? p : null;
  } catch {
    return null;
  }
}

export function renderMessage(content: string, record: TranslationRecord | null | undefined, settings: ChatSettings, view: ViewSettings, options: RenderOptions = {}): string {
  // Keep the original visible until translated text exists, as in the backend render processor.
  if (!record || !record.parts.some((p) => cleanReply(p).trim())) return content;
  if (settings.displayMode === 'paragraph') return buildParagraphView(content, record, settings, view.paragraphView, view.paragraphOrder, options.protect);
  const mode = settings.displayMode;
  const held = mode === 'only' ? null : blocksOf(content, settings, options);
  // Blocks are dropped by their marker (position), so identical text elsewhere in the message is never touched.
  // Only markers that match the record's own pieces count (a stale record keeps everything).
  const ownMarkers = held ? held.blockMarkers.filter((n) => record.pieces[n - 1] === held.pieces[n - 1]) : [];
  const sentinel = blockSentinel(content, ...record.parts, ...record.pieces);
  const originalFirst = mode !== 'above' && mode !== 'collapsed-source';
  let text = recordToText(originalFirst && ownMarkers.length ? { ...record, pieces: blankPieces(record.pieces, ownMarkers, sentinel) } : record, content);
  if (mode === 'only') return text;
  if (originalFirst && ownMarkers.length) text = removeSentinels(text, sentinel);
  const hasBlocks = ownMarkers.length > 0;
  // The side that does not carry the original loses the blocks (only those the translation really has).
  let source = content;
  if (held && !originalFirst && hasBlocks) {
    const inTranslation = new Set(markersIn(record.parts.map(cleanReply).join('\n\n')));
    const drop = ownMarkers.filter((n) => inTranslation.has(n));
    if (drop.length) source = removeSentinels(restore(held.text, blankPieces(held.pieces, drop, sentinel)), sentinel);
  }
  const translation = text;
  if (hasBlocks && !source.trim()) return translation;
  if (hasBlocks && !translation.trim()) return source;
  switch (mode) {
    case 'above':
      return `${translation}\n\n<hr class="stt-separator">\n\n${source}`;
    case 'collapsed':
      return `${source}\n\n<details class="stt-translation"><summary>번역</summary>\n\n${translation}\n\n</details>`;
    case 'collapsed-source':
      return `${translation}\n\n<details class="stt-translation"><summary>원문</summary>\n\n${source}\n\n</details>`;
    default:
      return `${source}\n\n<hr class="stt-separator">\n\n${translation}`;
  }
}
