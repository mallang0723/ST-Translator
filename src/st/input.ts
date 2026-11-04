// Outgoing translation (MESSAGE_SENT) and the draft translate button beside the input.

import { clearToast, ctx, toast } from './host';
import { confirmUnsaved } from './guard';
import { translateOutgoing, translateText } from './jobs';
import { settings as currentSettings } from './store';

let lastDraftOutput: string | null = null;

export function resetDraftMemory(): void {
  lastDraftOutput = null;
}

/** MESSAGE_SENT handler: replaces the user message text with its translation before the prompt is built. */
export async function onMessageSent(id: number): Promise<void> {
  const settings = currentSettings();
  const c = ctx();
  const message = c.chat[id];
  if (!settings.translateMyMessages || !message || !message.is_user || message.is_system) return;
  const text = typeof message.mes === 'string' ? message.mes : '';
  if (!text.trim()) return;
  if (lastDraftOutput !== null && text.trim() === lastDraftOutput) {
    lastDraftOutput = null;
    return;
  }
  lastDraftOutput = null;
  const waiting = toast('info', '번역 중…', { timeOut: 0, extendedTimeOut: 0 });
  try {
    const translated = await translateOutgoing(c.getCurrentChatId() ?? null, text, id);
    if (!c.chat.includes(message)) return;
    message.mes = translated;
    if (Array.isArray(message.swipes) && message.swipes.length) message.swipes[message.swipe_id ?? 0] = translated;
    await c.saveChat();
  } catch (e) {
    toast('error', `번역 실패: ${e instanceof Error ? e.message : String(e)} 원문을 보냅니다.`);
  } finally {
    clearToast(waiting);
  }
}

// ---- draft button ----

let button: HTMLElement | null = null;
let busy = false;

function textarea(): HTMLTextAreaElement | null {
  return document.getElementById('send_textarea') as HTMLTextAreaElement | null;
}

async function translateDraft(): Promise<void> {
  const ta = textarea();
  if (!ta || busy || !ta.value.trim()) return;
  busy = true;
  button?.classList.add('stt-busy');
  try {
    if (!(await confirmUnsaved())) return;
    const translated = await translateText(ta.value);
    ta.value = translated;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    lastDraftOutput = translated.trim();
  } catch (e) {
    toast('error', `번역 실패: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
    button?.classList.remove('stt-busy');
  }
}

/** Shows or removes the draft button according to the current settings. */
export function syncDraftButton(): void {
  const settings = currentSettings();
  const form = document.getElementById('rightSendForm');
  const want = settings.showDraftButton && !!form;
  if (!want) {
    button?.remove();
    button = null;
    return;
  }
  if (!button || !button.isConnected) {
    button = document.createElement('div');
    button.className = 'fa-solid fa-language stt-draft-btn interactable';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.addEventListener('click', () => void translateDraft());
    form!.insertBefore(button, document.getElementById('send_but'));
  }
  button.title = `입력한 글을 ${settings.modelLanguage}로 번역합니다`;
}
