// Settings persistence. Global part: extensionSettings.st_translator. Per-chat part: chatMetadata.st_translator.
// The in-memory Store always holds only the open chat's own settings in `chats`.

import { BUILTIN_IDS, presetSummaries } from '../presets';
import { deleteBundle as removeBundle, saveBundle as upsertBundle } from '../bundles';
import {
  type ChatSettings,
  type CompatSettings,
  INHERIT_PRESET_ID,
  METADATA_KEY,
  normalizeCompat,
  normalizeSettings,
  normalizeStore,
  normalizeView,
  settingsFor,
  type Store,
  type UserBundle,
  type UserPreset,
  type ViewSettings,
} from '../shared';
import type { ChangeReason } from './api';
import { ctx, currentChatId } from './host';

let store: Store = normalizeStore(null);
const listeners = new Set<(reason: ChangeReason) => void>();

export function onChange(listener: (reason: ChangeReason) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(reason: ChangeReason): void {
  for (const l of [...listeners]) {
    try {
      l(reason);
    } catch (e) {
      console.error('[st-translator] listener failed', e);
    }
  }
}

/** Rebuilds the in-memory store from the host (startup and every chat change). */
export function loadStore(): Store {
  const c = ctx();
  const globalPart = (c.extensionSettings?.[METADATA_KEY] ?? {}) as Record<string, unknown>;
  const chatId = currentChatId();
  const meta = c.chatMetadata?.[METADATA_KEY];
  const hasMeta = !!meta && typeof meta === 'object';
  store = globalConnection(normalizeStore({ ...globalPart, chats: chatId && hasMeta ? { [chatId]: meta } : {} }));
  return store;
}

/** The connection is global (store.defaults only): a per-chat copy is dropped. */
function globalConnection(s: Store): Store {
  for (const id of Object.keys(s.chats)) s.chats[id] = { ...s.chats[id]!, connectionId: '' };
  return s;
}

export function getStore(): Store {
  return store;
}

export function chatId(): string | null {
  return currentChatId();
}

export function settings(): ChatSettings {
  return settingsFor(store, chatId());
}

export function connectionId(): string {
  return store.defaults.connectionId;
}

function persistGlobal(): void {
  const c = ctx();
  const { view, compat, userPresets, userBundles, defaults } = store;
  c.extensionSettings[METADATA_KEY] = { version: 1, view, compat, userPresets, userBundles, defaults };
  c.saveSettingsDebounced();
}

function persistChat(): void {
  const id = chatId();
  const own = id ? store.chats[id] : undefined;
  if (!own) return;
  const c = ctx();
  c.chatMetadata[METADATA_KEY] = own;
  c.saveMetadataDebounced();
}

function commit(change: (s: Store) => void): void {
  change(store);
  store = globalConnection(normalizeStore(store));
  persistGlobal();
  persistChat();
  emit('store');
}

export function chatChanged(): void {
  loadStore();
  emit('chat');
}

export function saveConnection(connectionIdValue: string): void {
  const id = typeof connectionIdValue === 'string' ? connectionIdValue.trim() : '';
  commit((s) => {
    s.defaults = { ...s.defaults, connectionId: id };
  });
}

export function saveSettings(value: ChatSettings, asDefault: boolean): void {
  commit((s) => {
    // The connection is global and saved by saveConnection only: whatever the form carries is ignored.
    const next = normalizeSettings({ ...value, connectionId: s.defaults.connectionId }, s.defaults, s.userBundles);
    const cid = chatId();
    if (cid) s.chats[cid] = { ...next, connectionId: '' };
    if (asDefault || !cid) s.defaults = next;
  });
}

export function saveCompat(compat: CompatSettings): void {
  commit((s) => {
    s.compat = normalizeCompat(compat);
  });
}

export function compat(): CompatSettings {
  return store.compat;
}

export function saveView(view: ViewSettings): void {
  commit((s) => {
    s.view = normalizeView(view);
  });
}

function newId(): string {
  const c = ctx();
  return `custom-${c.uuidv4 ? c.uuidv4() : crypto.randomUUID()}`;
}

export function savePreset(preset: UserPreset): string {
  const id = typeof preset.id === 'string' && preset.id.startsWith('custom-') ? preset.id : newId();
  if (BUILTIN_IDS.has(id)) throw new Error('기본 프리셋은 수정할 수 없습니다.');
  if (!preset.name?.trim() || !preset.prompt?.trim()) throw new Error('프리셋 이름과 프롬프트를 입력해 주세요.');
  const saved = { id, name: preset.name.trim(), prompt: preset.prompt };
  commit((s) => {
    const i = s.userPresets.findIndex((p) => p.id === id);
    if (i >= 0) s.userPresets[i] = saved;
    else s.userPresets.push(saved);
  });
  return id;
}

export function deletePreset(id: string): void {
  commit((s) => {
    s.userPresets = s.userPresets.filter((p) => p.id !== id);
    for (const x of [s.defaults, ...Object.values(s.chats)]) {
      if (x.incomingPresetId === id) x.incomingPresetId = INHERIT_PRESET_ID;
      if (x.outgoingPresetId === id) x.outgoingPresetId = INHERIT_PRESET_ID;
    }
  });
}

export function saveBundle(bundle: UserBundle): string {
  let id = '';
  commit((s) => {
    id = upsertBundle(s, bundle).id;
  });
  return id;
}

export function deleteBundle(id: string): void {
  commit((s) => removeBundle(s, id));
}

export function presets() {
  return presetSummaries(store.userPresets);
}
