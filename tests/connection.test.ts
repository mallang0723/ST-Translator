import { describe, expect, test } from 'bun:test';
import { CONNECTION_HINT, friendlyError, NO_CONNECTION_MESSAGE, NoConnectionError, pickConnection, quietComplete, resolveConnection, type ConnectionLike } from '../src/connection';
import { DEFAULT_SETTINGS, effectiveConnectionId, normalizeStore } from '../src/shared';

const profile = (id: string, over: Partial<ConnectionLike> = {}): ConnectionLike => ({ id, name: id, model: 'm', provider: 'p', is_default: false, ...over });

interface Call {
  connection_id?: string;
  userId?: string;
}

/**
 * A mock host that behaves like Lumiverse: `generate.quiet` resolves the profile as the host does
 * (an id must exist for that user, no id means the profile flagged is_default) and throws the
 * host's own error otherwise. Operator-scoped installs need a userId on every call.
 */
function mockSpindle(profiles: Record<string, ConnectionLike[]>, opts: { operatorScoped?: boolean } = {}) {
  const calls: Call[] = [];
  const listUsers: Array<string | undefined> = [];
  const owner = (uid?: string) => {
    if (opts.operatorScoped && !uid) throw new Error('userId is required for operator-scoped extensions');
    return uid ?? 'owner';
  };
  return {
    calls,
    listUsers,
    connections: {
      async list(uid?: string) {
        listUsers.push(uid);
        return profiles[owner(uid)] ?? [];
      },
    },
    generate: {
      async quiet(input: Record<string, unknown>) {
        const uid = owner(input.userId as string | undefined);
        calls.push({ connection_id: input.connection_id as string | undefined, userId: input.userId as string | undefined });
        const mine = profiles[uid] ?? [];
        const id = input.connection_id as string | undefined;
        const found = id ? mine.find((c) => c.id === id) : mine.find((c) => c.is_default);
        if (!found) throw new Error('No connection profile found. Create one first.');
        return { content: `ok:${found.id}`, finish_reason: 'stop' };
      },
    },
  };
}

const run = (host: ReturnType<typeof mockSpindle>, chosen: string | undefined, uid?: string, hint = {}) =>
  quietComplete(host, { uid, chosen, hint, system: 's', user: 'u' });

describe('connection choice', () => {
  test('no default connection: falls back to the first profile instead of failing', async () => {
    const host = mockSpindle({ owner: [profile('a'), profile('b')] });
    expect((await run(host, undefined)).text).toBe('ok:a');
    // the bug: without a resolved id the host rejects when nothing is flagged default
    await expect(host.generate.quiet({ type: 'quiet', messages: [] })).rejects.toThrow('Create one first');
  });

  test('prefers the default, then the active profile hint, over the first one', async () => {
    const host = mockSpindle({ owner: [profile('a'), profile('b', { is_default: true }), profile('c')] });
    expect((await run(host, undefined)).text).toBe('ok:b');
    expect((await run(host, undefined, undefined, { activeId: 'c' })).text).toBe('ok:c');
    expect((await run(host, undefined, undefined, { activeId: 'c', chatId: 'a' })).text).toBe('ok:a');
  });

  test('an explicit choice is honored and sent as connection_id', async () => {
    const host = mockSpindle({ owner: [profile('a', { is_default: true }), profile('b')] });
    expect((await run(host, 'b', undefined, { activeId: 'a', chatId: 'a' })).text).toBe('ok:b');
    expect(host.calls.at(-1)?.connection_id).toBe('b');
  });

  test('a stale or deleted connection id falls back and reports it', async () => {
    const host = mockSpindle({ owner: [profile('a'), profile('b', { is_default: true })] });
    const stale: string[] = [];
    const out = await quietComplete(host, { uid: undefined, chosen: 'gone', system: 's', user: 'u', onStale: (id) => stale.push(id) });
    expect(out.text).toBe('ok:b');
    expect(stale).toEqual(['gone']);
    expect(host.calls.at(-1)?.connection_id).toBe('b');
  });

  test('operator-scoped install: userId reaches list and quiet, and the right user profiles are used', async () => {
    const host = mockSpindle({ alice: [profile('a1')], bob: [profile('b1'), profile('b2')] }, { operatorScoped: true });
    expect((await run(host, undefined, 'bob')).text).toBe('ok:b1');
    expect((await run(host, 'b2', 'bob')).text).toBe('ok:b2');
    expect((await run(host, undefined, 'alice')).text).toBe('ok:a1');
    expect(host.listUsers.every((u) => u === 'alice' || u === 'bob')).toBe(true);
    expect(host.calls.every((c) => c.userId === 'alice' || c.userId === 'bob')).toBe(true);
    // another user's profile id is not usable: treated as stale, never sent as-is
    expect((await run(host, 'b2', 'alice')).text).toBe('ok:a1');
  });

  test('operator-scoped install without a userId surfaces a Korean message', () => {
    expect(friendlyError('userId is required for operator-scoped extensions')).toContain('새로고침');
  });

  test('truly no connections: clear Korean error, no request is made', async () => {
    const host = mockSpindle({ owner: [] });
    await expect(run(host, undefined)).rejects.toBeInstanceOf(NoConnectionError);
    await expect(run(host, 'x')).rejects.toThrow(NO_CONNECTION_MESSAGE);
    expect(host.calls).toHaveLength(0);
  });

  test('when listing is unavailable the chosen id is passed through and the host decides', async () => {
    const host = mockSpindle({ owner: [profile('a')] });
    host.connections.list = async () => {
      throw new Error('permission denied');
    };
    expect(await resolveConnection(host, undefined, 'a')).toEqual({ id: 'a', source: 'host' });
    expect((await run(host, 'a')).text).toBe('ok:a');
  });

  test('the host error is translated into advice about choosing and saving', () => {
    expect(friendlyError('No connection profile found. Create one first.')).toBe(CONNECTION_HINT);
    expect(CONNECTION_HINT).toContain('저장');
    expect(friendlyError('other')).toBe('other');
  });

  test('pickConnection is pure and skips unknown ids', () => {
    const list = [profile('a'), profile('b', { is_default: true })];
    expect(pickConnection(list, 'a')).toEqual({ id: 'a', source: 'chosen' });
    expect(pickConnection(list, 'zz', { chatId: 'zz', activeId: 'a' })).toEqual({ id: 'a', source: 'active', staleId: 'zz' });
    expect(pickConnection([], 'a')).toBeNull();
  });
});

describe('saved connection setting', () => {
  test('the connection is global: a per-chat copy is ignored', () => {
    const store = normalizeStore({ defaults: { ...DEFAULT_SETTINGS, connectionId: 'b' }, chats: { c1: { ...DEFAULT_SETTINGS, connectionId: '' }, c2: { connectionId: 'a' } } });
    expect(effectiveConnectionId(store, 'c1')).toBe('b');
    expect(effectiveConnectionId(store, 'c2')).toBe('b'); // was 'a' when chats could pin a connection
    expect(effectiveConnectionId(store, null)).toBe('b');
    expect(effectiveConnectionId(store, 'unknown')).toBe('b');
  });
});
