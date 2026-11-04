import { describe, expect, test } from 'bun:test';
import { installFake } from './st-fake';
import { createCompleter, finishReasonOf, listConnections } from '../src/st/complete';

const req = { system: 'SYS', user: 'USR', hasContext: false };
const profiles = [{ id: 'a', name: 'A', api: 'openai', model: 'm1' }, { id: 'b', name: 'B', api: 'claude', model: 'm2' }];
const run = (chosenId: string, signal?: AbortSignal) => createCompleter({ chosenId, maxTokens: 777, signal })(req);

describe('complete', () => {
  test('uses the chosen profile with messages, maxTokens and temperature 0.3', async () => {
    const f = installFake({ chatId: 'c', profiles, selectedProfile: 'a' });
    const out = await run('b');
    expect(out.text).toBe('번역:b');
    const r = f.requests[0];
    expect(r.id).toBe('b');
    expect(r.messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }]);
    expect(r.maxTokens).toBe(777);
    expect(r.custom.extractData).toBe(false);
    expect(r.override).toEqual({ temperature: 0.3 });
    expect(f.raw.calls.length).toBe(0);
  });

  test('nothing chosen follows the active profile', async () => {
    const f = installFake({ chatId: 'c', profiles, selectedProfile: 'b' });
    await run('');
    expect(f.requests[0].id).toBe('b');
  });

  test('nothing chosen and no active profile uses the current API', async () => {
    const f = installFake({ chatId: 'c', profiles });
    const out = await run('');
    expect(out).toEqual({ text: '안녕하세요.' });
    expect(f.raw.calls[0]).toEqual({ systemPrompt: 'SYS', prompt: 'USR', responseLength: 777 });
    expect(f.requests.length).toBe(0);
  });

  test('a stale chosen profile warns once and falls back to the active one', async () => {
    const f = installFake({ chatId: 'c', profiles, selectedProfile: 'a' });
    await run('gone');
    await run('gone');
    expect(f.requests.map((r) => r.id)).toEqual(['a', 'a']);
    const warnings = f.toasts.filter((t) => t.kind === 'warning');
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.text).toContain('지금 쓰는(활성) 연결');
  });

  test('Connection Manager off: current API, chosen id warned once', async () => {
    const f = installFake({ chatId: 'c', profiles, disabled: ['connection-manager'] });
    expect(listConnections()).toEqual([]);
    await run('a');
    await run('a');
    expect(f.raw.calls.length).toBe(2);
    expect(f.toasts.filter((t) => t.kind === 'warning').length).toBe(1);
  });

  test('connections() maps profiles', () => {
    installFake({ profiles });
    expect(listConnections()).toEqual([{ id: 'a', name: 'A', model: 'm1', provider: 'openai' }, { id: 'b', name: 'B', model: 'm2', provider: 'claude' }]);
  });

  test('finish reason from OpenAI, Claude, Gemini and text-completion shapes', () => {
    expect(finishReasonOf({ choices: [{ finish_reason: 'length' }] })).toBe('length');
    expect(finishReasonOf({ stop_reason: 'max_tokens' })).toBe('max_tokens');
    expect(finishReasonOf({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe('MAX_TOKENS');
    expect(finishReasonOf({ finish_reason: 'length', content: 'x' })).toBe('length');
    expect(finishReasonOf({})).toBeUndefined();
    expect(finishReasonOf(null)).toBeUndefined();
  });

  test('finish reason travels with the completion', async () => {
    const f = installFake({ chatId: 'c', profiles, selectedProfile: 'a' });
    f.ctx.ConnectionManagerRequestService.sendRequest = async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] });
    expect((await run('')).finishReason).toBe('length');
  });

  test('fallback ignores the result when aborted', async () => {
    const f = installFake({ chatId: 'c' });
    const ac = new AbortController();
    let release!: (s: string) => void;
    f.raw.impl = () => new Promise((r) => { release = r; });
    const p = run('', ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    release('late');
  });
});
