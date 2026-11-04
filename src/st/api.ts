// Contract between the runtime (store, jobs, display) and the settings UI.

import type { ChatSettings, CompatSettings, ConnectionSummary, PresetSummary, Store, UserBundle, UserPreset, ViewSettings } from '../shared';

import type { UnsavedGuard } from './guard';

export type { UnsavedGuard };
export type ChangeReason = 'store' | 'chat';

export interface TranslatorApi {
  /** Current store; `chats` holds only the open chat's own settings (if it has any). */
  getStore(): Store;
  chatId(): string | null;
  /** settingsFor(store, chatId) */
  settings(): ChatSettings;
  /** presetSummaries(store.userPresets) */
  presets(): PresetSummary[];
  /** SillyTavern connection profiles; [] when Connection Manager is off or has no profiles. */
  connections(): ConnectionSummary[];
  /** connectionManager.selectedProfile, if any. */
  activeConnectionId(): string | null;
  /** Saved immediately (no save button), like the original. */
  saveConnection(connectionId: string): void;
  saveSettings(settings: ChatSettings, asDefault: boolean): void;
  /** Saved immediately; re-renders the chat. */
  saveView(view: ViewSettings): void;
  /** Saved immediately; re-renders the chat. */
  saveCompat(compat: CompatSettings): void;
  /** Returns the saved id. Throws Error with a Korean message when invalid. */
  savePreset(preset: UserPreset): string;
  deletePreset(id: string): void;
  saveBundle(bundle: UserBundle): string;
  deleteBundle(id: string): void;
  /** Outgoing direction, for the draft button. Rejects with a Korean message. */
  translateText(text: string): Promise<string>;
  /**
   * The settings UI registers how to tell whether it has unsaved edits and how to save them; translate /
   * continue consult it first (null unregisters).
   */
  setUnsavedGuard(guard: UnsavedGuard | null): void;
  /** UI re-renders on these. Returns an unsubscribe function. */
  onChange(listener: (reason: ChangeReason) => void): () => void;
}
