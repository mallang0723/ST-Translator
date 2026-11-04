// TranslatorApi implementation: the contract the settings UI codes against.

import type { TranslatorApi } from './api';
import { listConnections, activeProfileId } from './complete';
import { applyFontVars, refreshChat } from './display';
import { setUnsavedGuard } from './guard';
import { translateText } from './jobs';
import * as store from './store';

export function createApi(): TranslatorApi {
  return {
    getStore: store.getStore,
    chatId: store.chatId,
    settings: store.settings,
    presets: store.presets,
    connections: listConnections,
    activeConnectionId: activeProfileId,
    saveConnection: store.saveConnection,
    saveSettings(settings, asDefault) {
      store.saveSettings(settings, asDefault);
      refreshChat();
    },
    saveView(view) {
      store.saveView(view);
      applyFontVars();
      refreshChat();
    },
    saveCompat(compat) {
      store.saveCompat(compat);
      refreshChat();
    },
    savePreset: store.savePreset,
    deletePreset: store.deletePreset,
    saveBundle: store.saveBundle,
    deleteBundle: store.deleteBundle,
    translateText,
    setUnsavedGuard,
    onChange: store.onChange,
  };
}
