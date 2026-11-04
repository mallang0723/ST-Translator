// Handlers for SillyTavern message events that keep display_text and the status bar in sync.
// Kept apart from index.ts so tests can call them directly.

import { decorate, recompute, rerenderDisplayText } from './display';
import { ctx } from './host';
import { autoTranslate } from './jobs';

/** A swipe that is still waiting for its generation (overswipe regenerate): mes holds the previous swipe's text. */
export function isPendingSwipe(message: { swipes?: string[]; swipe_id?: number }): boolean {
  return Array.isArray(message.swipes) && (message.swipe_id ?? 0) >= message.swipes.length;
}

/** MESSAGE_EDITED: the text may no longer match the record, so stale owned display_text goes. */
export function onMessageEdited(id: number): void {
  const m = ctx().chat[id];
  if (m) recompute(m, id);
  decorate(id);
}

/**
 * MESSAGE_SWIPED. While a regeneration is pending, `mes` still holds the old text: recomputing would
 * write the old translation back into the new swipe, so it is skipped (ST already cleared display_text).
 */
export function onMessageSwiped(id: number): void {
  const m = ctx().chat[id];
  if (m && !isPendingSwipe(m)) recompute(m, id);
  decorate(id);
}

/**
 * MESSAGE_UPDATED (also fired after an edit is finished or cancelled; ST then redraws .mes_text from
 * `mes` and ignores display_text): drop stale owned text, then draw display_text again.
 */
export function onMessageUpdated(id: number): void {
  const m = ctx().chat[id];
  if (m && !isPendingSwipe(m)) {
    // applyDisplay already redraws when it changed something.
    if (!recompute(m, id)) rerenderDisplayText(m, id);
  }
  decorate(id);
}

/** MESSAGE_RECEIVED: a finished generation or Continue changed `mes`; drop stale text before translating. */
export function onMessageReceived(id: number, type?: string): void {
  const m = ctx().chat[id];
  if (m) recompute(m, id);
  void autoTranslate(id, type);
}
