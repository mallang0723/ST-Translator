// Builds the translation request exactly the way Marinara Engine + Translation Tools 1.5.4 do:
//   system = preset prompt, glossary rule, free context, character voice (incoming only),
//            previous-context rule — with {{targetLanguage}} resolved; at most 200,000 characters
//   user   = "Translate the following text to <language>:\n\n" + glossary block + previous
//            context block + [Text to Translate] ... [End Text]; the reference text at most 50,000
// Ported from Marinara-Translation-Tools 1.5.4 extension.js (MIT, (c) 2026 minikkuen). The user message
// wording follows Marinara Engine (AGPL-3.0); see THIRD_PARTY_NOTICES.md.

import { normalizeIllustrations } from '../illustrations';

import { BASE_PROMPT } from '../presets/catalog';
import { effectiveGuides, type GuideLibrary } from '../bundles';
import { MARINARA_TRANSLATION_REFERENCE_PROMPTS, MARINARA_TRANSLATION_REFERENCE_RENDERERS } from '../presets/upstream/reference';
import { type ChatSettings, INHERIT_PRESET_ID } from '../shared';
import { MARKER_INSTRUCTION } from './protect';
import { parseGlossary } from './glossary';
export { parseGlossary } from './glossary';

export const SYSTEM_PROMPT_MAX = 200000;
export const TRANSLATION_TEXT_MAX = 50000;

export type Direction = 'incoming' | 'outgoing';

export class TranslationLimitError extends Error {
  constructor(public readonly field: 'systemPrompt' | 'text', public readonly length: number, public readonly limit: number) {
    const label = field === 'systemPrompt' ? '시스템 프롬프트' : '번역 본문과 참고 블록';
    super(`${label} ${length.toLocaleString('en-US')}자가 ${limit.toLocaleString('en-US')}자 제한을 초과하여 번역을 중단했습니다. 지침이나 참고 정보의 길이를 줄여 주세요. 내용은 잘라내지 않았습니다.`);
    this.name = 'TranslationLimitError';
  }
}

export interface PromptPreset {
  id: string;
  prompt: string;
  /** false for "채팅 설정 유지": the chat's own prompt is used instead. */
  replace: boolean;
}

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Saved translation of exactly this content, if any. */
  translation: string | null;
}

export interface TranslationRequest {
  system: string;
  user: string;
  hasContext: boolean;
}

export function glossarySection(raw: string, sourceText: string, targetLanguage: string): string {
  const pairs = parseGlossary(raw);
  if (!pairs.length) return '';
  const exact: string[] = [];
  const bidirectional: string[] = [];
  for (const pair of pairs) {
    const hasLeft = sourceText.includes(pair.left);
    const hasRight = sourceText.includes(pair.right);
    if (hasLeft && !hasRight) exact.push(`"${pair.left}" → "${pair.right}"`);
    else if (hasRight && !hasLeft) exact.push(`"${pair.right}" → "${pair.left}"`);
    else bidirectional.push(`"${pair.left}" ↔ "${pair.right}"`);
  }
  return MARINARA_TRANSLATION_REFERENCE_RENDERERS.glossary(targetLanguage, exact, bidirectional);
}

export function escapeContextValue(value: string): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function freeContextSection(raw: string): string {
  const context = raw.trim();
  if (!context) return '';
  return MARINARA_TRANSLATION_REFERENCE_RENDERERS.freeContext(escapeContextValue(context));
}

/** The base prompt for one direction: the preset's text, or the chat's own prompt for "채팅 설정 유지". */
export function directionPrompt(settings: ChatSettings, direction: Direction, presets: PromptPreset[]): string {
  const presetId = direction === 'incoming' ? settings.incomingPresetId : settings.outgoingPresetId;
  const preset = presets.find((p) => p.id === presetId) ?? presets.find((p) => p.id === INHERIT_PRESET_ID);
  const own = (direction === 'incoming' ? settings.incomingPrompt : settings.outgoingPrompt).trim();
  if (preset?.replace) return preset.prompt.trim();
  return own || BASE_PROMPT;
}

function formatContextMessage(message: ContextMessage, settings: ChatSettings): string {
  const parts: string[] = [];
  if (settings.contextIncludeOriginal && message.content) parts.push(`<original>${escapeContextValue(normalizeIllustrations(message.content))}</original>`);
  if (settings.contextIncludeTranslation && message.translation) parts.push(`<translation>${escapeContextValue(normalizeIllustrations(message.translation))}</translation>`);
  if (!parts.length) return '';
  return `<message role="${message.role}">\n${parts.join('\n')}\n</message>`;
}

export interface BuildInput {
  direction: Direction;
  /** Text to translate (already protected: markup replaced by ⟦n⟧ markers). */
  text: string;
  settings: ChatSettings;
  /** Shared guides; omitted by callers that only use room text. */
  store?: GuideLibrary;
  presets: PromptPreset[];
  /** Messages before the text, oldest first. Only the last contextMessageCount are used. */
  previous: ContextMessage[];
  /** Whether the text contains ⟦n⟧ markers. */
  hasMarkers: boolean;
}

export function buildTranslationRequest(input: BuildInput): TranslationRequest {
  const { direction, text, settings } = input;
  const guides = effectiveGuides(input.store ?? { userBundles: [] }, settings);
  const targetLanguage = direction === 'incoming' ? settings.myLanguage : settings.modelLanguage;
  const glossary = glossarySection(guides.glossary, text, targetLanguage);
  const glossaryPrefix = glossary ? `${glossary}\n\n` : '';
  const referenceText = glossary ? `${glossaryPrefix}[Text to Translate]\n${text}\n[End Text]` : text;
  if (referenceText.length > TRANSLATION_TEXT_MAX) throw new TranslationLimitError('text', referenceText.length, TRANSLATION_TEXT_MAX);

  let body = referenceText;
  let hasContext = false;
  const wantsContext =
    settings.contextEnabled &&
    (settings.contextIncludeOriginal || settings.contextIncludeTranslation) &&
    (direction === 'incoming' || settings.contextIncludeUserInput);
  if (wantsContext) {
    const previous = input.previous.slice(-settings.contextMessageCount);
    const prefix = `${glossaryPrefix}[Previous Context — Reference Only]\n\n`;
    const suffix = `\n\n[Text to Translate]\n${text}\n[End Text]`;
    let remaining = TRANSLATION_TEXT_MAX - prefix.length - suffix.length;
    const formatted: string[] = [];
    for (let index = previous.length - 1; index >= 0; index--) {
      const block = formatContextMessage(previous[index]!, settings);
      if (!block) continue;
      const cost = block.length + (formatted.length ? 2 : 0);
      if (cost > remaining) continue;
      formatted.unshift(block);
      remaining -= cost;
    }
    if (formatted.length) {
      body = `${prefix}${formatted.join('\n\n')}${suffix}`;
      hasContext = true;
    }
  }

  const sections = [directionPrompt(settings, direction, input.presets)];
  if (glossary) sections.push(MARINARA_TRANSLATION_REFERENCE_PROMPTS.glossary);
  const freeContext = freeContextSection(settings.freeContextEnabled ? guides.freeContext : '');
  if (freeContext) sections.push(freeContext);
  if (direction === 'incoming' && settings.incomingVoiceEnabled && guides.incomingVoicePrompt.trim()) {
    sections.push(MARINARA_TRANSLATION_REFERENCE_RENDERERS.characterVoice(guides.incomingVoicePrompt.trim()));
  }
  if (hasContext) sections.push(MARINARA_TRANSLATION_REFERENCE_PROMPTS.previousContext);
  if (input.hasMarkers) sections.push(MARKER_INSTRUCTION);
  const system = sections.filter(Boolean).join('\n\n').replaceAll('{{targetLanguage}}', targetLanguage.trim());
  if (system.length > SYSTEM_PROMPT_MAX) throw new TranslationLimitError('systemPrompt', system.length, SYSTEM_PROMPT_MAX);

  return { system, user: `Translate the following text to ${targetLanguage}:\n\n${body}`, hasContext };
}

/** Request that continues a translation that stopped early. */
export function buildContinuationRequest(base: TranslationRequest, partial: string, targetLanguage: string): TranslationRequest {
  const system =
    `${base.system}\n\nThe earlier translation of this text into ${targetLanguage} stopped before the end. ` +
    'Continue it: output only the remaining translation, starting exactly where [Translation So Far] stops. ' +
    'If it stops in the middle of a word, start with the rest of that word. ' +
    'Do not repeat anything already translated and do not add any commentary. ' +
    'If nothing remains to be translated, output nothing.';
  const user = `${base.user}\n\n[Translation So Far]\n${partial}\n[End Translation So Far]`;
  return { system, user, hasContext: base.hasContext };
}
