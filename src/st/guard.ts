// Unsaved-settings guard: translation uses the saved settings, so when the settings drawer has edits
// that are not saved yet, translate / continue first asks to save them (same wording as the original).

import { ctx } from './host';

export interface UnsavedGuard {
  isDirty(): boolean;
  /** Saves the open edits (as this chat's settings). Returns false when saving failed. */
  save(): boolean;
}

let guard: UnsavedGuard | null = null;

export function setUnsavedGuard(g: UnsavedGuard | null): void {
  guard = g;
}

export const UNSAVED_TITLE = '저장하지 않은 변경이 있어요';
export const UNSAVED_MESSAGE = '번역 설정을 바꾼 뒤 저장하지 않았습니다. 저장하지 않은 내용은 번역에 반영되지 않습니다.\n지금 저장하고 번역할까요?';
export const UNSAVED_CONFIRM_LABEL = '저장하고 번역';

/** Resolves true when the translation may start now (nothing unsaved, or the user chose to save first). */
export async function confirmUnsaved(): Promise<boolean> {
  if (!guard || !guard.isDirty()) return true;
  const c = ctx();
  const text = `${UNSAVED_TITLE}\n\n${UNSAVED_MESSAGE}`;
  let ok: boolean;
  if (c.callGenericPopup && c.POPUP_TYPE) {
    const result = await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM, '', { okButton: UNSAVED_CONFIRM_LABEL, cancelButton: '취소' });
    ok = result === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) || result === true;
  } else {
    ok = window.confirm(text);
  }
  if (!ok) return false;
  return guard?.save() ?? true;
}
