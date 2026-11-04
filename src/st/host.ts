// Typed wrapper around SillyTavern.getContext() plus small DOM helpers.
// This is the only place that touches the host global; everything else imports from here.

export interface STSwipeInfo {
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface STMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes: string;
  swipes?: string[];
  swipe_id?: number;
  swipe_info?: STSwipeInfo[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface STProfile {
  id: string;
  name?: string;
  api?: string;
  model?: string;
  [key: string]: unknown;
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => unknown): void;
  once?(event: string, handler: (...args: any[]) => unknown): void;
  removeListener(event: string, handler: (...args: any[]) => unknown): void;
  emit(event: string, ...args: unknown[]): Promise<void> | void;
  /** ST's EventEmitter keeps listeners here, event name -> array (an emptied array stays behind). */
  events?: Record<string, unknown[] | undefined>;
}

export interface STContext {
  chat: STMessage[];
  chatId?: string;
  getCurrentChatId(): string | undefined;
  chatMetadata: Record<string, unknown>;
  saveMetadataDebounced(): void;
  extensionSettings: Record<string, any>;
  saveSettingsDebounced(): void;
  saveChat(): Promise<void>;
  eventSource: STEventSource;
  eventTypes: Record<string, string>;
  messageFormatting(mes: string, name: string, isSystem: boolean, isUser: boolean, messageId: number | string, sanitizerOverrides?: object, isReasoning?: boolean): string;
  updateMessageBlock(mesId: number | string, message: STMessage, options?: { rerenderMessage?: boolean }): void;
  generateRaw(params: { prompt: string; systemPrompt?: string; responseLength?: number | null }): Promise<string>;
  extractMessageFromData(json: unknown, apiType?: string | null): string;
  ConnectionManagerRequestService?: {
    getSupportedProfiles(): STProfile[];
    getProfile(id: string): STProfile;
    validateProfile(profile: STProfile): { selected: string };
    sendRequest(profileId: string, messages: { role: string; content: string }[], maxTokens: number, custom?: Record<string, unknown>, overridePayload?: Record<string, unknown>): Promise<unknown>;
  };
  callGenericPopup?(content: string, type: unknown, inputValue?: string, options?: Record<string, unknown>): Promise<unknown>;
  POPUP_TYPE?: Record<string, unknown>;
  POPUP_RESULT?: Record<string, unknown>;
  uuidv4?(): string;
}

export function ctx(): STContext {
  const st = (globalThis as { SillyTavern?: { getContext(): STContext } }).SillyTavern;
  if (!st) throw new Error('SillyTavern을 찾을 수 없습니다.');
  return st.getContext();
}

export function currentChatId(): string | null {
  try {
    return ctx().getCurrentChatId() ?? null;
  } catch {
    return null;
  }
}

type ToastKind = 'info' | 'warning' | 'error' | 'success';
interface Toastr {
  [kind: string]: (message: string, title?: string, options?: Record<string, unknown>) => unknown;
}

export function toast(kind: ToastKind, text: string, options?: Record<string, unknown>): unknown {
  const t = (globalThis as { toastr?: Toastr }).toastr;
  try {
    return t?.[kind]?.(text, '', options);
  } catch {
    return undefined;
  }
}

export function clearToast(handle: unknown): void {
  const t = (globalThis as { toastr?: { clear?: (h: unknown) => void } }).toastr;
  try {
    if (handle) t?.clear?.(handle);
  } catch {
    // ignore
  }
}

export function chatElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('chat');
}

export function messageElement(id: number): HTMLElement | null {
  return chatElement()?.querySelector<HTMLElement>(`.mes[mesid="${id}"]`) ?? null;
}

/** Index of a message object in the open chat, -1 when it is gone. */
export function indexOfMessage(message: STMessage): number {
  return ctx().chat.indexOf(message);
}
