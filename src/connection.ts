// Picks the Lumiverse connection a translation request runs on.
//
// Why this exists: `generate.quiet` without a `connection_id` uses only the profile flagged as the
// user's default (`is_default`). A user who never set a default, or who chose a profile that was
// deleted later, hits the host error "No connection profile found. Create one first." even though
// chatting works (chat uses the active profile). So the id is always resolved here and passed on.

export interface ConnectionLike {
  id: string;
  name?: string;
  model?: string;
  provider?: string;
  is_default?: boolean;
}

/** Ids the frontend can see but the backend cannot (the active profile, the profile pinned to the chat). */
export interface ConnectionHint {
  activeId?: string;
  chatId?: string;
}

export type ConnectionSource = 'chosen' | 'chat' | 'active' | 'default' | 'first' | 'host';

export interface ResolvedConnection {
  /** undefined only when the connection list could not be read; the host then decides. */
  id: string | undefined;
  source: ConnectionSource;
  /** The profile chosen in the settings no longer exists, so another one was used. */
  staleId?: string;
}

export const NO_CONNECTION_MESSAGE =
  '사용할 수 있는 AI 연결이 없습니다. SillyTavern에서 API를 연결하거나 Connection Manager에서 연결 프로필을 하나 만들고 다시 시도해 주세요.';

/** Shown when the host reports a missing profile: the usual cause is a choice that was never saved. */
export const CONNECTION_HINT =
  'AI 연결을 찾지 못했습니다. 번역 설정에서 연결을 골랐는지, 그리고 저장했는지 확인해 주세요(저장하지 않으면 적용되지 않습니다). SillyTavern에 API가 연결되어 있는지도 확인해 보세요.';

export class NoConnectionError extends Error {
  constructor() {
    super(NO_CONNECTION_MESSAGE);
    this.name = 'NoConnectionError';
  }
}

/**
 * Pure choice among known profiles: the profile chosen in the settings, else the chat's, else the
 * active one, else the default, else the first. An id that is not in `list` is skipped.
 */
export function pickConnection(list: readonly ConnectionLike[], chosen: string | undefined, hint: ConnectionHint = {}): ResolvedConnection | null {
  const has = (id: string | undefined) => (id ? list.some((c) => c.id === id) : false);
  const staleId = chosen && !has(chosen) ? chosen : undefined;
  const found = (id: string, source: ConnectionSource): ResolvedConnection => (staleId ? { id, source, staleId } : { id, source });
  if (chosen && has(chosen)) return { id: chosen, source: 'chosen' };
  if (has(hint.chatId)) return found(hint.chatId!, 'chat');
  if (has(hint.activeId)) return found(hint.activeId!, 'active');
  const def = list.find((c) => c.is_default);
  if (def) return found(def.id, 'default');
  const first = list[0];
  return first ? found(first.id, 'first') : null;
}

export interface ConnectionsHost {
  connections: { list(userId?: string): Promise<ConnectionLike[]> };
}

/** Reads the user's profiles and picks one. Throws NoConnectionError only when the user has none. */
export async function resolveConnection(host: ConnectionsHost, uid: string | undefined, chosen: string | undefined, hint: ConnectionHint = {}): Promise<ResolvedConnection> {
  let list: ConnectionLike[];
  try {
    list = await host.connections.list(uid);
  } catch {
    // Listing is unavailable: trust what we were given and let the host resolve it.
    return { id: chosen || hint.chatId || hint.activeId || undefined, source: 'host' };
  }
  const picked = pickConnection(list, chosen, hint);
  if (!picked) throw new NoConnectionError();
  return picked;
}

export const SOURCE_LABELS: Record<ConnectionSource, string> = {
  chosen: '설정에서 고른 연결',
  chat: '이 채팅에 지정된 연결',
  active: '지금 쓰는(활성) 연결',
  default: '기본 연결',
  first: '첫 번째 연결',
  host: '지금 SillyTavern에서 쓰는 API 연결',
};

/** The host's own wording is English; show something the user can act on. */
export function friendlyError(message: string): string {
  if (/No connection profile found/i.test(message)) return CONNECTION_HINT;
  if (/userId is required/i.test(message)) return '이 확장은 사용자 정보를 받지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.';
  return message;
}

export interface QuietHost extends ConnectionsHost {
  generate: { quiet(input: Record<string, unknown>): Promise<unknown> };
}

/** Runs one quiet generation on a resolved connection. `onStale` fires when the chosen profile is gone. */
export async function quietComplete(
  host: QuietHost,
  args: {
    uid: string | undefined;
    chosen: string | undefined;
    hint?: ConnectionHint;
    system: string;
    user: string;
    signal?: AbortSignal;
    onStale?: (staleId: string, used: ResolvedConnection) => void;
  },
): Promise<{ text: string; finishReason?: unknown }> {
  const conn = await resolveConnection(host, args.uid, args.chosen, args.hint);
  if (conn.staleId) args.onStale?.(conn.staleId, conn);
  const result = (await host.generate.quiet({
    type: 'quiet',
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    ...(conn.id ? { connection_id: conn.id } : {}),
    parameters: { temperature: 0.3 },
    userId: args.uid,
    signal: args.signal,
  })) as { content?: unknown; finish_reason?: unknown } | string | null;
  if (typeof result === 'string') return { text: result };
  return { text: typeof result?.content === 'string' ? result.content : '', finishReason: result?.finish_reason };
}
