// Display: the rendered translation lives in ST's native message.extra.display_text (mirrored into
// the visible swipe's extra). Ownership is tracked by extra.st_translator.display = sourceHash(text
// we wrote), so a display_text written by anything else (ST's built-in Chat Translation) is never
// clobbered when we have nothing to show. The slim status bar is the only injected DOM here.

import { protectExtraFor } from '../compat';
import { renderMessage } from '../display/render';
import { isTranslationHidden, recordFor, showsToggle, wantsBar } from '../message-ui';
import { CANCELLED_MESSAGE, type ChatSettings, type CompatSettings, type MessageTranslations, sourceHash, type ViewSettings } from '../shared';
import { ctx, chatElement, currentChatId, indexOfMessage, messageElement, type STMessage } from './host';
import { onViewUpdate, viewOf } from './jobs';
import { readTranslations, scheduleSave, setExtra, writeTranslations } from './records';
import { getStore, settings as currentSettings } from './store';
import { updateToolbar } from './toolbar';

type Owned = MessageTranslations;

/** Adds `markdown="1"` to the paragraph-view wrappers: ST's showdown only parses Markdown inside block HTML that has it. */
export function enableMarkdownInWrappers(html: string): string {
  return html.replace(/<(div|details) class="([^"]*)"/g, (all, tag: string, cls: string) =>
    /^stt-pr/.test(cls) && !/\bstt-pr-(label|note)\b/.test(cls) ? `<${tag} class="${cls}" markdown="1"` : all,
  );
}

/** The string that should be in display_text for this message, or null when nothing should be. Pure. */
export function computeDisplayText(message: STMessage, settings: ChatSettings, view: ViewSettings, compat?: CompatSettings): string | null {
  const mt = readTranslations(message);
  if (!mt || isTranslationHidden(mt.hidden, settings.displayMode)) return null;
  const content = message.mes ?? '';
  const record = recordFor(mt, content);
  if (!record || !record.parts.some((p) => p.trim())) return null;
  const out = renderMessage(content, record, settings, view, compat ? { protect: protectExtraFor(compat, 'incoming', undefined), singleInstance: compat.autopic || compat.thRerender } : {});
  if (out === content) return null;
  return settings.displayMode === 'paragraph' ? enableMarkdownInWrappers(out) : out;
}

/** Tavern Helper's own request to re-render one message (its iframes die when .mes_text is rewritten). */
export const TH_RENDER_EVENT = 'TH_REQUEST_RENDER_MESSAGE';

/**
 * After we rewrote a message block: ask Tavern Helper to re-render it, but only when it is listening, so
 * nothing happens without it. Never emits SillyTavern's own events (other extensions act on those).
 */
export function requestThRender(id: number): boolean {
  if (!getStore().compat.thRerender) return false;
  try {
    const source = ctx().eventSource;
    if (!source?.events?.[TH_RENDER_EVENT]?.length) return false;
    if (getStore().compat.debug) console.log(`[st-translator] TH rerender mesid=${id}`);
    void Promise.resolve(source.emit(TH_RENDER_EVENT, id)).catch((e) => console.warn('[st-translator] TH render request failed', e));
    return true;
  } catch (e) {
    console.warn('[st-translator] TH render request failed', e);
    return false;
  }
}

export function isEditing(el: Element | null): boolean {
  return !!el?.querySelector('.edit_textarea');
}

/**
 * The one output step. `text` = what display_text should be (null = remove ours). Returns whether
 * the message data changed. Re-renders the block unless the message is being edited.
 */
export function applyDisplay(message: STMessage, id: number, text: string | null, visible = true): boolean {
  const mt = readTranslations(message) as Owned | null;
  const current = typeof message.extra?.display_text === 'string' ? (message.extra.display_text as string) : undefined;
  const owned = mt?.display;
  const ours = current !== undefined && !!owned && sourceHash(current) === owned;
  let changed = false;
  if (text !== null) {
    if (current !== text || owned !== sourceHash(text)) {
      setExtra(message, 'display_text', text);
      writeTranslations(message, (m) => { (m as Owned).display = sourceHash(text); });
      changed = true;
    }
  } else if (ours) {
    setExtra(message, 'display_text', undefined);
    writeTranslations(message, (m) => { delete (m as Owned).display; });
    changed = true;
  } else if (owned && current === undefined) {
    // The built-in toggle removed our text ("show original"); forget the stale ownership.
    writeTranslations(message, (m) => { delete (m as Owned).display; });
    changed = true;
  }
  if (changed) {
    const chatId = currentChatId();
    if (chatId) scheduleSave(chatId);
    const el = visible ? messageElement(id) : null;
    if (el && !isEditing(el)) {
      try {
        ctx().updateMessageBlock(id, message);
        requestThRender(id);
      } catch (e) {
        console.warn('[st-translator] updateMessageBlock failed', e);
      }
    }
  }
  return changed;
}

/**
 * Draws the stored display_text again (ST redraws .mes_text from `mes` after an edit is closed).
 * Does nothing without display_text, without a rendered message, or while the message is being edited.
 */
export function rerenderDisplayText(message: STMessage, id: number): boolean {
  if (typeof message.extra?.display_text !== 'string') return false;
  const el = messageElement(id);
  if (!el || isEditing(el)) return false;
  try {
    ctx().updateMessageBlock(id, message);
    requestThRender(id);
    return true;
  } catch (e) {
    console.warn('[st-translator] updateMessageBlock failed', e);
    return false;
  }
}

/** Recompute and apply display_text for one message. */
export function recompute(message: STMessage, id = indexOfMessage(message)): boolean {
  if (id < 0) return false;
  return applyDisplay(message, id, computeDisplayText(message, currentSettings(), getStore().view, getStore().compat));
}

// ---- status bar ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function actionButton(label: string, act: string, cls = '', title = ''): HTMLButtonElement {
  const b = el('button', `menu_button stt-btn ${cls}`.trim(), label);
  b.type = 'button';
  b.dataset.sttAct = act;
  if (title) b.title = title;
  return b;
}

function renderBar(bar: HTMLElement, message: STMessage, id: number): boolean {
  const view = viewOf(message, id);
  const mode = currentSettings().displayMode;
  if (!wantsBar(view, mode)) return false;
  const items: HTMLElement[] = [];
  if (view.busyElsewhere && !view.busy) {
    // The running job belongs to another swipe: say so (neutral), keep cancel reachable.
    items.push(el('span', 'stt-note', '다른 스와이프를 번역하는 중입니다'));
    items.push(actionButton('취소', 'cancel', 'stt-danger'));
  } else if (view.busy) {
    items.push(el('span', 'stt-note', view.progress ? `번역 중… ${view.progress.done}/${view.progress.total}` : '번역 중…'));
    items.push(actionButton('취소', 'cancel', 'stt-danger'));
  } else {
    if (view.status === 'error' && view.cancelled) {
      items.push(el('span', 'stt-note', CANCELLED_MESSAGE));
      items.push(actionButton('다시 번역', 'retranslate', 'stt-primary', '처음부터 다시 번역합니다'));
    } else if (view.status === 'error') {
      const e = el('span', 'stt-note stt-err', `번역 오류: ${(view.error ?? '').slice(0, 260)}`);
      e.title = view.error ?? '';
      items.push(e);
    }
    if (view.status === 'partial') {
      const progress = view.progress && view.progress.done < view.progress.total ? ` (${view.progress.done}/${view.progress.total})` : '';
      items.push(el('span', 'stt-note stt-warn', `번역이 중간에 끊겼습니다${progress}`));
    }
    if (view.hasMore) items.push(actionButton('이어서 번역', 'continue', 'stt-primary', '끊긴 곳부터 이어서 번역합니다'));
    if (showsToggle(view, mode)) items.push(actionButton(view.hidden ? '번역 보기' : '번역 숨기기', 'toggle'));
  }
  bar.replaceChildren(...items);
  return true;
}

/** Status bar and toolbar buttons of one rendered message (idempotent). */
export function decorate(id: number): void {
  const mesEl = messageElement(id);
  const message = ctx().chat[id];
  if (!mesEl || !message) return;
  updateToolbar(mesEl, message, id);
  const text = mesEl.querySelector('.mes_text');
  if (!text) return;
  let bar = mesEl.querySelector<HTMLElement>(':scope .stt-bar');
  if (isEditing(mesEl)) return;
  if (!bar) {
    bar = el('div', 'stt-bar');
    text.after(bar);
  }
  if (!renderBar(bar, message, id)) {
    bar.remove();
  }
}

export function decorateAll(): void {
  const chat = ctx().chat;
  for (let i = 0; i < chat.length; i++) decorate(i);
}

/**
 * display_text of a swipe that is not the visible one (a job finished on it after the user swiped away).
 * Only that swipe's own swipe_info extra is touched; nothing is drawn.
 */
export function recomputeSwipe(message: STMessage, swipe: number, id = indexOfMessage(message)): boolean {
  const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipe] : undefined;
  const mes = message.swipes?.[swipe];
  if (id < 0 || !info || typeof mes !== 'string') return false;
  info.extra = info.extra ?? {};
  // A view of that swipe: same message, its own text and extra. info.extra is the shared object, so writes land there.
  const view: STMessage = { ...message, mes, swipe_id: swipe, extra: info.extra };
  return applyDisplay(view, id, computeDisplayText(view, currentSettings(), getStore().view, getStore().compat), false);
}

/** A job or a hide/delete changed this message (`swipe`: the swipe a job wrote to, if not the visible one). */
export function refreshMessage(message: STMessage, swipe?: number): void {
  const id = indexOfMessage(message);
  if (id < 0) return;
  if (swipe !== undefined && swipe !== (message.swipe_id ?? 0)) recomputeSwipe(message, swipe, id);
  else recompute(message, id);
  decorate(id);
}

/** Settings or view changed: rewrite every message of the open chat and re-decorate. */
export function refreshChat(): void {
  const chat = ctx().chat;
  for (let i = 0; i < chat.length; i++) recompute(chat[i]!, i);
  decorateAll();
}

export function applyFontVars(): void {
  const chat = chatElement();
  if (!chat) return;
  const { sourceFontSize, translationFontSize } = getStore().view;
  chat.style.setProperty('--stt-source-size', `${sourceFontSize}px`);
  chat.style.setProperty('--stt-translation-size', `${translationFontSize}px`);
}

/** Display follows job / hide / delete updates. */
export function mountDisplay(): () => void {
  return onViewUpdate(refreshMessage);
}
