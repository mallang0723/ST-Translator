// One LLM call: a Connection Manager profile when there is one, else the current main API.

import { pickConnection, SOURCE_LABELS, type ConnectionSource } from '../connection';
import { CANCELLED_MESSAGE, type ConnectionSummary } from '../shared';
import type { Completion } from '../translate/engine';
import type { TranslationRequest } from '../translate/prompt';
import { ctx, toast, type STContext, type STProfile } from './host';

export const TRANSLATION_TEMPERATURE = 0.3;

const warned = new Set<string>();
/** For tests. */
export function resetWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  toast('warning', text);
}

function managerAvailable(c: STContext): boolean {
  const disabled = c.extensionSettings?.disabledExtensions;
  return !(Array.isArray(disabled) && disabled.includes('connection-manager')) && !!c.ConnectionManagerRequestService;
}

/** Supported profiles, [] when Connection Manager is off or unreadable. */
export function listProfiles(): STProfile[] {
  const c = ctx();
  if (!managerAvailable(c)) return [];
  try {
    return c.ConnectionManagerRequestService!.getSupportedProfiles() ?? [];
  } catch {
    return [];
  }
}

export function listConnections(): ConnectionSummary[] {
  return listProfiles().map((p) => ({ id: p.id, name: p.name || p.id, model: p.model ?? '', provider: p.api ?? '' }));
}

export function activeProfileId(): string | null {
  const id = ctx().extensionSettings?.connectionManager?.selectedProfile;
  return typeof id === 'string' && id ? id : null;
}

/** Finish reason across OpenAI, Claude, Gemini and text-completion response shapes. */
export function finishReasonOf(json: unknown): unknown {
  const j = json as any;
  return j?.choices?.[0]?.finish_reason ?? j?.stop_reason ?? j?.candidates?.[0]?.finishReason ?? j?.finish_reason;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** Follows Error.cause to the innermost error (ST wraps provider failures as Error('API request failed', { cause })). */
export function innermostError(e: unknown): unknown {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur instanceof Error && cur.cause != null; i++) cur = cur.cause;
  return cur;
}

function causeMessage(c: unknown): string {
  if (c instanceof Error) return c.message;
  if (typeof c === 'string') return c;
  const m = (c as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(c);
}

/** True when the signal is aborted, or `e` or anything in its cause chain is an AbortError. */
export function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  // Only a real abort counts: a provider/network message that merely contains "aborted" is an error.
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur != null; i++) {
    if (cur instanceof Error && cur.name === 'AbortError') return true;
    if (typeof DOMException !== 'undefined' && cur instanceof DOMException && cur.name === 'AbortError') return true;
    cur = cur instanceof Error ? cur.cause : null;
  }
  return false;
}

export function abortError(): Error {
  return Object.assign(new Error(CANCELLED_MESSAGE), { name: 'AbortError' });
}

export interface CompleterOptions {
  /** Connection profile chosen in the settings; '' = follow the active one / current API. */
  chosenId: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export function createCompleter(opts: CompleterOptions): (req: TranslationRequest) => Promise<Completion> {
  return async (req) => {
    const c = ctx();
    const chosen = opts.chosenId || undefined;
    const profiles = listProfiles();
    if (chosen && !managerAvailable(c)) {
      warnOnce(`off:${chosen}`, '번역 설정에서 고른 연결을 쓸 수 없습니다(Connection Manager가 꺼져 있습니다). 지금 쓰는 API로 번역합니다.');
    }
    const picked = profiles.length ? pickConnection(profiles, chosen, { activeId: activeProfileId() ?? undefined }) : null;
    // Nothing chosen and no active profile: translate on whatever API SillyTavern is on, not on an arbitrary profile.
    const useProfile = !!picked && (!!chosen || picked.source === 'active' || picked.source === 'chosen');
    if (picked?.staleId) {
      const used: ConnectionSource = useProfile ? picked.source : 'host';
      warnOnce(`stale:${picked.staleId}`, `번역 설정에서 고른 연결이 없어졌습니다. 대신 ${SOURCE_LABELS[used]}으로 번역합니다. 번역 설정에서 연결을 다시 골라 주세요.`);
    }

    if (useProfile && picked) {
      const svc = c.ConnectionManagerRequestService!;
      const profile = svc.getProfile(picked.id!);
      const selected = svc.validateProfile(profile).selected;
      let json: unknown;
      try {
        json = await svc.sendRequest(
          picked.id!,
          [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
          opts.maxTokens,
          { stream: false, signal: opts.signal, extractData: false, includePreset: false, includeInstruct: true },
          { temperature: TRANSLATION_TEMPERATURE },
        );
      } catch (e) {
        // A user cancel is an AbortError; otherwise show the provider's own message, not the generic wrapper.
        if (opts.signal?.aborted || isAbortError(e)) throw abortError();
        const inner = innermostError(e);
        if (inner !== e) throw new Error(causeMessage(inner), { cause: e });
        throw e;
      }
      const text = c.extractMessageFromData(json, selected);
      return { text: typeof text === 'string' ? text : '', finishReason: finishReasonOf(json) };
    }

    // generateRaw has no abort and no finish reason: ignore the result when aborted.
    const text = await withAbort(c.generateRaw({ systemPrompt: req.system, prompt: req.user, responseLength: opts.maxTokens }), opts.signal);
    return { text: typeof text === 'string' ? text : '' };
  };
}
