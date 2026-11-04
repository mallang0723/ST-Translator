// Per-message buttons (translate / delete translation) and the delegated click handling for them
// and for the status bar buttons.

import { DELETE_TRANSLATION_LABEL, toolbarState } from '../message-ui';
import { targetLabel } from '../message-ui';
import { ctx, chatElement, toast, type STMessage } from './host';
import { confirmUnsaved } from './guard';
import { cancelMessage, continueAt, deleteTranslation, messageAt, setHidden, translateAt, viewOf } from './jobs';

const TRANSLATE_CLASS = 'stt-btn-translate';
const DELETE_CLASS = 'stt-btn-delete';

function makeButton(cls: string, icon: string): HTMLElement {
  const b = document.createElement('div');
  b.className = `mes_button ${cls} ${icon}`;
  b.tabIndex = 0;
  b.setAttribute('role', 'button');
  return b;
}

/** Adds the two buttons before the edit pencil of a `.mes_buttons` row. Idempotent. */
export function addButtons(row: Element): void {
  if (row.querySelector(`.${TRANSLATE_CLASS}`)) return;
  const anchor = row.querySelector(':scope > .mes_edit');
  const translate = makeButton(TRANSLATE_CLASS, 'fa-solid fa-earth-asia');
  translate.title = '번역';
  const del = makeButton(DELETE_CLASS, 'fa-solid fa-eraser');
  del.title = DELETE_TRANSLATION_LABEL;
  del.style.display = 'none';
  if (anchor) {
    anchor.before(translate, del);
  } else {
    row.append(translate, del);
  }
}

/** Template (for new messages) and every message already in the chat. */
export function addButtonsEverywhere(): void {
  document.querySelectorAll('#message_template .mes_buttons, #chat .mes .mes_buttons').forEach(addButtons);
}

/** Syncs title / busy / delete visibility with the message's view. */
export function updateToolbar(mesEl: Element, message: STMessage, id: number): void {
  const row = mesEl.querySelector('.mes_buttons');
  if (!row) return;
  addButtons(row);
  const state = toolbarState(viewOf(message, id));
  const translate = row.querySelector<HTMLElement>(`.${TRANSLATE_CLASS}`);
  const del = row.querySelector<HTMLElement>(`.${DELETE_CLASS}`);
  if (translate) {
    translate.title = state.label;
    translate.classList.toggle('stt-busy', state.busy);
  }
  if (del) del.style.display = state.canDelete ? '' : 'none';
}

async function confirmDelete(message: STMessage, id: number): Promise<void> {
  const c = ctx();
  const view = viewOf(message, id);
  if (view.text === null || view.busy) return;
  const key = view.sourceKey;
  const text = `${targetLabel(view)} 메시지에서 지금 보이는 스와이프의 번역만 지울까요?\n다른 스와이프의 번역과 메시지 원문은 그대로 남습니다.`;
  let ok: boolean;
  if (c.callGenericPopup && c.POPUP_TYPE) {
    const result = await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM, '', { okButton: '번역 삭제', cancelButton: '취소' });
    ok = result === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) || result === true;
  } else {
    ok = window.confirm(text);
  }
  if (!ok) return;
  // The user may have swiped while the popup was open: do not delete another swipe's translation.
  if (viewOf(message, c.chat.indexOf(message)).sourceKey !== key) {
    toast('info', '스와이프가 바뀌어 번역을 지우지 않았습니다.');
    return;
  }
  await deleteTranslation(message, key);
}

function mesIdOf(target: Element): number | null {
  const mes = target.closest('.mes');
  const id = Number(mes?.getAttribute('mesid'));
  return mes && Number.isInteger(id) ? id : null;
}

export function handleClick(ev: Event): void {
  const target = ev.target as Element | null;
  if (!target?.closest) return;
  const btn = target.closest<HTMLElement>(`.${TRANSLATE_CLASS}, .${DELETE_CLASS}, .stt-bar [data-stt-act]`);
  if (!btn) return;
  const id = mesIdOf(btn);
  const message = id === null ? null : messageAt(id);
  if (id === null || !message) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (btn.classList.contains(TRANSLATE_CLASS)) {
    const state = toolbarState(viewOf(message, id));
    if (state.action === 'cancel') cancelMessage(message);
    else if (state.action === 'elsewhere') toast('info', '다른 스와이프를 번역하는 중입니다.');
    else void confirmUnsaved().then((ok) => (ok ? translateAt(id, state.force) : undefined));
  } else if (btn.classList.contains(DELETE_CLASS)) {
    void confirmDelete(message, id);
  } else {
    const act = btn.dataset.sttAct;
    if (act === 'cancel') cancelMessage(message);
    else if (act === 'continue') void confirmUnsaved().then((ok) => (ok ? continueAt(id) : undefined));
    else if (act === 'retranslate') void confirmUnsaved().then((ok) => (ok ? translateAt(id, true) : undefined));
    else if (act === 'toggle') setHidden(message, !viewOf(message, id).hidden);
  }
}

export function mountToolbar(): () => void {
  const chat = chatElement();
  addButtonsEverywhere();
  chat?.addEventListener('click', handleClick);
  return () => chat?.removeEventListener('click', handleClick);
}
