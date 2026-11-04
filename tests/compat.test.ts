// LoreVeil, AutoPic and Tavern Helper compatibility.

import { afterEach, describe, expect, test } from 'bun:test';
import { blankPieces, blockSentinel, loreveilConfig, protectExtraFor, removeSentinels } from '../src/compat';
import { renderMessage } from '../src/display/render';
import { promptPresets } from '../src/presets';
import { DEFAULT_COMPAT, DEFAULT_SETTINGS, DEFAULT_VIEW, normalizeCompat, normalizeStore, sourceHash, type ChatSettings, type TranslationRecord } from '../src/shared';
import { applyDisplay, computeDisplayText, recompute, requestThRender, TH_RENDER_EVENT } from '../src/st/display';
import { translateAt, translateOutgoing } from '../src/st/jobs';
import { getStore, saveCompat, saveSettings } from '../src/st/store';
import { type Completion, recordToText, translate } from '../src/translate/engine';
import { checkMarkers, protect, restore, type LoreVeilConfig, type ProtectOptions } from '../src/translate/protect';
import type { TranslationRequest } from '../src/translate/prompt';
import { installFake, msg } from './st-fake';

const LV: LoreVeilConfig = { tags: ['st-loreveil'], attribute: true };
const opts = (over: Partial<ProtectOptions> = {}): ProtectOptions => ({ protectHtml: false, protectCode: false, excludeRules: '', excludeTags: '', ...over });
const lv = (over: Partial<ProtectOptions> = {}) => opts({ loreveil: LV, ...over });
const held = (source: string, o: ProtectOptions) => protect(source, o).pieces;

describe('LoreVeil protection (13-1)', () => {
  test('element tags are held, the text between stays translatable', () => {
    const p = protect('Hi <st-loreveil>secret words</st-loreveil> bye', lv());
    expect(p.pieces).toEqual(['<st-loreveil>', '</st-loreveil>']);
    expect(p.text).toBe('Hi ⟦1⟧secret words⟦2⟧ bye');
    expect(p.ordered).toEqual([1, 2]);
  });

  test('attributes on the tag are kept byte-identical', () => {
    const src = `<ST-LoreVeil data-x="a > b" class='k'>x</ST-LoreVeil >`;
    const p = protect(src, lv());
    expect(p.pieces).toEqual([`<ST-LoreVeil data-x="a > b" class='k'>`, '</ST-LoreVeil >']);
    expect(restore(p.text, p.pieces)).toBe(src);
  });

  test('unclosed tag: the opening tag is held, the rest translates', () => {
    const p = protect('Before <st-loreveil> to the end', lv());
    expect(p.pieces).toEqual(['<st-loreveil>']);
    expect(p.text).toBe('Before ⟦1⟧ to the end');
  });

  test('markers, including uppercase base with - and : turned into _', () => {
    const src = 'a !--ST_LOREVEIL_START--! b !--ST_LOREVEIL_END--! c !--WI_X_START--!d!--WI_X_END--!';
    const p = protect(src, lv());
    expect(p.pieces).toEqual(['!--ST_LOREVEIL_START--!', '!--ST_LOREVEIL_END--!', '!--WI_X_START--!', '!--WI_X_END--!']);
    expect(p.text).toBe('a ⟦1⟧ b ⟦2⟧ c ⟦3⟧d⟦4⟧');
  });

  test('markers inside an HTML comment are held, tags inside a comment are left alone', () => {
    const src = '<!-- <st-loreveil> !--ST_LOREVEIL_START--! -->';
    const p = protect(src, lv());
    expect(p.pieces).toEqual(['!--ST_LOREVEIL_START--!']);
    expect(p.text).toBe('<!-- <st-loreveil> ⟦1⟧ -->');
  });

  test('multiple configured tags and a configured tag with a colon', () => {
    const cfg = loreveilConfig({ tags: 'wi-exclude, WI:x, bad tag, st-loreveil', attribute: true });
    expect(cfg.tags).toEqual(['st-loreveil', 'wi-exclude', 'wi:x']);
    const p = protect('<wi-exclude>a</wi-exclude><wi:x>b</wi:x><other>c</other>', lv({ loreveil: cfg }));
    expect(p.pieces).toEqual(['<wi-exclude>', '</wi-exclude>', '<wi:x>', '</wi:x>']);
  });

  test('the default tag is protected even when LoreVeil is configured with another tag', () => {
    expect(loreveilConfig({ tags: 'wi-exclude' }).tags).toContain('st-loreveil');
    expect(loreveilConfig(undefined)).toEqual({ tags: ['st-loreveil'], attribute: true });
    expect(loreveilConfig({ attribute: false }).attribute).toBe(false);
  });

  test('attribute form: opening tag held; closing </div> only with protectHtml', () => {
    const src = '<div st-loreveil class="x">words</div>';
    expect(held(src, lv())).toEqual(['<div st-loreveil class="x">']);
    expect(held(src, lv({ protectHtml: true }))).toEqual(['<div st-loreveil class="x">', '</div>']);
    expect(held('<div class="x" ST-LoreVeil="1">w</div>', lv())).toEqual(['<div class="x" ST-LoreVeil="1">']);
    expect(held(src, lv({ loreveil: { tags: ['st-loreveil'], attribute: false } }))).toEqual([]);
    // an ordinary div is not touched
    expect(held('<div class="x">w</div>', lv())).toEqual([]);
  });

  test('fenced code is treated as today', () => {
    const src = 'a\n```\n<st-loreveil>x</st-loreveil> !--A_START--!\n```\nb <st-loreveil>';
    const off = protect(src, lv());
    expect(off.pieces).toEqual(['<st-loreveil>']);
    expect(off.text).toContain('```\n<st-loreveil>x</st-loreveil> !--A_START--!\n```');
    const on = protect(src, lv({ protectCode: true }));
    expect(on.pieces).toEqual(['```\n<st-loreveil>x</st-loreveil> !--A_START--!\n```', '<st-loreveil>']);
    // output without LoreVeil is the old output
    expect(protect(src, opts({ protectCode: true })).pieces).toHaveLength(1);
  });

  test('off (no loreveil option) is the old behaviour', () => {
    const p = protect('<st-loreveil>x</st-loreveil> !--A_START--!', opts());
    expect(p.pieces).toEqual([]);
    expect(p.ordered).toEqual([]);
  });

  test('a LoreVeil tag inside a user-excluded element stays inside that piece', () => {
    const p = protect('<ui><st-loreveil>x</st-loreveil></ui> y <st-loreveil>', lv({ excludeTags: 'ui' }));
    expect(p.pieces).toEqual(['<ui><st-loreveil>x</st-loreveil></ui>', '<st-loreveil>']);
    expect(p.ordered).toEqual([2]);
  });
});

describe('LoreVeil round trip (property test)', () => {
  const atoms = [
    '<st-loreveil>', '</st-loreveil>', '<ST-LoreVeil a="1">', '<wi-exclude>', '</wi-exclude>', '<wi:x>', '</wi:x>', '<div st-loreveil>', '<div class="q" wi-exclude>', '</div>',
    '!--ST_LOREVEIL_START--!', '!--ST_LOREVEIL_END--!', '!--WI_X_START--!', '!--WI_X_END--!', '<!--', '-->', '<!-- note -->', '```', '\n```js\n', '`code`',
    '{{user}}', '⟦3⟧', '<style>b{}</style>', '<autopic><scene>s</scene></autopic>', '<b>', '</b>', '<', '>', '"', "'", '\n', '\n\n', ' ', 'Hello', '안녕', 'world.', '<p class="a>b">',
  ];
  function rng(seed: number) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }
  test('protect -> identity -> restore returns the input, for every option combination', () => {
    const rand = rng(20261104);
    for (let n = 0; n < 1500; n++) {
      const len = 1 + Math.floor(rand() * 14);
      let src = '';
      for (let k = 0; k < len; k++) src += atoms[Math.floor(rand() * atoms.length)]!;
      for (const protectHtml of [false, true]) {
        for (const protectCode of [false, true]) {
          for (const autopic of [false, true]) {
            const p = protect(src, { ...lv({ protectHtml, protectCode, autopic }) });
            expect(restore(p.text, p.pieces)).toBe(src);
            // identity "translation" passes the marker check, order included
            expect(checkMarkers(p.text, p.text, p.ordered)).toBeNull();
          }
        }
      }
    }
  });
});

describe('marker order check', () => {
  test('swapped LoreVeil markers are an error, swapped ordinary markers are not', () => {
    const p = protect('<st-loreveil>a</st-loreveil> {{x}} {{y}}', lv());
    expect(p.text).toBe('⟦1⟧a⟦2⟧ ⟦3⟧ ⟦4⟧');
    expect(checkMarkers(p.text, '⟦2⟧a⟦1⟧ ⟦3⟧ ⟦4⟧', p.ordered)).not.toBeNull();
    expect(checkMarkers(p.text, '⟦1⟧a⟦2⟧ ⟦4⟧ ⟦3⟧', p.ordered)).toBeNull();
    // without LoreVeil info the old check does not look at order
    expect(checkMarkers(p.text, '⟦2⟧a⟦1⟧ ⟦3⟧ ⟦4⟧')).toBeNull();
  });
});

function target(req: TranslationRequest): string {
  const m = /\[Text to Translate\]\n([\s\S]*)\n\[End Text\]/.exec(req.user);
  return m ? m[1]! : req.user.replace(/^Translate the following text to [^:]+:\n\n/, '');
}
const prefix = (s: string) => s.split('\n').map((l) => (l.trim() ? `[EN]${l}` : l)).join('\n');
const base = (over: Partial<ChatSettings> = {}): ChatSettings => ({ ...DEFAULT_SETTINGS, protectHtml: false, protectCode: false, excludeTags: '', excludeRules: '', ...over });
const job = (source: string, s: ChatSettings, extra?: ProtectOptions) => ({
  direction: 'outgoing' as const,
  source,
  settings: s,
  presets: promptPresets([]),
  previous: [],
  protectExtra: extra ? { autopic: extra.autopic, loreveil: extra.loreveil } : undefined,
});

describe('translation with a fake model (13-1)', () => {
  test('tags and markers survive byte-identical, text between is translated', async () => {
    const src = 'Go <st-loreveil>hidden place</st-loreveil> now !--WI_X_START--!deep!--WI_X_END--! ok';
    const calls: string[] = [];
    const r = await translate(job(src, base(), lv()), {
      async complete(req) {
        calls.push(target(req));
        return { text: prefix(target(req)), finishReason: 'stop' };
      },
    });
    expect(recordToText(r)).toBe('[EN]Go <st-loreveil>hidden place</st-loreveil> now !--WI_X_START--!deep!--WI_X_END--! ok');
    expect(calls[0]).not.toContain('<st-loreveil>');
    expect(calls[0]).toContain('⟦1⟧');
  });

  test('a model that swaps LoreVeil markers is retried, then falls back to segments in source order', async () => {
    const src = 'A <st-loreveil>B</st-loreveil> C';
    let calls = 0;
    const seen: string[] = [];
    const r = await translate(job(src, base(), lv()), {
      async complete(req) {
        calls++;
        const t = target(req);
        seen.push(t);
        if (t.includes('⟦')) return { text: '⟦2⟧ B ⟦1⟧ A C', finishReason: 'stop' }; // swapped
        return { text: `<${t.trim()}>`, finishReason: 'stop' };
      },
    });
    // 2 whole-text attempts + 3 segments (A, B, C)
    expect(calls).toBe(5);
    expect(recordToText(r)).toBe('<A> <st-loreveil><B></st-loreveil> <C>');
  });

  test('with LoreVeil protection off the order is not checked and tags are plain text', async () => {
    const src = 'A <st-loreveil>B</st-loreveil> C';
    let seen = '';
    await translate(job(src, base()), { async complete(req) { seen = target(req); return { text: seen, finishReason: 'stop' }; } });
    expect(seen).toBe(src);
  });
});

describe('AutoPic always excluded (13-2)', () => {
  const block = '<autopic>\n<scene>a girl</scene>\n<apchar ref="x">tall</apchar>\n<uc>bad</uc>\n</autopic>';
  const src = `She smiles.\n\n${block}\n\nThe end.`;

  test('held whole even with empty excludeTags and protectHtml off', () => {
    const p = protect(src, opts({ autopic: true }));
    expect(p.pieces).toEqual([block]);
    expect(p.blocks).toEqual([block]);
    expect(p.text).not.toContain('autopic');
    expect(protect(src, opts()).pieces).toEqual([]); // switch off = old behaviour
  });

  test('uppercase, attributes, unclosed and nested', () => {
    expect(held('<AutoPic id="1">x</AUTOPIC>', opts({ autopic: true }))).toEqual(['<AutoPic id="1">x</AUTOPIC>']);
    expect(held('a <autopic>rest of message', opts({ autopic: true }))).toEqual(['<autopic>rest of message']);
    expect(held('<autopic><autopic>i</autopic></autopic> z', opts({ autopic: true }))).toEqual(['<autopic><autopic>i</autopic></autopic>']);
  });

  test('never sent to the model and restored byte-identical', async () => {
    const sent: string[] = [];
    const r = await translate({ ...job(src, base()), direction: 'incoming', protectExtra: { autopic: true, loreveil: null } }, {
      async complete(req) {
        sent.push(target(req));
        return { text: prefix(target(req)), finishReason: 'stop' };
      },
    });
    expect(sent.join('')).not.toMatch(/autopic|scene|girl/);
    expect(recordToText(r)).toContain(block);
  });

  test('protectExtraFor: loreveil only for outgoing', () => {
    expect(protectExtraFor(DEFAULT_COMPAT, 'incoming', undefined)).toEqual({ autopic: true, loreveil: null });
    expect(protectExtraFor(DEFAULT_COMPAT, 'outgoing', undefined).loreveil).toEqual(LV);
    expect(protectExtraFor({ loreveil: false, autopic: false }, 'outgoing', undefined)).toEqual({ autopic: false, loreveil: null });
  });
});

describe('single-instance blocks per display mode (13-2)', () => {
  const block = '<autopic>\n<scene>x</scene>\n</autopic>';
  const code = '```html\n<div>demo</div>\n```';
  const content = `Intro.\n\n${block}\n\n${code}\n\nOutro.`;
  const settings = (displayMode: ChatSettings['displayMode']) => base({ displayMode, protectCode: true });
  const extra = { autopic: true, loreveil: null };
  const options = { protect: extra, singleInstance: true };

  function record(s: ChatSettings): TranslationRecord {
    const p = protect(content, { ...s, ...extra });
    return { parts: [p.text.replace('Intro.', '도입.').replace('Outro.', '끝.')], pieces: p.pieces, unit: 'whole', total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 };
  }
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  for (const mode of ['below', 'above', 'collapsed', 'collapsed-source', 'only'] as const) {
    test(`${mode}: block and code appear exactly once`, () => {
      const s = settings(mode);
      const out = renderMessage(content, record(s), s, DEFAULT_VIEW, options);
      expect(count(out, block)).toBe(1);
      expect(count(out, code)).toBe(1);
      expect(out).toContain('도입.');
      if (mode !== 'only') expect(out).toContain('Intro.');
      // two-sided modes: the kept copy is on the side that carries the original
      const at = out.indexOf(block);
      if (mode === 'below' || mode === 'collapsed') expect(at).toBeLessThan(out.indexOf('<hr') >= 0 ? out.indexOf('<hr') : out.indexOf('<details'));
      if (mode === 'above' || mode === 'collapsed-source') expect(at).toBeLessThan(out.indexOf('Intro.'));
      // without the option both copies are shown (old behaviour)
      const old = renderMessage(content, record(s), s, DEFAULT_VIEW);
      expect(count(old, block)).toBe(mode === 'only' ? 1 : 2);
    });
  }

  test('paragraph view already shows such a paragraph once', () => {
    const s = settings('paragraph');
    const p = protect(content, { ...s, ...extra });
    const r: TranslationRecord = { ...record(s), unit: 'paragraph', total: p.text.split('\n\n').length, parts: p.text.split('\n\n').map((x) => x.replace('Intro.', '도입.')) };
    const out = renderMessage(content, r, { ...s, translationUnit: 'paragraph' }, DEFAULT_VIEW, options);
    expect(count(out, block)).toBe(1);
  });

  test('user excludeTags elements are single-instance too', () => {
    const s = { ...settings('below'), excludeTags: 'choices' };
    const text = 'Hi.\n\n<choices>1) a</choices>';
    const p = protect(text, s);
    const r: TranslationRecord = { parts: [p.text.replace('Hi.', '안녕.')], pieces: p.pieces, unit: 'whole', total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 };
    const out = renderMessage(text, r, s, DEFAULT_VIEW, { singleInstance: true });
    expect(count(out, '<choices>1) a</choices>')).toBe(1);
    expect(out).toBe('Hi.\n\n<choices>1) a</choices>\n\n<hr class="stt-separator">\n\n안녕.');
  });

  test('a side that would be empty is dropped; a message of only a block shows nothing new', () => {
    const s = settings('below');
    const only = `${block}`;
    const p = protect(only, { ...s, ...extra });
    const r: TranslationRecord = { parts: [`${p.text} 번역`], pieces: p.pieces, unit: 'whole', total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 };
    const out = renderMessage(only, r, s, DEFAULT_VIEW, options);
    expect(count(out, block)).toBe(1);
  });

  test('helpers', () => {
    const S = blockSentinel('');
    expect(removeSentinels(`x\n\n${S}\n\ny`, S)).toBe('x\n\ny');
    expect(removeSentinels(`x ${S} y`, S)).toBe('x  y');
    expect(removeSentinels(S, S)).toBe('');
    expect(blankPieces(['a', 'b'], [2], S)).toEqual(['a', S]);
  });

  describe('blocks are dropped by position (F1)', () => {
    const tail = (s: 'below' | 'above') => ({ ...settings(s), protectHtml: true }) as ChatSettings;
    const make = (content: string, s: ChatSettings, translate: (t: string) => string) => {
      const p = protect(content, { ...s, ...extra });
      const r: TranslationRecord = { parts: [translate(p.text)], pieces: p.pieces, unit: 'whole', total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 };
      return renderMessage(content, r, s, DEFAULT_VIEW, options);
    };
    const tr = (t: string) => t.replace('Tag is', '태그는').replace('End.', '끝.');
    test('same text inside an HTML comment is kept; only the held block is removed (below)', () => {
      const content = `Tag is <!-- ${block} --> ok.\n\n${block}\n\nEnd.`;
      const out = make(content, tail('below'), tr);
      const [src, trans] = out.split('<hr class="stt-separator">');
      expect(count(src!, block)).toBe(2);
      expect(trans).toContain(`<!-- ${block} -->`);
      expect(count(trans!, block)).toBe(1);
    });
    test('same text inside an HTML comment is kept; only the held block is removed (above)', () => {
      const content = `Tag is <!-- ${block} --> ok.\n\n${block}\n\nEnd.`;
      const out = make(content, tail('above'), tr);
      const [trans, src] = out.split('<hr class="stt-separator">');
      expect(count(trans!, block)).toBe(2);
      expect(count(src!, block)).toBe(1);
      expect(src).toContain(`<!-- ${block} -->`);
    });
    test('repeated identical blocks are each removed once from the translation side', () => {
      const content = `A\n\n${block}\n\nB\n\n${block}\n\nC`;
      const out = make(content, tail('below'), (t) => t.replace('A', '가'));
      const [src, trans] = out.split('<hr class="stt-separator">');
      expect(count(src!, block)).toBe(2);
      expect(count(trans!, block)).toBe(0);
    });
    test('repeated identical blocks are each removed from the source side (above)', () => {
      const content = `A\n\n${block}\n\nB\n\n${block}\n\nC`;
      const out = make(content, tail('above'), (t) => t.replace('A', '가'));
      const [trans, src] = out.split('<hr class="stt-separator">');
      expect(count(trans!, block)).toBe(2);
      expect(count(src!, block)).toBe(0);
    });
    test('a block inside another held piece (exclude rule) is not treated as a loose block', () => {
      const s = { ...tail('below'), excludeRules: '<keep> ... </keep>' } as ChatSettings;
      const content = `Hi.\n\n<keep>${block}</keep>\n\n${block}\n\nEnd.`;
      const out = make(content, s, (t) => t.replace('Hi.', '안녕.'));
      const [src, trans] = out.split('<hr class="stt-separator">');
      expect(count(src!, block)).toBe(2);
      expect(count(trans!, block)).toBe(1);
      expect(trans).toContain(`<keep>${block}</keep>`);
    });
  });
});

describe('Tavern Helper re-render (13-3)', () => {
  const realDocument = (globalThis as any).document;
  afterEach(() => {
    if (realDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = realDocument;
    console.log = originalLog;
  });
  const originalLog = console.log;

  /** A DOM just big enough for messageElement()/isEditing(). */
  function fakeDom(editing = false) {
    (globalThis as any).document = {
      getElementById: (id: string) => (id === 'chat' ? { querySelector: () => ({ querySelector: (sel: string) => (editing && sel === '.edit_textarea' ? {} : null) }) } : null),
    };
  }
  function listen(f: ReturnType<typeof installFake>, listening: boolean) {
    const emitted: unknown[][] = [];
    const blocks: number[] = [];
    f.ctx.eventSource = { on() {}, removeListener() {}, events: listening ? { [TH_RENDER_EVENT]: [() => {}] } : { [TH_RENDER_EVENT]: [] }, emit: (...a: unknown[]) => { emitted.push(a); } };
    f.ctx.updateMessageBlock = (id: number) => { blocks.push(id); };
    return { emitted, blocks };
  }
  async function setup() {
    const m: any = msg('Hello there.');
    const f = installFake({ chatId: 'c', chat: [m] });
    await translateAt(0, false);
    saveSettings({ ...DEFAULT_SETTINGS, displayMode: 'only' }, true);
    fakeDom();
    return { m, f };
  }

  test('emits TH_REQUEST_RENDER_MESSAGE once per block update, only when listeners exist', async () => {
    const { m, f } = await setup();
    const seen = listen(f, true);
    expect(recompute(m, 0)).toBe(true);
    expect(seen.blocks).toEqual([0]);
    expect(seen.emitted).toEqual([[TH_RENDER_EVENT, 0]]);
    // nothing changed: no update, no emit
    recompute(m, 0);
    expect(seen.emitted).toHaveLength(1);
  });

  test('no listeners (or an emptied listener array) means no emit', async () => {
    const { m, f } = await setup();
    const seen = listen(f, false);
    recompute(m, 0);
    expect(seen.blocks).toEqual([0]);
    expect(seen.emitted).toEqual([]);
    f.ctx.eventSource = { on() {}, removeListener() {}, emit: () => { throw new Error('should not be called'); } };
    expect(requestThRender(0)).toBe(false);
  });

  test('every updateMessageBlock path emits: show, hide (delete), restore', async () => {
    const { m, f } = await setup();
    const seen = listen(f, true);
    recompute(m, 0); // show
    applyDisplay(m, 0, null); // remove ours
    applyDisplay(m, 0, 'x'); // write
    expect(seen.blocks).toHaveLength(3);
    expect(seen.emitted).toHaveLength(3);
  });

  test('no emit while the message is being edited (no block update either)', async () => {
    const { m, f } = await setup();
    const seen = listen(f, true);
    fakeDom(true);
    recompute(m, 0);
    expect(seen.blocks).toEqual([]);
    expect(seen.emitted).toEqual([]);
  });

  test('thRerender off: no emit', async () => {
    const { m, f } = await setup();
    const seen = listen(f, true);
    saveCompat({ ...getStore().compat, thRerender: false });
    recompute(m, 0);
    expect(seen.blocks).toEqual([0]);
    expect(seen.emitted).toEqual([]);
  });

  test('only the TH event is ever emitted (no ST events); debug logs a line', async () => {
    const { m, f } = await setup();
    const seen = listen(f, true);
    const logs: string[] = [];
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    saveCompat({ ...getStore().compat, debug: true });
    recompute(m, 0);
    expect(seen.emitted.every((e) => e[0] === TH_RENDER_EVENT)).toBe(true);
    expect(logs.some((l) => l.includes('TH rerender mesid=0'))).toBe(true);
    console.log = originalLog;
    saveCompat({ ...getStore().compat, debug: false });
    applyDisplay(m, 0, 'y');
    expect(logs.filter((l) => l.includes('TH rerender'))).toHaveLength(1);
  });

  test('a failing emit does not break the update', async () => {
    const { m, f } = await setup();
    listen(f, true);
    f.ctx.eventSource.emit = () => Promise.reject(new Error('boom'));
    expect(() => recompute(m, 0)).not.toThrow();
    await Promise.resolve();
  });
});

describe('compat settings (13-4)', () => {
  test('defaults on, debug off; junk normalizes', () => {
    expect(normalizeStore(null).compat).toEqual({ loreveil: true, autopic: true, thRerender: true, debug: false });
    expect(normalizeCompat({ loreveil: false, autopic: 'x', debug: true })).toEqual({ loreveil: false, autopic: true, thRerender: true, debug: true });
    const store = normalizeStore({ compat: { thRerender: false } });
    expect(normalizeStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
  });

  test('saved globally at once and reloaded', () => {
    const f = installFake({ chatId: 'c' });
    saveCompat({ loreveil: false, autopic: true, thRerender: false, debug: true });
    expect(f.ctx.extensionSettings.st_translator.compat).toEqual({ loreveil: false, autopic: true, thRerender: false, debug: true });
    expect(f.saves.settings).toBe(1);
  });

  test('computeDisplayText uses compat only when given', async () => {
    const content = 'Hi.\n\n<autopic><scene>s</scene></autopic>';
    const m: any = msg(content);
    installFake({ chatId: 'c', chat: [m] });
    await translateAt(0, false);
    const s = { ...DEFAULT_SETTINGS, displayMode: 'below' as const, protectHtml: false, excludeTags: '' };
    saveSettings(s, true);
    const plain = computeDisplayText(m, s, DEFAULT_VIEW)!;
    expect(plain.split('<scene>').length - 1).toBe(2);
    expect(computeDisplayText(m, s, DEFAULT_VIEW, DEFAULT_COMPAT)!.split('<scene>').length - 1).toBe(1);
    expect(computeDisplayText(m, s, DEFAULT_VIEW, { ...DEFAULT_COMPAT, autopic: false, thRerender: false })!.split('<scene>').length - 1).toBe(2);
    expect(sourceHash(content)).toBeTruthy();
  });
});

describe('outgoing translation honours the LoreVeil switch', () => {
  async function run(loreveil: boolean) {
    const f = installFake({ chatId: 'c', settings: { loreVeil: { tags: 'wi-exclude', attribute: true } } });
    saveCompat({ ...getStore().compat, loreveil });
    saveSettings({ ...DEFAULT_SETTINGS, protectHtml: false }, true);
    f.raw.impl = async (p) => String(p.prompt).replace(/^Translate the following text to [^:]+:\n\n/, '');
    const out = await translateOutgoing('c', 'Go <wi-exclude>there</wi-exclude> now');
    return { out, prompt: String(f.raw.calls[0].prompt) };
  }
  test('on: tags never reach the model and come back identical', async () => {
    const { out, prompt } = await run(true);
    expect(prompt).not.toContain('wi-exclude');
    expect(out).toBe('Go <wi-exclude>there</wi-exclude> now');
  });
  test('off: old behaviour, the tag text is sent', async () => {
    const { prompt } = await run(false);
    expect(prompt).toContain('<wi-exclude>');
  });
});
