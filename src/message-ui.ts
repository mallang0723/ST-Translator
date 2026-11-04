// Pure logic behind the per-message toolbar buttons.
// No DOM and no host access, so it can be tested directly.

import { replaceIllustrations } from './illustrations';
import { restore } from './translate/protect';
import { type DisplayMode, type MessageTranslations, type MessageView, sourceHash, rawSourceHash, type TranslationRecord, type TranslationStatus } from './shared';

// ---- message label ----

/** "#225 name" (just "#225" when the message has no name). */
export function targetLabel(view: Pick<MessageView, 'index' | 'name'>): string {
  const name = view.name.trim();
  return name ? `#${view.index} ${name}` : `#${view.index}`;
}

// ---- toolbar buttons ----

export interface ToolbarState {
  /** What the translate button does when pressed. */
  action: 'translate' | 'cancel' | 'elsewhere';
  /** A translation is replaced: the host asks the backend to translate even if one is saved. */
  force: boolean;
  label: string;
  /** The delete-translation button is only offered while the visible swipe has a translation and is not itself being translated. */
  canDelete: boolean;
  busy: boolean;
}

export function toolbarState(view: Pick<MessageView, 'busy' | 'text' | 'status'> & { busyElsewhere?: boolean } | null): ToolbarState {
  if (!view) return { action: 'translate', force: false, label: '번역', canDelete: false, busy: false };
  if (view.busy) return { action: 'cancel', force: false, label: '번역 중단 (번역 중입니다)', canDelete: false, busy: true };
  const exists = view.text !== null || view.status !== null;
  // A job of another swipe is running: neutral and inert (not "already translating"); deleting this swipe's translation is safe.
  if (view.busyElsewhere) return { action: 'elsewhere', force: false, label: '다른 스와이프를 번역하는 중입니다', canDelete: view.text !== null, busy: false };
  return {
    action: 'translate',
    force: exists,
    label: exists ? '다시 번역 (저장된 번역을 새로 만듭니다)' : '번역',
    canDelete: view.text !== null,
    busy: false,
  };
}

export const DELETE_TRANSLATION_LABEL = '번역 삭제 (지금 보이는 스와이프의 번역만 지웁니다. 메시지는 그대로입니다)';

/** Message id from a decorator scope such as `message:<id>:actions`. */
export function messageIdFromScope(scope: string): string | null {
  const m = /^message:(.+):actions$/.exec(scope);
  return m ? m[1]! : null;
}

// ---- slim status bar under a message ----

/**
 * The show / hide translation toggle. The paragraph view always sits next to the original, so hiding
 * it is pointless there (the toolbar's delete button removes a translation); the other modes,
 * including collapsed-source, keep it.
 */
export function showsToggle(view: Pick<MessageView, 'text'>, mode: DisplayMode): boolean {
  return mode !== 'paragraph' && !!view.text;
}

/**
 * Whether the slim bar is shown. Outside the paragraph view any message with a translation state gets
 * one (including collapsed-source; it carries the show / hide toggle). In the paragraph view only
 * trouble does: busy, error or a partial translation. A normally translated message has no bar there.
 */
export function wantsBar(view: Pick<MessageView, 'role' | 'busy' | 'status'> & { busyElsewhere?: boolean }, mode: DisplayMode): boolean {
  if (view.role === 'system') return false;
  if (view.busy || view.busyElsewhere) return true;
  if (mode === 'paragraph') return view.status === 'error' || view.status === 'partial';
  return view.status !== null;
}

/** A hidden flag shows the original in every mode, including collapsed-source, except paragraph view. */
export function isTranslationHidden(hidden: boolean | undefined, mode: DisplayMode): boolean {
  return mode !== 'paragraph' && hidden === true;
}

// ---- backend decisions ----

/** A plain "translate" of a message that already has a finished translation does nothing unless forced. */
export function skipFresh(mode: 'fresh' | 'continue', existing: Pick<TranslationRecord, 'status'> | undefined, force: boolean): boolean {
  const status: TranslationStatus | undefined = existing?.status;
  return mode === 'fresh' && status === 'done' && !force;
}

/**
 * The translation of the swipe that is showing. Translations are keyed by sourceHash(content), and
 * the message's `content` is always the active swipe's text, so switching swipes switches the key.
 */
export function recordFor(mt: Pick<MessageTranslations, 'entries'> | null | undefined, content: string): TranslationRecord | null {
  const key = recordKeyFor(mt, content);
  return key ? mt?.entries?.[key] ?? null : null;
}

/** Return the actual stored key so legacy entries can also be deleted from the UI. */
export function recordKeyFor(mt: Pick<MessageTranslations, 'entries'> | null | undefined, content: string): string | null {
  for (const key of [sourceHash(content), rawSourceHash(content)]) {
    if (mt?.entries?.[key]) return key;
  }
  // Old records have no original source field. Recover only when their retained
  // markup lets us reconstruct a source whose raw hash EXACTLY matches the key.
  // This avoids selecting an unrelated swipe/edited passage by recency or count.
  const current: string[] = [];
  replaceIllustrations(content, (piece) => { current.push(piece); return piece; });
  if (current.length) {
    const entries = Object.entries(mt?.entries ?? {}).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [key, record] of entries) {
      const original: string[] = [];
      replaceIllustrations(restore(record.parts.join('\n\n'), record.pieces), (piece) => {
        original.push(piece);
        return piece;
      });
      if (original.length !== current.length) continue;
      const candidate = replaceIllustrations(content, (_piece, index) => original[index]!);
      if (rawSourceHash(candidate) === key) return key;
    }
  }
  return null;
}

/**
 * Deletes the translation stored under `key` (the visible swipe's sourceHash) and leaves every other
 * swipe's translation alone. The "hidden" flag belongs to the whole message, so it is only reset once
 * nothing is left to hide. Edits the given object; the stored shape is unchanged.
 */
export function clearTranslation(mt: MessageTranslations, key: string): void {
  delete mt.entries[key];
  if (Object.keys(mt.entries).length === 0) mt.hidden = false;
}
