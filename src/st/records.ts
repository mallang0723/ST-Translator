// Translation records in message.extra.st_translator, mirrored into swipe_info[swipe_id].extra
// because SillyTavern replaces message.extra wholesale when the user swipes.

import { METADATA_KEY, type MessageTranslations } from '../shared';
import { ctx, currentChatId, type STMessage } from './host';

export const MAX_ENTRIES_PER_MESSAGE = 12;
const SAVE_DELAY_MS = 500;

export function readTranslations(message: STMessage): MessageTranslations | null {
  const raw = message.extra?.[METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const mt = raw as MessageTranslations;
  if (!mt.entries || typeof mt.entries !== 'object') return null;
  return mt;
}

/** The swipe_info entry of the swipe that is showing, if the message has swipe_info. */
function activeSwipeInfo(message: STMessage) {
  const info = message.swipe_info;
  if (!Array.isArray(info)) return null;
  return info[message.swipe_id ?? 0] ?? null;
}

/** Writes `value` under `key` in extra and in the visible swipe's extra (undefined deletes). */
export function setExtra(message: STMessage, key: string, value: unknown): void {
  message.extra = message.extra ?? {};
  if (value === undefined) delete message.extra[key];
  else message.extra[key] = value;
  const info = activeSwipeInfo(message);
  if (info) {
    info.extra = info.extra ?? {};
    if (value === undefined) delete info.extra[key];
    else info.extra[key] = structuredClone(value);
  }
}

/** The visible swipe's index. */
export function currentSwipe(message: STMessage): number {
  return message.swipe_id ?? 0;
}

function prune(mt: MessageTranslations): void {
  const keys = Object.keys(mt.entries).sort((a, b) => (mt.entries[b]!.updatedAt ?? 0) - (mt.entries[a]!.updatedAt ?? 0));
  for (const k of keys.slice(MAX_ENTRIES_PER_MESSAGE)) delete mt.entries[k];
}

/**
 * Clone, change, prune to the newest entries, write to extra and the swipe mirror. Does not save.
 * With `swipe` set and different from the visible swipe, the change goes only into that swipe's own
 * swipe_info extra (the live extra belongs to the swipe the user is looking at now); when that swipe
 * has no swipe_info entry nothing is written and null is returned.
 */
export function writeTranslations(message: STMessage, change: (mt: MessageTranslations, message: STMessage) => void, swipe?: number): MessageTranslations {
  if (swipe !== undefined && swipe !== currentSwipe(message)) {
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipe] : undefined;
    if (!info) return { v: 1, entries: {} };
    info.extra = info.extra ?? {};
    const raw = info.extra[METADATA_KEY];
    const mt: MessageTranslations = structuredClone(raw && typeof raw === 'object' && (raw as MessageTranslations).entries ? (raw as MessageTranslations) : { v: 1, entries: {} });
    change(mt, message);
    prune(mt);
    info.extra[METADATA_KEY] = mt;
    return mt;
  }
  const mt: MessageTranslations = structuredClone(readTranslations(message) ?? { v: 1, entries: {} });
  change(mt, message);
  prune(mt);
  setExtra(message, METADATA_KEY, mt);
  return mt;
}

/** Sets the per-message "hidden" flag on the live extra and on every swipe (it belongs to the whole message). */
export function setHiddenEverywhere(message: STMessage, hidden: boolean): void {
  // Clearing the flag never creates a record where there is none (or where it is not set).
  const set = (mt: MessageTranslations | null) => hidden || mt?.hidden === true;
  if (set(readTranslations(message))) writeTranslations(message, (mt) => { mt.hidden = hidden; });
  if (!Array.isArray(message.swipe_info)) return;
  message.swipe_info.forEach((info, i) => {
    if (!info || i === currentSwipe(message)) return;
    const raw = info.extra?.[METADATA_KEY] as MessageTranslations | undefined;
    if (!set(raw && typeof raw === 'object' && raw.entries ? raw : null)) return;
    writeTranslations(message, (mt) => { mt.hidden = hidden; }, i);
  });
}

// ---- saving ----

/** Saves the chat, but only if `chatId` is still the open one (the message object may belong to a closed chat). */
export async function saveChatIfCurrent(forChat: string): Promise<boolean> {
  if (currentChatId() !== forChat) return false;
  await ctx().saveChat();
  return true;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSave(forChat: string): void {
  if (timers.has(forChat)) return;
  timers.set(
    forChat,
    setTimeout(() => {
      timers.delete(forChat);
      void saveChatIfCurrent(forChat).catch((e) => console.error('[st-translator] save failed', e));
    }, SAVE_DELAY_MS),
  );
}

/** Cancels a pending debounced save (the caller saves right away). */
export function cancelScheduledSave(forChat: string): void {
  const t = timers.get(forChat);
  if (t) clearTimeout(t);
  timers.delete(forChat);
}

/** writeTranslations + save: debounced for progress, awaited for final writes. */
export async function updateTranslations(forChat: string, message: STMessage, change: (mt: MessageTranslations, message: STMessage) => void, final = false, swipe?: number): Promise<MessageTranslations> {
  const mt = writeTranslations(message, change, swipe);
  if (final) {
    cancelScheduledSave(forChat);
    await saveChatIfCurrent(forChat);
  } else {
    scheduleSave(forChat);
  }
  return mt;
}
