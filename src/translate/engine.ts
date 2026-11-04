// Translation engine: protect → split → translate part by part → check markers → restore.
// A part cut off by the output limit is continued from where it stopped (automatically when
// autoContinue is on, otherwise when the user asks). Progress is reported after every part
// so a failure keeps what was already translated.

import { normalizeIllustrations, restoreCurrentIllustrations } from '../illustrations';

import type { ChatSettings, TranslationRecord } from '../shared';
import type { GuideLibrary } from '../bundles';
import { isTruncatedFinish, joinContinuation, splitForTranslation, TRANSLATION_CHUNK_CHARS } from './chunk';
import { cleanReply } from './clean-reply';
import {
  buildContinuationRequest,
  buildTranslationRequest,
  type ContextMessage,
  type Direction,
  type PromptPreset,
  type TranslationRequest,
} from './prompt';
import { hasNoText, splitParagraphs } from './paragraphs';
import { checkMarkers, protect, type ProtectOptions, restore } from './protect';

/** Compat protection added on top of the chat settings. */
export type ProtectExtra = Pick<ProtectOptions, 'autopic' | 'loreveil'>;

export const MAX_AUTO_CONTINUE = 4;
/** Most text pieces the marker fallback may translate one by one. */
export const MAX_FALLBACK_SEGMENTS = 40;

export interface Completion {
  text: string;
  /** Provider finish reason, if it reported one. */
  finishReason?: unknown;
}

export interface EngineDeps {
  complete(req: TranslationRequest): Promise<Completion>;
  /** Called after each step with the record so far. */
  onProgress?(record: TranslationRecord): Promise<void> | void;
  signal?: AbortSignal;
}

export interface EngineJob {
  direction: Direction;
  source: string;
  settings: ChatSettings;
  store?: GuideLibrary;
  presets: PromptPreset[];
  previous: ContextMessage[];
  /** Continue this record instead of starting over. */
  resume?: TranslationRecord;
  /** LoreVeil / AutoPic protection; omitted = off. */
  protectExtra?: ProtectExtra;
}

export class TranslationError extends Error {
  constructor(message: string, public readonly record: TranslationRecord | null) {
    super(message);
    this.name = 'TranslationError';
  }
}

export function recordToText(r: TranslationRecord, currentContent?: string): string {
  const text = restore(r.parts.map(cleanReply).filter((p) => p.trim()).join('\n\n'), r.pieces);
  return currentContent === undefined ? text : restoreCurrentIllustrations(text, currentContent);
}

/** The source parts that are translated one request each. */
export function partSources(protectedText: string, settings: ChatSettings): string[] {
  if (settings.translationUnit === 'paragraph') {
    const paragraphs = splitParagraphs(protectedText);
    return paragraphs.length ? paragraphs : [protectedText];
  }
  const long = settings.longSplitChars > 0 && protectedText.length >= settings.longSplitChars;
  return long ? splitForTranslation(protectedText, TRANSLATION_CHUNK_CHARS) : [protectedText];
}

function resumable(record: TranslationRecord | null | undefined, pieces: string[], total: number, settings: ChatSettings): record is TranslationRecord {
  return !!record && sameArray(record.pieces, pieces) && record.total === total && (record.unit ?? 'whole') === settings.translationUnit;
}

/** Requests still needed to translate `source` (parts already done in `record` are skipped). */
export function requestsNeeded(source: string, settings: ChatSettings, record: TranslationRecord | null | undefined, extra?: ProtectExtra): number {
  let prot;
  try {
    prot = protect(source, { ...settings, ...extra });
  } catch {
    return 0;
  }
  const sources = partSources(prot.text, settings);
  const start = resumable(record, prot.pieces, sources.length, settings) ? record.parts.length : 0;
  return sources.slice(start).filter((part) => !hasNoText(part)).length;
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => normalizeIllustrations(v) === normalizeIllustrations(b[i]!));
}

export async function translate(job: EngineJob, deps: EngineDeps): Promise<TranslationRecord> {
  const { settings } = job;
  const complete = async (request: TranslationRequest): Promise<Completion> => {
    const result = await deps.complete(request);
    return { ...result, text: cleanReply(result.text) };
  };
  const prot = protect(job.source, { ...settings, ...job.protectExtra });
  const sources = partSources(prot.text, settings);
  const targetLanguage = job.direction === 'incoming' ? settings.myLanguage : settings.modelLanguage;
  const aborted = () => {
    if (deps.signal?.aborted) throw new TranslationError('번역을 취소했습니다.', record);
  };

  // A resumable record must come from the same protected text and split.
  const resume = resumable(job.resume, prot.pieces, sources.length, settings) ? job.resume! : null;
  const record: TranslationRecord = resume
    ? { ...resume, pieces: prot.pieces, parts: [...resume.parts], status: 'partial', error: undefined, updatedAt: Date.now() }
    : { parts: [], pieces: prot.pieces, unit: settings.translationUnit, total: sources.length, truncatedPart: -1, status: 'partial', updatedAt: Date.now() };

  const requestFor = (part: string) =>
    buildTranslationRequest({
      direction: job.direction,
      text: part,
      settings,
      store: job.store,
      presets: job.presets,
      previous: job.previous,
      hasMarkers: /⟦\d+⟧/.test(part),
    });

  const save = async () => {
    record.updatedAt = Date.now();
    await deps.onProgress?.({ ...record, parts: [...record.parts] });
  };

  /** Continues part i until it is no longer cut off (at most `rounds` requests). Returns true when complete. */
  const continuePart = async (i: number, rounds: number): Promise<boolean> => {
    const base = requestFor(sources[i]!);
    for (let round = 0; round < rounds; round++) {
      aborted();
      const result = await complete(buildContinuationRequest(base, record.parts[i]!, targetLanguage));
      const before = record.parts[i]!;
      record.parts[i] = joinContinuation(before, result.text);
      const truncated = isTruncatedFinish(result.finishReason);
      record.truncatedPart = truncated ? i : -1;
      await save();
      if (!truncated) return true;
      if (record.parts[i] === before) return false; // no progress; leave it to the user
    }
    return record.truncatedPart !== i;
  };

  /**
   * Fallback for a part whose markers the model would not keep: each run of text between markers is
   * translated on its own (no markers in the request) and joined with the original markers.
   * Returns null when it cannot be done safely (too many pieces, a piece cut off, an empty answer).
   */
  const translateBySegments = async (part: string): Promise<string | null> => {
    const segments = part.split(/(⟦\s*\d+\s*⟧)/);
    const todo = segments.filter((seg, k) => k % 2 === 0 && !hasNoText(seg)).length;
    if (todo > MAX_FALLBACK_SEGMENTS) return null;
    const out: string[] = [];
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k]!;
      if (k % 2 === 1 || hasNoText(seg)) {
        out.push(seg);
        continue;
      }
      aborted();
      const lead = /^\s*/.exec(seg)![0];
      const trail = /\s*$/.exec(seg)![0];
      const result = await complete(requestFor(seg.trim()));
      const text = result.text.trim();
      if (!text || isTruncatedFinish(result.finishReason) || /⟦\s*\d+\s*⟧/.test(text)) return null;
      out.push(lead + text + trail);
    }
    return out.join('');
  };

  /** Translates part i from scratch. Returns true when complete (not cut off). */
  const translatePart = async (i: number): Promise<boolean> => {
    if (hasNoText(sources[i]!)) {
      // Separators, markup or protected parts only: kept as they are, no request.
      record.parts[i] = sources[i]!;
      await save();
      return true;
    }
    const request = requestFor(sources[i]!);
    for (let attempt = 0; attempt < 2; attempt++) {
      aborted();
      const result = await complete(request);
      record.parts[i] = result.text.trim();
      if (isTruncatedFinish(result.finishReason)) {
        record.truncatedPart = i;
        await save();
        if (!settings.autoContinue) return false;
        if (!(await continuePart(i, MAX_AUTO_CONTINUE))) return false;
      } else {
        record.truncatedPart = -1;
      }
      const problem = checkMarkers(sources[i]!, record.parts[i]!, prot.ordered);
      if (!problem) {
        await save();
        return true;
      }
      if (attempt === 1) {
        // The model keeps mangling the markers. Translate the text between them one piece at a time,
        // so there is nothing left to mangle, and put the protected pieces back ourselves.
        const pieces = await translateBySegments(sources[i]!);
        if (pieces === null) {
          record.parts.length = i;
          throw new TranslationError(`${problem} HTML이 깨지지 않도록 이 부분은 저장하지 않았습니다. 다시 번역해 주세요.`, record);
        }
        record.parts[i] = pieces;
        record.truncatedPart = -1;
        await save();
        return true;
      }
    }
    return false;
  };

  try {
    if (resume) {
      if (record.truncatedPart >= 0) {
        const i = record.truncatedPart;
        if (!(await continuePart(i, settings.autoContinue ? MAX_AUTO_CONTINUE : 1))) return finish();
        const problem = checkMarkers(sources[i]!, record.parts[i]!, prot.ordered);
        if (problem) throw new TranslationError(`${problem} 이어서 번역한 부분의 HTML 보호 표시가 맞지 않습니다. 다시 번역해 주세요.`, record);
      } else if (record.parts.length >= record.total) {
        // Looked complete, but the user says it stopped early: try once more on the last part.
        const i = record.total - 1;
        const before = record.parts[i]!;
        record.truncatedPart = i;
        const complete = await continuePart(i, 1);
        const problem = checkMarkers(sources[i]!, record.parts[i]!, prot.ordered);
        if (problem) {
          record.parts[i] = before;
          record.truncatedPart = -1;
          throw new TranslationError(`${problem} 이어서 번역한 내용은 버렸습니다.`, record);
        }
        if (!complete) return finish();
        record.truncatedPart = -1;
      }
    }
    for (let i = record.parts.length; i < sources.length; i++) {
      if (!(await translatePart(i))) return finish();
    }
    return finish();
  } catch (e) {
    if (e instanceof TranslationError) throw e;
    record.status = 'error';
    throw new TranslationError(e instanceof Error ? e.message : String(e), { ...record, parts: [...record.parts] });
  }

  function finish(): TranslationRecord {
    record.status = record.truncatedPart >= 0 || record.parts.length < record.total ? 'partial' : 'done';
    record.updatedAt = Date.now();
    return { ...record, parts: [...record.parts] };
  }
}
