// Types, defaults and messages shared by the backend and frontend.

import { migrateStore } from './migrations';
import { normalizeIllustrations } from './illustrations';
import { lenientTags } from './translate/protect';

/**
 * below: original, then translation. above: translation, then original. only: translation alone.
 * collapsed: original with a folded translation. collapsed-source: translation with a folded original.
 * paragraph: paragraph-by-paragraph comparison.
 */
export type DisplayMode = 'below' | 'above' | 'only' | 'collapsed' | 'collapsed-source' | 'paragraph';
export const DISPLAY_MODES: readonly DisplayMode[] = ['below', 'above', 'only', 'collapsed', 'collapsed-source', 'paragraph'];
/** Paragraph view, interleaved: which of the pair comes first. */
export type ParagraphOrder = 'source-first' | 'translation-first';
/** 'whole': one request per message. 'paragraph': one request per paragraph (exact pairs). */
export type TranslationUnit = 'whole' | 'paragraph';
/** Paragraph view: original and translation interleaved, or translation with the original on tap. */
export type ParagraphView = 'interleave' | 'tap';

/** Per-chat translation settings: Marinara's chat translation section plus Translation Tools 1.5.4. */
export interface ChatSettings {
  /** Lumiverse connection used for translation. '' = the user's active connection. */
  connectionId: string;
  /** "Model Language": outgoing messages are translated into this language. */
  modelLanguage: string;
  /** "My Language": incoming responses are translated into this language. */
  myLanguage: string;
  outgoingPresetId: string;
  incomingPresetId: string;
  /** Chat prompts used when the preset is "채팅 설정 유지" (builtin-inherit). Empty = the default translation prompt (BASE_PROMPT). */
  outgoingPrompt: string;
  incomingPrompt: string;
  /** Translate my messages into the model language before sending (stored translated, like Marinara). */
  translateMyMessages: boolean;
  /** Translate button beside the chat input. */
  showDraftButton: boolean;
  /** Translate AI responses after generation. */
  autoTranslate: boolean;
  displayMode: DisplayMode;
  translationUnit: TranslationUnit;
  /** Continue automatically when a translation stops early. */
  autoContinue: boolean;
  /** Sources at least this long are translated paragraph group by group. 0 = never split. */
  longSplitChars: number;
  /** Keep HTML tags, attributes, <style>/<script> and comments; translate only the text between tags. */
  protectHtml: boolean;
  /** Keep fenced code blocks untranslated. */
  protectCode: boolean;
  /**
   * Parts that are never translated, one rule per line:
   *   <status>          the whole <status ...>...</status> element
   *   /regex/flags      every match
   *   start ... end     from "start" through the next "end"
   */
  excludeRules: string;
  /** Tag names (comma separated) whose whole element is never sent for translation. <style>/<script> are always kept. */
  excludeTags: string;
  /** Marks settings already migrated to explicit excluded tags. */
  excludeTagsVersion?: 1;
  /** Shared translation guide bundle. '' = none; the following text fields are room additions. */
  bundleId: string;
  // Translation Tools 1.5.4 per-chat scope
  glossary: string;
  freeContextEnabled: boolean;
  freeContext: string;
  incomingVoiceEnabled: boolean;
  incomingVoicePrompt: string;
  contextEnabled: boolean;
  contextIncludeOriginal: boolean;
  contextIncludeTranslation: boolean;
  contextIncludeUserInput: boolean;
  contextMessageCount: number;
  /** Max output tokens per translation request (SillyTavern needs an explicit value). */
  maxTokens: number;
}

export interface UserPreset {
  id: string;
  name: string;
  prompt: string;
}

export interface UserBundle {
  id: string;
  name: string;
  glossary: string;
  freeContext: string;
  incomingVoicePrompt: string;
}

/** Paragraph view settings, shared by every chat (like Paragraph Reader). */
export interface ViewSettings {
  paragraphView: ParagraphView;
  /** Order inside each interleaved pair. */
  paragraphOrder: ParagraphOrder;
  sourceFontSize: number;
  translationFontSize: number;
}

export const FONT_MIN = 12;
export const FONT_MAX = 32;
export const DEFAULT_VIEW: ViewSettings = { paragraphView: 'interleave', paragraphOrder: 'source-first', sourceFontSize: 16, translationFontSize: 18 };

export function fontSize(value: unknown, fallback: number): number {
  const n = Number(value);
  return value === null || value === '' || !Number.isFinite(n) ? fallback : Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

export function normalizeView(value: unknown): ViewSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<ViewSettings>;
  return {
    paragraphView: v.paragraphView === 'tap' ? 'tap' : 'interleave',
    paragraphOrder: v.paragraphOrder === 'translation-first' ? 'translation-first' : 'source-first',
    sourceFontSize: fontSize(v.sourceFontSize, DEFAULT_VIEW.sourceFontSize),
    translationFontSize: fontSize(v.translationFontSize, DEFAULT_VIEW.translationFontSize),
  };
}

/** Global switches for living next to LoreVeil and Tavern Helper. */
export interface CompatSettings {
  /** Keep LoreVeil tags and markers byte-identical in my translated messages. */
  loreveil: boolean;
  /** Show excluded and code blocks once in two-sided display modes. */
  singleInstance: boolean;
  /** Ask Tavern Helper to re-render a message after we rewrite its block. */
  thRerender: boolean;
  debug: boolean;
}

export const DEFAULT_COMPAT: CompatSettings = { loreveil: true, singleInstance: true, thRerender: true, debug: false };

export function normalizeCompat(value: unknown): CompatSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof CompatSettings, unknown>>;
  const flag = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
  return {
    loreveil: flag(v.loreveil, DEFAULT_COMPAT.loreveil),
    singleInstance: flag(v.singleInstance, DEFAULT_COMPAT.singleInstance),
    thRerender: flag(v.thRerender, DEFAULT_COMPAT.thRerender),
    debug: flag(v.debug, DEFAULT_COMPAT.debug),
  };
}

export interface Store {
  version: 1;
  /** Tags to migrate into old chat metadata when those chats are opened later. */
  legacyExcludeTags?: string;
  view: ViewSettings;
  compat: CompatSettings;
  userPresets: UserPreset[];
  userBundles: UserBundle[];
  /** Settings for chats that have none of their own yet. */
  defaults: ChatSettings;
  chats: Record<string, ChatSettings>;
}

export const CONTEXT_MESSAGE_COUNT_MIN = 1;
export const CONTEXT_MESSAGE_COUNT_MAX = 10;
export const LONG_SPLIT_DEFAULT = 7000;
export const MAX_TOKENS_DEFAULT = 4096;
export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_MAX = 65536;
export const INHERIT_PRESET_ID = 'builtin-inherit';

export const DEFAULT_SETTINGS: ChatSettings = {
  connectionId: '',
  modelLanguage: 'English',
  myLanguage: 'Korean',
  outgoingPresetId: INHERIT_PRESET_ID,
  incomingPresetId: INHERIT_PRESET_ID,
  outgoingPrompt: '',
  incomingPrompt: '',
  translateMyMessages: false,
  showDraftButton: false,
  autoTranslate: false,
  displayMode: 'below',
  translationUnit: 'whole',
  autoContinue: true,
  longSplitChars: LONG_SPLIT_DEFAULT,
  protectHtml: true,
  protectCode: true,
  excludeRules: '',
  excludeTags: '',
  excludeTagsVersion: 1,
  bundleId: '',
  glossary: '',
  freeContextEnabled: false,
  freeContext: '',
  incomingVoiceEnabled: false,
  incomingVoicePrompt: '',
  contextEnabled: false,
  contextIncludeOriginal: true,
  contextIncludeTranslation: true,
  contextIncludeUserInput: false,
  contextMessageCount: 3,
  maxTokens: MAX_TOKENS_DEFAULT,
};

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function normalizeSettings(value: unknown, base: ChatSettings = DEFAULT_SETTINGS, bundles: readonly UserBundle[] = []): ChatSettings {
  const s = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const count = Number.parseInt(String(s.contextMessageCount ?? ''), 10);
  const split = Number.parseInt(String(s.longSplitChars ?? ''), 10);
  const maxTokens = Number.parseInt(String(s.maxTokens ?? ''), 10);
  const mode = s.displayMode;
  return {
    connectionId: str(s.connectionId, base.connectionId).trim(),
    modelLanguage: str(s.modelLanguage, base.modelLanguage).trim() || base.modelLanguage || DEFAULT_SETTINGS.modelLanguage,
    myLanguage: str(s.myLanguage, base.myLanguage).trim() || base.myLanguage || DEFAULT_SETTINGS.myLanguage,
    outgoingPresetId: str(s.outgoingPresetId, base.outgoingPresetId) || INHERIT_PRESET_ID,
    incomingPresetId: str(s.incomingPresetId, base.incomingPresetId) || INHERIT_PRESET_ID,
    outgoingPrompt: str(s.outgoingPrompt, base.outgoingPrompt),
    incomingPrompt: str(s.incomingPrompt, base.incomingPrompt),
    translateMyMessages: bool(s.translateMyMessages, base.translateMyMessages),
    showDraftButton: bool(s.showDraftButton, base.showDraftButton),
    autoTranslate: bool(s.autoTranslate, base.autoTranslate),
    displayMode: DISPLAY_MODES.includes(mode as DisplayMode) ? (mode as DisplayMode) : base.displayMode,
    translationUnit: s.translationUnit === 'paragraph' ? 'paragraph' : s.translationUnit === 'whole' ? 'whole' : base.translationUnit,
    autoContinue: bool(s.autoContinue, base.autoContinue),
    longSplitChars: Number.isFinite(split) ? Math.max(0, Math.min(200_000, split)) : base.longSplitChars,
    protectHtml: bool(s.protectHtml, base.protectHtml),
    protectCode: bool(s.protectCode, base.protectCode),
    excludeRules: str(s.excludeRules, base.excludeRules),
    excludeTags: lenientTags(str(s.excludeTags, base.excludeTags)).join(', '),
    excludeTagsVersion: 1,
    bundleId: typeof s.bundleId === 'string' && bundles.some((b) => b.id === s.bundleId) ? s.bundleId : '',
    glossary: str(s.glossary, base.glossary),
    freeContextEnabled: bool(s.freeContextEnabled, base.freeContextEnabled),
    freeContext: str(s.freeContext, base.freeContext),
    incomingVoiceEnabled: bool(s.incomingVoiceEnabled, base.incomingVoiceEnabled),
    incomingVoicePrompt: str(s.incomingVoicePrompt, base.incomingVoicePrompt),
    contextEnabled: bool(s.contextEnabled, base.contextEnabled),
    contextIncludeOriginal: bool(s.contextIncludeOriginal, base.contextIncludeOriginal),
    contextIncludeTranslation: bool(s.contextIncludeTranslation, base.contextIncludeTranslation),
    contextIncludeUserInput: bool(s.contextIncludeUserInput, base.contextIncludeUserInput),
    contextMessageCount: Number.isFinite(count)
      ? Math.min(CONTEXT_MESSAGE_COUNT_MAX, Math.max(CONTEXT_MESSAGE_COUNT_MIN, count))
      : base.contextMessageCount,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, maxTokens)) : base.maxTokens,
  };
}

export function normalizeStore(value: unknown): Store {
  const raw = migrateStore(value) as Partial<Store>;
  const userBundles: UserBundle[] = [];
  const bundleIds = new Set<string>();
  for (const b of Array.isArray(raw.userBundles) ? raw.userBundles : []) {
    if (!b || typeof b !== 'object') continue;
    const id = str(b.id, '').trim();
    const name = str(b.name, '').trim();
    if (!id || !name || bundleIds.has(id)) continue;
    bundleIds.add(id);
    userBundles.push({ id, name, glossary: str(b.glossary, ''), freeContext: str(b.freeContext, ''), incomingVoicePrompt: str(b.incomingVoicePrompt, '') });
  }
  const defaults = normalizeSettings(raw.defaults, DEFAULT_SETTINGS, userBundles);
  const chats: Record<string, ChatSettings> = {};
  if (raw.chats && typeof raw.chats === 'object') {
    for (const [chatId, s] of Object.entries(raw.chats)) if (chatId) chats[chatId] = normalizeSettings(s, defaults, userBundles);
  }
  const userPresets: UserPreset[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(raw.userPresets) ? raw.userPresets : []) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.id, '').trim();
    const name = str(p.name, '').trim();
    const prompt = str(p.prompt, '');
    if (!id || !name || !prompt.trim() || seen.has(id) || !id.startsWith('custom-')) continue;
    seen.add(id);
    userPresets.push({ id, name, prompt });
  }
  return { version: 1, ...(raw.legacyExcludeTags ? { legacyExcludeTags: raw.legacyExcludeTags } : {}), view: normalizeView(raw.view), compat: normalizeCompat(raw.compat), userPresets, userBundles, defaults, chats };
}

export function settingsFor(store: Store, chatId: string | null): ChatSettings {
  return chatId && store.chats[chatId] ? store.chats[chatId] : store.defaults;
}

/**
 * The connection used for translation. It is one global setting (store.defaults); a copy inside a
 * chat's own settings is ignored, so picking a connection once is enough for every chat.
 */
export function effectiveConnectionId(store: Store, _chatId?: string | null): string {
  return store.defaults.connectionId;
}

/** Stable across LV-Illust tag/image/status changes; ordinary prose edits keep separate records. */
export function sourceHash(text: string): string {
  return rawSourceHash(normalizeIllustrations(text));
}

/** Pre-0.3.4 key, retained for reading existing message metadata. */
export function rawSourceHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${text.length.toString(36)}`;
}

// ---- translation records (stored in message metadata) ----

export type TranslationStatus = 'done' | 'partial' | 'error';

export interface TranslationRecord {
  /** Translation of each source part, in order, with protected pieces still as ⟦n⟧ markers. */
  parts: string[];
  /** Protected pieces (markup, excluded parts) that the ⟦n⟧ markers stand for. */
  pieces: string[];
  /** How the source was split: 'paragraph' = parts[i] is the translation of paragraph i. */
  unit?: TranslationUnit;
  /** Number of source parts. */
  total: number;
  /** Index of a part that stopped early (output limit), or -1. */
  truncatedPart: number;
  status: TranslationStatus;
  error?: string;
  /** The user cancelled (stored with status 'error'); shown neutrally. Old records carry only the cancel message. */
  cancelled?: boolean;
  updatedAt: number;
}

export const CANCELLED_MESSAGE = '번역을 취소했습니다.';

/** A record that ended because the user cancelled (new flag, or the stored cancel message of old records). */
export function isCancelledRecord(r: Pick<TranslationRecord, 'status' | 'error' | 'cancelled'> | null | undefined): boolean {
  return !!r && r.status === 'error' && (r.cancelled === true || r.error === CANCELLED_MESSAGE);
}

export interface MessageTranslations {
  v: 1;
  /** Keyed by sourceHash(content); illustration replacements share a key, prose edits do not. */
  entries: Record<string, TranslationRecord>;
  /** Translation hidden for this message (show the original). */
  hidden?: boolean;
  /** sourceHash of the display_text this extension wrote (ownership marker; see st/display.ts). */
  display?: string;
}

export const METADATA_KEY = 'st_translator';

export function recordText(r: TranslationRecord): string {
  return r.parts.filter((p) => p.trim()).join('\n\n');
}

/** Whether the translation can be continued: a part stopped early or parts are missing. */
export function recordHasMore(r: TranslationRecord): boolean {
  return r.truncatedPart >= 0 || r.parts.length < r.total;
}

/** What the frontend shows for one message. */
export interface MessageView {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  /** Translation of the current content (the visible swipe), if any. */
  text: string | null;
  /** The visible swipe's actual storage key (normalized, or a legacy raw hash). */
  sourceKey: string;
  status: TranslationStatus | null;
  hasMore: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
  hidden: boolean;
  /** A translation is running on the visible swipe. */
  busy: boolean;
  /** A translation of this message is running, but on another swipe. */
  busyElsewhere?: boolean;
  /** The visible swipe's record ended by a user cancel. */
  cancelled?: boolean;
  /** Position in the chat (index_in_chat), for the "#225 name" label. */
  index: number;
  /** Speaker name of the message. */
  name: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  prompt: string;
  builtin: boolean;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  model: string;
  provider: string;
  isDefault?: boolean;
}

// frontend -> backend
export type ToBackend =
  | { type: 'hello' }
  | { type: 'hint'; chatId: string | null; activeId?: string; chatConnectionId?: string }
  | { type: 'save_connection'; chatId: string | null; connectionId: string }
  | { type: 'chat'; chatId: string }
  | { type: 'save_settings'; chatId: string | null; settings: ChatSettings; asDefault: boolean }
  | { type: 'save_preset'; preset: UserPreset }
  | { type: 'delete_preset'; id: string }
  | { type: 'save_bundle'; bundle: UserBundle }
  | { type: 'delete_bundle'; id: string }
  | { type: 'translate'; chatId: string; messageId: string; force: boolean }
  | { type: 'continue'; chatId: string; messageId: string }
  | { type: 'set_hidden'; chatId: string; messageId: string; hidden: boolean }
  /** `sourceKey` pins the swipe the user saw; without it the visible swipe's translation goes. */
  | { type: 'delete_translation'; chatId: string; messageId: string; sourceKey?: string }
  | { type: 'save_view'; view: ViewSettings }
  | { type: 'cancel'; chatId: string; messageId: string }
  | { type: 'translate_text'; reqId: string; chatId: string; text: string }
  | { type: 'notify'; kind: 'info' | 'warning' | 'error'; text: string };

// backend -> frontend
export type ToFrontend =
  | { type: 'state'; store: Store; presets: PresetSummary[]; connections: ConnectionSummary[] }
  | { type: 'views'; chatId: string; views: MessageView[]; replace: boolean }
  | { type: 'text_result'; reqId: string; ok: boolean; text?: string; error?: string };
