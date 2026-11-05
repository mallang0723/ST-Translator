// Translation jobs: translate / continue / cancel a message, automatic translation, outgoing text.
// Jobs hold message objects (never indexes), check the chat id before saving, and stop when the
// chat changes or the message disappears.

import { promptPresets } from '../presets';
import { friendlyError } from '../connection';
import { clearTranslation, recordFor, recordKeyFor, skipFresh } from '../message-ui';
import {
  type ChatSettings,
  type MessageView,
  CANCELLED_MESSAGE,
  isCancelledRecord,
  rawSourceHash,
  recordHasMore,
  settingsFor,
  sourceHash,
  type TranslationRecord,
} from '../shared';
import { loreveilConfig } from '../compat';
import { type Completion, recordToText, translate, TranslationError } from '../translate/engine';
import type { ContextMessage, Direction } from '../translate/prompt';
import { ExcludeRuleError } from '../translate/protect';
import { createCompleter, innermostError, isAbortError } from './complete';
import { ctx, currentChatId, indexOfMessage, toast, type STMessage } from './host';
import { cancelScheduledSave, currentSwipe, readTranslations, saveChatIfCurrent, setHiddenEverywhere, updateTranslations } from './records';
import { connectionId, getStore, settings as currentSettings } from './store';

interface Job {
  chatId: string;
  controller: AbortController;
  finished: Promise<void>;
  /** Aborted because the chat changed or the message went away: no toast. */
  silent: boolean;
  message: STMessage;
  swipe: SwipeRef;
}

/**
 * Identifies the swipe a job belongs to. SillyTavern replaces swipe_info objects at will, so identity
 * is the index at job start (`start`, kept in step with MESSAGE_SWIPE_DELETED) checked against the
 * source hash of the swipe text, which finds the swipe again if the index was shifted unseen.
 */
interface SwipeRef {
  start: number;
  hash: string | null;
  /** The swipe was deleted (MESSAGE_SWIPE_DELETED). */
  deleted: boolean;
}

function captureSwipe(message: STMessage): SwipeRef {
  // The job translates message.mes, which is the visible swipe's text (swipes[] may lag behind it, e.g. Continue).
  return { start: currentSwipe(message), hash: typeof message.mes === 'string' ? sourceHash(message.mes) : null, deleted: false };
}

/** Current index of the job's swipe; -1 when that swipe is gone or cannot be found any more. */
export function resolveSwipe(message: STMessage, ref: SwipeRef): number {
  if (ref.deleted) return -1;
  const swipes = message.swipes;
  if (!Array.isArray(swipes)) return ref.start;
  if (ref.hash === null) return ref.start < swipes.length ? ref.start : -1;
  const matches = (i: number) => typeof swipes[i] === 'string' && sourceHash(swipes[i]!) === ref.hash;
  if (matches(ref.start)) return ref.start;
  let best = -1;
  for (let i = 0; i < swipes.length; i++) {
    if (matches(i) && (best < 0 || Math.abs(i - ref.start) < Math.abs(best - ref.start))) best = i;
  }
  if (best >= 0) return best;
  // No swipe has the job's text yet: ST updates swipes[] after MESSAGE_RECEIVED on a non-streamed
  // Continue, or the user edited the text mid-job. Deletions are tracked by MESSAGE_SWIPE_DELETED, so
  // the start index is still the job's swipe. Records are keyed by source hash, so a record written for
  // edited text is never shown for the new text.
  return ref.start < swipes.length ? ref.start : -1;
}

const jobs = new WeakMap<STMessage, Job>();
const running = new Set<Job>();

class MessageGoneError extends Error {
  constructor() {
    super('메시지가 삭제되었습니다.');
    this.name = 'MessageGoneError';
  }
}

// ---- view updates ----

const viewListeners = new Set<(message: STMessage, swipe?: number) => void>();

/** Called on start, on every progress step and at the end of a job (and after record edits). */
export function onViewUpdate(listener: (message: STMessage, swipe?: number) => void): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** `swipe` = the swipe the change belongs to, when it may not be the visible one. */
export function emitView(message: STMessage, swipe?: number): void {
  for (const l of [...viewListeners]) {
    try {
      l(message, swipe);
    } catch (e) {
      console.error('[st-translator] view listener failed', e);
    }
  }
}

export function isBusy(message: STMessage): boolean {
  return jobs.has(message);
}

/** A job of this message is running on the visible swipe ('here') or on another one ('elsewhere'). */
export function busyKind(message: STMessage): 'none' | 'here' | 'elsewhere' {
  const job = jobs.get(message);
  if (!job) return 'none';
  return resolveSwipe(message, job.swipe) === currentSwipe(message) ? 'here' : 'elsewhere';
}

export function roleOf(message: STMessage): 'user' | 'assistant' | 'system' {
  return message.is_user ? 'user' : message.is_system ? 'system' : 'assistant';
}

export function viewOf(message: STMessage, index = indexOfMessage(message)): MessageView {
  const mt = readTranslations(message);
  const content = message.mes ?? '';
  const record = recordFor(mt, content);
  const kind = busyKind(message);
  return {
    messageId: String(index),
    sourceKey: recordKeyFor(mt, content) ?? sourceHash(content),
    role: roleOf(message),
    text: record && record.parts.some((p) => p.trim()) ? recordToText(record, content) : null,
    status: record?.status ?? null,
    hasMore: record ? recordHasMore(record) : false,
    progress: record && record.total > 1 ? { done: record.parts.length, total: record.total } : null,
    error: record?.error ?? null,
    hidden: mt?.hidden === true,
    busy: kind === 'here',
    busyElsewhere: kind === 'elsewhere',
    cancelled: isCancelledRecord(record),
    index,
    name: typeof message.name === 'string' ? message.name : '',
  };
}

// ---- helpers ----

export function errorText(e: unknown, signal?: AbortSignal): string {
  if (isAbortError(e, signal)) return CANCELLED_MESSAGE;
  const inner = innermostError(e);
  return friendlyError(inner instanceof Error ? inner.message : typeof inner === 'string' ? inner : String((inner as { message?: unknown } | null)?.message ?? inner));
}

/** Messages before index `end` that can serve as previous context, with their saved translations. */
export function contextBefore(messages: STMessage[], end: number): ContextMessage[] {
  return messages
    .slice(0, end)
    .filter((m) => !m.is_system && typeof m.mes === 'string')
    .map((m) => {
      const entry = recordFor(readTranslations(m), m.mes);
      return { role: m.is_user ? ('user' as const) : ('assistant' as const), content: m.mes, translation: entry && entry.parts.length ? recordToText(entry) : null };
    });
}

export interface TranslationOptions {
  force: boolean;
  automatic: boolean;
}

// ---- translate / continue ----

export async function translateMessage(chatId: string, message: STMessage, mode: 'fresh' | 'continue', options: TranslationOptions): Promise<void> {
  // A new generation can finish on the same message while its old swipe is translating.
  while (jobs.has(message)) {
    if (!options.automatic) {
      toast('info', '이 메시지는 이미 번역 중입니다.');
      return;
    }
    await jobs.get(message)!.finished;
  }
  if (currentChatId() !== chatId) return;

  const controller = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  // The record belongs to the swipe that was translated, even if the user swipes away or deletes another swipe meanwhile.
  const swipe = captureSwipe(message);
  const job: Job = { chatId, controller, finished, silent: false, message, swipe };
  jobs.set(message, job);
  running.add(job);
  let source: string | undefined;
  let unhid = false;
  /** Writes into the job's own swipe (found by index + source hash); dropped when that swipe was deleted. */
  const put = async (final: boolean, change: (m: { entries: Record<string, TranslationRecord>; hidden?: boolean }) => void): Promise<void> => {
    const at = resolveSwipe(message, swipe);
    if (at < 0) return;
    if (!unhid) {
      // "Hidden" belongs to the whole message: a translation in progress shows again on every swipe.
      unhid = true;
      setHiddenEverywhere(message, false);
    }
    await updateTranslations(chatId, message, change, final, at);
    if (!final) emitView(message, at);
  };
  try {
    const store = getStore();
    const settings = currentSettings();
    if (options.automatic && !settings.autoTranslate) return;
    const chat = ctx().chat;
    const index = chat.indexOf(message);
    if (index < 0) return;
    if (options.automatic && (message.is_user || message.is_system)) return;
    source = message.mes;
    if (typeof source !== 'string' || !source.trim()) return;
    const hash = sourceHash(source);
    const mt = readTranslations(message);
    const existingKey = recordKeyFor(mt, source);
    const existing = existingKey ? mt?.entries[existingKey] : undefined;
    if (skipFresh(mode, existing, options.force)) return;
    emitView(message, resolveSwipe(message, swipe));

    const write = (mt2: { entries: Record<string, TranslationRecord>; hidden?: boolean }, record: TranslationRecord) => {
      if (existingKey) delete mt2.entries[existingKey];
      delete mt2.entries[rawSourceHash(source!)];
      mt2.entries[hash] = record;
    };

    const record = await translate(
      {
        direction: 'incoming',
        source,
        settings,
        store,
        presets: promptPresets(store.userPresets),
        previous: contextBefore(chat, index),
        resume: mode === 'continue' ? existing : undefined,
      },
      {
        complete: createCompleter({ chosenId: connectionId(), maxTokens: settings.maxTokens, signal: controller.signal }),
        signal: controller.signal,
        onProgress: async (progress) => {
          if (indexOfMessage(message) < 0) {
            job.silent = true;
            controller.abort();
            throw new MessageGoneError();
          }
          await put(false, (m) => write(m, progress));
        },
      },
    );
    if (indexOfMessage(message) < 0) return;
    await put(true, (m) => write(m, record));
    if (record.status === 'partial' && !options.automatic) toast('info', '번역이 중간에 끊겼습니다. "이어서 번역"을 누르면 이어서 번역합니다.');
  } catch (e) {
    if (e instanceof MessageGoneError || indexOfMessage(message) < 0) return;
    const text = errorText(e, controller.signal);
    const cancelled = text === CANCELLED_MESSAGE;
    const partial = e instanceof TranslationError ? e.record : null;
    if (source !== undefined) {
      const hash = sourceHash(source);
      try {
        await put(true, (m) => {
          const prev = m.entries[hash];
          const base = partial ?? prev ?? { parts: [], pieces: [], total: 1, truncatedPart: -1, status: 'error' as const, updatedAt: 0 };
          m.entries[hash] = { ...base, status: 'error', error: text, updatedAt: Date.now() };
          if (cancelled) m.entries[hash]!.cancelled = true;
          else delete m.entries[hash]!.cancelled;
        });
      } catch {
        // saving the error is best effort
      }
    }
    if (!job.silent) toast('error', `번역 실패: ${text}`);
  } finally {
    jobs.delete(message);
    running.delete(job);
    try {
      const at = resolveSwipe(message, swipe);
      if (at >= 0) emitView(message, at);
      else emitView(message);
    } finally {
      finish();
    }
  }
}

/**
 * MESSAGE_SWIPE_DELETED ({messageId, swipeId}, emitted after the splice): jobs of that message on a
 * higher swipe move down by one; a job on the deleted swipe is aborted and its result dropped.
 */
export function abortJobsOfDeletedSwipes(payload?: { messageId?: unknown; swipeId?: unknown; newSwipeId?: unknown }): void {
  const messageId = Number(payload?.messageId);
  const swipeId = Number(payload?.swipeId);
  if (!Number.isInteger(messageId) || !Number.isInteger(swipeId)) return;
  const message = ctx().chat[messageId];
  if (!message) return;
  for (const job of running) {
    if (job.message !== message || job.swipe.deleted) continue;
    const ref = job.swipe;
    if (ref.start > swipeId) ref.start -= 1;
    else if (ref.start === swipeId) {
      ref.deleted = true;
      job.silent = true;
      job.controller.abort();
    }
  }
}

/** Message by chat index; null when it does not exist. */
export function messageAt(id: number): STMessage | null {
  return ctx().chat[id] ?? null;
}

export async function translateAt(id: number, force: boolean): Promise<void> {
  const chatId = currentChatId();
  const message = messageAt(id);
  if (!chatId || !message) return;
  await translateMessage(chatId, message, 'fresh', { force, automatic: false });
}

export async function continueAt(id: number): Promise<void> {
  const chatId = currentChatId();
  const message = messageAt(id);
  if (!chatId || !message) return;
  await translateMessage(chatId, message, 'continue', { force: true, automatic: false });
}

export function cancelMessage(message: STMessage): void {
  jobs.get(message)?.controller.abort();
}

/** Aborts every job of chats other than `keepChatId` (chat switch). */
export function abortJobsExcept(keepChatId: string | null): void {
  for (const job of running) {
    if (job.chatId !== keepChatId) {
      job.silent = true;
      job.controller.abort();
    }
  }
}

export function setHidden(message: STMessage, hidden: boolean): void {
  const chatId = currentChatId();
  setHiddenEverywhere(message, hidden);
  if (chatId) void saveChatIfCurrent(chatId).catch(() => {});
  emitView(message);
}

/**
 * Deletes the translation of the given swipe key (default: the visible swipe). A job running on that
 * same swipe is stopped first; a job on another swipe is left alone.
 */
export async function deleteTranslation(message: STMessage, sourceKey?: string): Promise<void> {
  const chatId = currentChatId();
  let target = currentSwipe(message);
  if (busyKind(message) === 'here') {
    const job = jobs.get(message)!;
    job.controller.abort();
    await job.finished;
    // The user may have swiped or deleted another swipe meanwhile: find the swipe again.
    target = resolveSwipe(message, job.swipe);
    if (target < 0) return;
  }
  if (!chatId || indexOfMessage(message) < 0) return;
  const textOf = (m: STMessage) => (target === currentSwipe(m) ? m.mes : m.swipes?.[target] ?? m.mes) ?? '';
  await updateTranslations(chatId, message, (mt, m) => clearTranslation(mt, sourceKey || recordKeyFor(mt, textOf(m)) || sourceHash(textOf(m))), true, target);
  emitView(message, target);
}

// ---- automatic translation ----

const SKIPPED_TYPES = new Set(['impersonate', 'first_message']);

/** MESSAGE_RECEIVED handler body. Resolves when the job ends; the event handler must not await it. */
export async function autoTranslate(id: number, type?: string): Promise<void> {
  if (type && SKIPPED_TYPES.has(type)) return;
  const chatId = currentChatId();
  const message = messageAt(id);
  if (!chatId || !message || message.is_user || message.is_system) return;
  if (!currentSettings().autoTranslate) return;
  await translateMessage(chatId, message, 'fresh', { force: false, automatic: true }).catch((e) => console.warn('[st-translator] auto translate failed', e));
}

// ---- outgoing ----

/** Translates text into the model language. `end` = number of chat messages to use as context. */
export async function translateOutgoing(chatId: string | null, text: string, end?: number): Promise<string> {
  const store = getStore();
  const settings: ChatSettings = { ...currentSettings(), autoContinue: true };
  const chat = ctx().chat;
  const previous = settings.contextEnabled && settings.contextIncludeUserInput ? contextBefore(chat, end ?? chat.length) : [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const record = await translate(
      { direction: 'outgoing' as Direction, source: text, settings, store, presets: promptPresets(store.userPresets), previous, loreveil: store.compat.loreveil ? loreveilConfig(ctx().extensionSettings?.loreVeil) : null },
      { complete: createCompleter({ chosenId: connectionId(), maxTokens: settings.maxTokens, signal: controller.signal }) as (r: never) => Promise<Completion> },
    );
    if (record.status !== 'done') throw new Error('번역이 끝까지 되지 않았습니다.');
    const out = recordToText(record).trim();
    if (!out) throw new Error('번역 결과가 비어 있습니다.');
    return out;
  } catch (e) {
    throw e instanceof ExcludeRuleError ? e : new Error(errorText(e));
  } finally {
    clearTimeout(timer);
  }
}

export function translateText(text: string): Promise<string> {
  return translateOutgoing(currentChatId(), text);
}

export { cancelScheduledSave, settingsFor };
