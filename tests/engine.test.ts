import { describe, expect, test } from 'bun:test';
import { promptPresets } from '../src/presets';
import { DEFAULT_SETTINGS, type ChatSettings, type TranslationRecord } from '../src/shared';
import { type Completion, recordToText, translate, TranslationError } from '../src/translate/engine';
import type { TranslationRequest } from '../src/translate/prompt';

/** The text the request asks to translate. */
function target(req: TranslationRequest): string {
  const m = /\[Text to Translate\]\n([\s\S]*)\n\[End Text\]/.exec(req.user);
  return m ? m[1]! : req.user.replace(/^Translate the following text to [^:]+:\n\n/, '').split('\n\n[Translation So Far]')[0]!;
}

/** Fake model: "translates" by prefixing every line with [KO] and keeping markers. */
const fakeTranslate = (s: string) => s.split('\n').map((l) => (l.trim() ? `[KO]${l}` : l)).join('\n');

function model(script?: (req: TranslationRequest, call: number) => Completion | null) {
  const calls: TranslationRequest[] = [];
  return {
    calls,
    async complete(req: TranslationRequest): Promise<Completion> {
      calls.push(req);
      const custom = script?.(req, calls.length);
      if (custom) return custom;
      return { text: fakeTranslate(target(req)), finishReason: 'stop' };
    },
  };
}

const settings = (over: Partial<ChatSettings> = {}): ChatSettings => ({ ...DEFAULT_SETTINGS, ...over });
const job = (source: string, s: ChatSettings, resume?: TranslationRecord) => ({
  direction: 'incoming' as const,
  source,
  settings: s,
  presets: promptPresets([]),
  previous: [],
  resume,
});

describe('translate', () => {
  for (const translationUnit of ['whole', 'paragraph'] as const) {
    test(`${translationUnit}: cleans every chunk before progress is saved`, async () => {
      const source = Array.from({ length: 6 }, (_, i) => `Para ${i} ` + 'x'.repeat(1500)).join('\n\n');
      const saved: TranslationRecord[] = [];
      const m = model((req) => ({ text: `${fakeTranslate(target(req))}\n [ eNd TeXt ] \n` }));
      const r = await translate(job(source, settings({ translationUnit, longSplitChars: 7000 })), {
        ...m, onProgress: (entry) => void saved.push(entry),
      });
      expect(r.total).toBeGreaterThan(1);
      expect(r.parts).toEqual(m.calls.map((req) => fakeTranslate(target(req))));
      expect(saved.every((entry) => entry.parts.every((part) => !/end text/i.test(part)))).toBe(true);
      expect(recordToText(r)).toBe(fakeTranslate(source));
    });
  }

  test('leading wrapper and context headers are removed with whitespace and mixed case', async () => {
    const m = model(() => ({ text: '\n [ previous context — reference only ]\n [ tExT to Translate ] \n번역\n [ END TEXT ]\n[ Previous Context — Reference Only ] \n' }));
    const r = await translate(job('Hello', settings()), m);
    expect(r.parts).toEqual(['번역']);
  });

  test('literal markers inside real text and markers at the wrong edge are kept', async () => {
    const literal = '[End Text] 시작 [Text to Translate] 중간 [End Text] 그리고 [Previous Context — Reference Only] 끝 [Text to Translate]';
    const r = await translate(job('Hello', settings()), model(() => ({ text: literal })));
    expect(r.parts).toEqual([literal]);
    expect(recordToText(r)).toBe(literal);
  });

  for (const autoContinue of [true, false]) {
    test(`continuation cleans replies before joining and saving (auto=${autoContinue})`, async () => {
      const s = settings({ autoContinue });
      const saved: TranslationRecord[] = [];
      const m = model((req, call) => {
        if (call === 1) return { text: '[Text to Translate]\nHello wor\n[End Text]', finishReason: 'length' };
        expect(req.user).toContain('[Translation So Far]\nHello wor\n[End Translation So Far]');
        return { text: '\n[Text to Translate]\nld.\n[End Text]', finishReason: 'stop' };
      });
      const deps = { ...m, onProgress: (entry: TranslationRecord) => void saved.push(entry) };
      let r = await translate(job('Hello world.', s), deps);
      if (!autoContinue) r = await translate(job('Hello world.', s, r), deps);
      expect(r.parts).toEqual(['Hello world.']);
      expect(r.status).toBe('done');
      expect(saved.every((entry) => entry.parts.every((part) => !/\[(?:Text to Translate|End Text)\]/.test(part)))).toBe(true);
    });
  }

  test('a marker-only reply to continue a finished translation adds nothing', async () => {
    const done = await translate(job('Hello.', settings()), model());
    const r = await translate(job('Hello.', settings(), done), model(() => ({ text: '[Text to Translate]\n[End Text]' })));
    expect(r.parts).toEqual(done.parts);
    expect(r.status).toBe('done');
  });

  test('fallback segments are cleaned before being rejoined with protected markup', async () => {
    const m = model((req) => ({ text: /⟦\d+⟧/.test(target(req))
      ? 'missing protected markers'
      : `[Text to Translate]\n${fakeTranslate(target(req))}\n[End Text]` }));
    const r = await translate(job('<b>Hello</b> and <i>bye</i>', settings()), m);
    expect(m.calls).toHaveLength(5);
    expect(r.parts.join('')).not.toContain('[End Text]');
    expect(recordToText(r)).toBe('<b>[KO]Hello</b> [KO]and <i>[KO]bye</i>');
  });

  test('HTML structure survives; only text is translated', async () => {
    const m = model();
    const r = await translate(job('<div class="a">Hello</div> <status>HP 3</status>', settings({ excludeRules: '<status>' })), m);
    expect(r.status).toBe('done');
    expect(recordToText(r)).toBe('[KO]<div class="a">Hello</div> <status>HP 3</status>');
    expect(m.calls[0]!.user).toContain('⟦2⟧Hello⟦3⟧ ⟦1⟧');
    expect(m.calls[0]!.user).not.toContain('HP 3');
  });

  test('cut off output is continued automatically', async () => {
    const m = model((req, call) => {
      if (call === 1) return { text: '[KO]Hello wor', finishReason: 'length' };
      if (call === 2) {
        expect(req.user).toContain('[Translation So Far]\n[KO]Hello wor\n[End Translation So Far]');
        return { text: 'ld. Bye.', finishReason: 'stop' };
      }
      return null;
    });
    const r = await translate(job('Hello world. Bye.', settings({ autoContinue: true })), m);
    expect(r.status).toBe('done');
    expect(recordToText(r)).toBe('[KO]Hello world. Bye.');
  });

  test('with auto continue off, a cut part waits for the user, then continues', async () => {
    const saved: TranslationRecord[] = [];
    const first = model(() => ({ text: '[KO]Hello wor', finishReason: 'length' }));
    const r1 = await translate(job('Hello world.', settings({ autoContinue: false })), { ...first, onProgress: (r) => void saved.push(r) });
    expect(r1.status).toBe('partial');
    expect(r1.truncatedPart).toBe(0);
    expect(first.calls).toHaveLength(1);
    expect(saved.at(-1)!.parts).toEqual(['[KO]Hello wor']);

    const second = model(() => ({ text: 'ld.', finishReason: 'stop' }));
    const r2 = await translate(job('Hello world.', settings({ autoContinue: false }), r1), second);
    expect(second.calls).toHaveLength(1);
    expect(r2.status).toBe('done');
    expect(recordToText(r2)).toBe('[KO]Hello world.');
  });

  test('long source is translated part by part; a failure keeps finished parts and resume continues', async () => {
    const source = Array.from({ length: 6 }, (_, i) => `Para ${i} ` + 'x'.repeat(1500)).join('\n\n');
    let fail = true;
    const saved: TranslationRecord[] = [];
    const m = model((req, call) => {
      if (fail && call === 3) throw new Error('network down');
      return null;
    });
    const err = await translate(job(source, settings({ longSplitChars: 7000 })), { ...m, onProgress: (r) => void saved.push(r) }).catch((e) => e);
    expect(err).toBeInstanceOf(TranslationError);
    const partial = (err as TranslationError).record!;
    expect(partial.status).toBe('error');
    expect(partial.total).toBeGreaterThan(2);
    expect(partial.parts).toHaveLength(2);

    fail = false;
    const r = await translate(job(source, settings({ longSplitChars: 7000 }), partial), m);
    expect(r.status).toBe('done');
    expect(r.parts).toHaveLength(r.total);
    expect(recordToText(r)).toBe(fakeTranslate(source));
  });

  test('a marker dropped once is retried', async () => {
    const once = model((req, call) => (call === 1 ? { text: '[KO]Hello', finishReason: 'stop' } : null));
    const ok = await translate(job('<b>Hello</b>', settings()), once);
    expect(recordToText(ok)).toBe('[KO]<b>Hello</b>');
    expect(once.calls).toHaveLength(2);
  });

  test('markers dropped twice: the text between them is translated piece by piece and the markup is put back', async () => {
    const mangling = model((req) => {
      const t = target(req);
      // Whole-part requests carry markers and come back without them; piece requests are answered normally.
      return /⟦\d+⟧/.test(t) ? { text: '[KO] mangled', finishReason: 'stop' } : null;
    });
    const r = await translate(job('<b>Hello</b> and <i>bye</i>', settings()), mangling);
    expect(r.status).toBe('done');
    expect(recordToText(r)).toBe('<b>[KO]Hello</b> [KO]and <i>[KO]bye</i>');
    expect(mangling.calls).toHaveLength(2 + 3);
    expect(mangling.calls.slice(2).every((c) => !/⟦\d+⟧/.test(target(c)))).toBe(true);
  });

  test('if the piece-by-piece fallback also fails, nothing broken is saved', async () => {
    const always = model(() => ({ text: '[KO]Hello ⟦9⟧', finishReason: 'stop' }));
    const err = await translate(job('<b>Hello</b>', settings()), always).catch((e) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect(err.message).toContain('빠짐');
    expect(err.record.parts).toEqual([]);
  });

  test('excluded tags never reach the model and come back verbatim', async () => {
    const m = model();
    const src = 'Pick.\n\n<choices>\n1. Run away\n2. <b>Fight</b>\n</choices>\n\nDone.';
    const r = await translate(job(src, settings({ excludeTags: 'choices' })), m);
    expect(m.calls.every((c) => !c.user.includes('Run away'))).toBe(true);
    expect(recordToText(r)).toContain('<choices>\n1. Run away\n2. <b>Fight</b>\n</choices>');
    expect(recordToText(r)).toContain('[KO]Pick.');
  });

  test('"continue" on a finished translation asks once more and keeps it when nothing is added', async () => {
    const done = await translate(job('Hello.', settings()), model());
    const empty = model(() => ({ text: '', finishReason: 'stop' }));
    const r = await translate(job('Hello.', settings(), done), empty);
    expect(empty.calls).toHaveLength(1);
    expect(recordToText(r)).toBe('[KO]Hello.');
    expect(r.status).toBe('done');
  });

  test('re-translating (toolbar "다시 번역") starts over: a new request, and the new text replaces the old', async () => {
    const first = await translate(job('Hello.', settings()), model());
    const m = model((req) => ({ text: `[v2]${target(req)}`, finishReason: 'stop' }));
    const again = await translate(job('Hello.', settings()), m); // no resume record, like a forced translate
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.user).not.toContain('[Translation So Far]');
    expect(recordToText(first)).toBe('[KO]Hello.');
    expect(recordToText(again)).toBe('[v2]Hello.');
    expect(again.status).toBe('done');
  });

  test('changed exclude rules make a stale record start over', async () => {
    const r1 = await translate(job('A <status>x</status>', settings()), model());
    const m = model();
    await translate(job('A <status>x</status>', settings({ excludeRules: '<status>' }), r1), m);
    expect(m.calls[0]!.user).not.toContain('[Translation So Far]');
  });

  test('cancel stops before the next request', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await translate(job('Hello', settings()), { ...model(), signal: controller.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect(err.message).toContain('취소');
  });
});
