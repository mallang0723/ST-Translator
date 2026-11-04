// Extension entry: wires the runtime to SillyTavern events once the app is ready.

import { applyFontVars, decorate, decorateAll, mountDisplay } from './st/display';
import { ctx } from './st/host';
import { syncDraftButton, onMessageSent } from './st/input';
import { onMessageEdited, onMessageReceived, onMessageSwiped, onMessageUpdated } from './st/events';
import { abortJobsExcept, abortJobsOfDeletedSwipes } from './st/jobs';
import { createApi } from './st/runtime';
import { mountSettings } from './st/settings-ui';
import { chatChanged, loadStore, onChange, chatId } from './st/store';
import { addButtonsEverywhere, mountToolbar } from './st/toolbar';

let started = false;

function init(): void {
  if (started) return;
  started = true;
  const c = ctx();
  const { eventSource: es, eventTypes: ev } = c;
  loadStore();
  const api = createApi();
  mountSettings(api);
  mountToolbar();
  mountDisplay();
  applyFontVars();
  syncDraftButton();
  onChange((reason) => {
    syncDraftButton();
    if (reason === 'chat') applyFontVars();
  });

  const idArg = (fn: (id: number) => void) => (id: unknown) => {
    if (typeof id === 'number') fn(id);
  };
  for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED'] as const) es.on(ev[name]!, idArg((id) => decorate(id)));
  // Edits, swipes and updates recompute our display_text (stale owned text is removed) and redraw it.
  es.on(ev.MESSAGE_UPDATED!, idArg(onMessageUpdated));
  es.on(ev.MESSAGE_EDITED!, idArg(onMessageEdited));
  es.on(ev.MESSAGE_SWIPED!, idArg(onMessageSwiped));
  es.on(ev.MESSAGE_SWIPE_DELETED!, (payload: unknown) => abortJobsOfDeletedSwipes(payload as { messageId?: unknown; swipeId?: unknown }));
  for (const name of ['MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED'] as const) es.on(ev[name]!, () => { addButtonsEverywhere(); decorateAll(); });
  es.on(ev.CHAT_CHANGED!, () => {
    abortJobsExcept(chatId());
    chatChanged();
    addButtonsEverywhere();
    decorateAll();
    setTimeout(decorateAll, 300);
  });
  // The event handlers are awaited by ST: automatic translation must not block generation.
  es.on(ev.MESSAGE_RECEIVED!, (id: unknown, type: unknown) => {
    if (typeof id === 'number') onMessageReceived(id, typeof type === 'string' ? type : undefined);
  });
  es.on(ev.MESSAGE_SENT!, (id: unknown) => (typeof id === 'number' ? onMessageSent(id) : undefined));
  decorateAll();
}

const st = (globalThis as { SillyTavern?: { getContext(): { eventSource: { on(e: string, h: () => void): void }; eventTypes: Record<string, string> } } }).SillyTavern;
if (st) {
  const { eventSource, eventTypes } = st.getContext();
  // ST's event source re-fires APP_READY for late subscribers.
  eventSource.on(eventTypes.APP_READY!, init);
}
