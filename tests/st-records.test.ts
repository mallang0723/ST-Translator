import { describe, expect, test } from 'bun:test';
import { installFake, msg } from './st-fake';
import { MAX_ENTRIES_PER_MESSAGE, readTranslations, writeTranslations, updateTranslations, setExtra } from '../src/st/records';
import { recordFor, recordKeyFor } from '../src/message-ui';
import { METADATA_KEY, rawSourceHash, sourceHash, type TranslationRecord } from '../src/shared';

const rec = (t: string, updatedAt = 1): TranslationRecord => ({ parts: [t], pieces: [], total: 1, truncatedPart: -1, status: 'done', updatedAt });

describe('records', () => {
  test('write goes to extra and to the visible swipe_info extra', () => {
    installFake({ chatId: 'c' });
    const m: any = msg('b', { swipes: ['a', 'b'], swipe_id: 1, swipe_info: [{}, {}] });
    writeTranslations(m, (mt) => { mt.entries[sourceHash('b')] = rec('비'); });
    expect(m.extra[METADATA_KEY].entries[sourceHash('b')].parts).toEqual(['비']);
    expect(m.swipe_info[1].extra[METADATA_KEY].entries[sourceHash('b')].parts).toEqual(['비']);
    expect(m.swipe_info[0].extra).toBeUndefined();
    // a copy, not the same object (ST structuredClones on swipe)
    expect(m.swipe_info[1].extra[METADATA_KEY]).not.toBe(m.extra[METADATA_KEY]);
  });

  test('after a swipe replaces extra, the other swipe keeps its own record', () => {
    installFake({ chatId: 'c' });
    const m: any = msg('a', { swipes: ['a', 'b'], swipe_id: 0, swipe_info: [{}, {}] });
    writeTranslations(m, (mt) => { mt.entries[sourceHash('a')] = rec('에이'); });
    // swipe to 1 like ST does
    m.swipe_id = 1; m.mes = 'b'; m.extra = structuredClone(m.swipe_info[1].extra) ?? {};
    expect(recordFor(readTranslations(m), m.mes)).toBeNull();
    writeTranslations(m, (mt) => { mt.entries[sourceHash('b')] = rec('비'); });
    m.swipe_id = 0; m.mes = 'a'; m.extra = structuredClone(m.swipe_info[0].extra) ?? {};
    expect(recordFor(readTranslations(m), m.mes)?.parts).toEqual(['에이']);
  });

  test('messages without swipe_info only use extra; foreign keys survive', () => {
    installFake({ chatId: 'c' });
    const m: any = msg('a', { extra: { other: 1 } });
    writeTranslations(m, (mt) => { mt.hidden = true; });
    expect(m.extra.other).toBe(1);
    expect(m.swipe_info).toBeUndefined();
    expect(readTranslations(m)?.hidden).toBe(true);
  });

  test('keeps only the newest entries', () => {
    installFake({ chatId: 'c' });
    const m: any = msg('a');
    writeTranslations(m, (mt) => { for (let i = 0; i < 20; i++) mt.entries[`k${i}`] = rec(String(i), i); });
    const keys = Object.keys(readTranslations(m)!.entries);
    expect(keys.length).toBe(MAX_ENTRIES_PER_MESSAGE);
    expect(keys).toContain('k19');
    expect(keys).not.toContain('k0');
  });

  test('legacy raw-hash key is found by recordKeyFor', () => {
    installFake({ chatId: 'c' });
    const m: any = msg('legacy text');
    writeTranslations(m, (mt) => { mt.entries[rawSourceHash('legacy text')] = rec('옛'); });
    expect(recordKeyFor(readTranslations(m), 'legacy text')).toBe(rawSourceHash('legacy text'));
  });

  test('invalid stored value reads as null', () => {
    const m: any = msg('a', { extra: { [METADATA_KEY]: 'junk' } });
    expect(readTranslations(m)).toBeNull();
    expect(readTranslations(msg('a') as any)).toBeNull();
  });

  test('final write saves only while the chat is still open', async () => {
    const f = installFake({ chatId: 'c' });
    const m: any = msg('a');
    await updateTranslations('c', m, (mt) => { mt.hidden = false; }, true);
    expect(f.saves.chat).toBe(1);
    await updateTranslations('other', m, (mt) => { mt.hidden = true; }, true);
    expect(f.saves.chat).toBe(1);
    expect(readTranslations(m)?.hidden).toBe(true);
  });

  test('setExtra undefined deletes from both places', () => {
    installFake({ chatId: 'c' });
    const m: any = msg('a', { swipes: ['a'], swipe_id: 0, swipe_info: [{}] });
    setExtra(m, 'display_text', 'x');
    expect(m.swipe_info[0].extra.display_text).toBe('x');
    setExtra(m, 'display_text', undefined);
    expect(m.extra.display_text).toBeUndefined();
    expect(m.swipe_info[0].extra.display_text).toBeUndefined();
  });
});
