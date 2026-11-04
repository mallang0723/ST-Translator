// A fake SillyTavern.getContext() for the st-* tests. No DOM, no network.

import { resetWarnings } from '../src/st/complete';
import { loadStore } from '../src/st/store';

export interface Fake {
  ctx: any;
  toasts: { kind: string; text: string }[];
  saves: { chat: number; settings: number; meta: number };
  raw: { calls: any[]; impl: (p: any) => Promise<string> };
  requests: any[];
  /** Switch to another chat (new chat array contents and metadata, new chat id). */
  switchChat(id: string | undefined, messages?: any[], meta?: Record<string, unknown>): void;
}

export function installFake(opts: { chatId?: string; chat?: any[]; meta?: Record<string, unknown>; settings?: Record<string, unknown>; profiles?: any[]; selectedProfile?: string; disabled?: string[] } = {}): Fake {
  const toasts: Fake['toasts'] = [];
  const saves = { chat: 0, settings: 0, meta: 0 };
  const raw: Fake['raw'] = { calls: [], impl: async () => '안녕하세요.' };
  const requests: any[] = [];
  const chat: any[] = opts.chat ?? [];
  let chatId = opts.chatId;
  const ctx: any = {
    chat,
    getCurrentChatId: () => chatId,
    chatMetadata: opts.meta ?? {},
    saveMetadataDebounced: () => { saves.meta++; },
    extensionSettings: {
      disabledExtensions: opts.disabled ?? [],
      connectionManager: { profiles: opts.profiles ?? [], selectedProfile: opts.selectedProfile },
      ...(opts.settings ?? {}),
    },
    saveSettingsDebounced: () => { saves.settings++; },
    saveChat: async () => { saves.chat++; },
    eventSource: { on() {}, removeListener() {}, emit() {} },
    eventTypes: {},
    messageFormatting: (s: string) => s,
    updateMessageBlock: () => {},
    generateRaw: (p: any) => { raw.calls.push(p); return raw.impl(p); },
    extractMessageFromData: (j: any) => j?.choices?.[0]?.message?.content ?? j?.content?.[0]?.text ?? j?.candidates?.[0]?.content?.parts?.[0]?.text ?? j?.choices?.[0]?.text ?? '',
    uuidv4: () => crypto.randomUUID(),
    ConnectionManagerRequestService: {
      getSupportedProfiles: () => ctx.extensionSettings.connectionManager.profiles,
      getProfile: (id: string) => ctx.extensionSettings.connectionManager.profiles.find((p: any) => p.id === id),
      validateProfile: () => ({ selected: 'openai' }),
      sendRequest: async (id: string, messages: any[], maxTokens: number, custom: any, override: any) => {
        requests.push({ id, messages, maxTokens, custom, override });
        return { choices: [{ message: { content: `번역:${id}` }, finish_reason: 'stop' }] };
      },
    },
  };
  (globalThis as any).SillyTavern = { getContext: () => ctx };
  (globalThis as any).toastr = Object.fromEntries(['info', 'warning', 'error', 'success'].map((k) => [k, (text: string) => { toasts.push({ kind: k, text }); return {}; }]));
  resetWarnings();
  loadStore();
  return {
    ctx, toasts, saves, raw, requests,
    switchChat(id, messages = [], meta = {}) {
      chatId = id;
      chat.length = 0;
      chat.push(...messages);
      ctx.chatMetadata = meta;
      loadStore();
    },
  };
}

export const msg = (mes: string, extra: Partial<Record<string, unknown>> = {}) => ({ name: 'Char', is_user: false, is_system: false, mes, ...extra });
