import { expect, test } from 'bun:test';
import { renderMessage } from '../src/display/render';
import { pairParagraphs } from '../src/display/paragraph-view';
import { recordFor } from '../src/message-ui';
import { DEFAULT_SETTINGS, DEFAULT_VIEW, DISPLAY_MODES, sourceHash, type TranslationRecord } from '../src/shared';
import { recordToText, translate } from '../src/translate/engine';
import { protect, restore } from '../src/translate/protect';

export const pic = '<pic chars="Ada: smiling" prompt="sunset > sea">';
export const image = '![그림:p123|sunset](/api/v1/image-gen/results/123)';
const failure = '[⚠️ 그림 생성 실패(provider error) · "sunset" · 패널에서 \'다시 그리기\'로 재시도 <pic-failed id="p123">]';
const skipped = '[한 답변당 그림 상한(2장)을 넘어 건너뜀 · "sunset" · 패널에서 \'다시 그리기\'로 추가 생성 가능 <pic-skipped id="p123">]';
const annotation = '⟦삽화가: 그림 태그 형식 오류 — 고치면 다시 시도됩니다⟧';
const record: TranslationRecord = { parts: ['앞 ⟦1⟧ 뒤'], pieces: [pic], total: 1, truncatedPart: -1, status: 'done', updatedAt: 1 };

// Fixed 0.3.3 FNV-1a algorithm: do not use the implementation under test for legacy keys.
export function legacyHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${(hash >>> 0).toString(16)}-${text.length.toString(36)}`;
}

test.each([pic, pic.slice(0, -1) + '/>', `${pic}</pic>`, image, failure, skipped])('illustration states have one stable key: %s', (markup) => {
  expect(sourceHash(`Before ${markup} After`)).toBe(sourceHash(`Before ${pic} After`));
});

test('order, count, and surrounding prose still affect the key; ordinary images are not illustrations', () => {
  expect(sourceHash(`A ${pic} B ${pic} C`)).toBe(sourceHash(`A ${image} B ${skipped} C`));
  expect(sourceHash(`A ${pic} B`)).not.toBe(sourceHash(`A B ${image}`));
  expect(sourceHash(`A ${pic} B`)).not.toBe(sourceHash(`A ${image} ${image} B`));
  expect(sourceHash(`A ${pic} B`)).not.toBe(sourceHash(`Edited ${image} B`));
  expect(sourceHash('plain text')).toBe(legacyHash('plain text'));
  expect(sourceHash('![ordinary](x)')).not.toBe(sourceHash('![ordinary](y)'));
});

test('malformed annotation does not change the key or leak into model text', () => {
  const source = 'Before <pic prompt="unfinished\nAfter';
  const annotated = source.replace('<pic', `<pic${annotation}`);
  expect(sourceHash(annotated)).toBe(sourceHash(source));
  const p = protect(annotated, { ...DEFAULT_SETTINGS, protectHtml: false });
  expect(p.text).not.toContain('unfinished');
  expect(p.text).not.toContain(annotation);
  expect(restore(p.text, p.pieces)).toBe(annotated);
});

test('legacy raw-content records are found, stable records take precedence', () => {
  const source = `Before ${pic} After`;
  const old = { ...record, updatedAt: 0 };
  const mt = { entries: { [legacyHash(source)]: old } };
  expect(recordFor(mt, source)).toBe(old);
  mt.entries[sourceHash(source)] = record;
  expect(recordFor(mt, source)).toBe(record);
});

for (const mode of DISPLAY_MODES) {
  test(`${mode}: translation uses CURRENT images at saved tag positions`, () => {
    const rendered = renderMessage(`Before ${image} After`, record, { ...DEFAULT_SETTINGS, displayMode: mode }, DEFAULT_VIEW);
    expect(rendered).toContain(`앞 ${image} 뒤`);
    expect(rendered).not.toContain('<pic');
  });
  test(`${mode}: excess current images are appended to the translation`, () => {
    const second = image.replaceAll('123', '456');
    const rendered = renderMessage(`Before ${image} After ${second}`, record, { ...DEFAULT_SETTINGS, displayMode: mode }, DEFAULT_VIEW);
    expect(rendered).toContain(`앞 ${image} 뒤\n\n${second}`);
  });
}

test('old rendered image/status is replaced; unmatched old slots are removed', () => {
  const stale = { ...record, parts: [`앞 ${failure} 중간 ${image} 뒤`], pieces: [] };
  expect(renderMessage(`Before ${image} After`, stale, { ...DEFAULT_SETTINGS, displayMode: 'only' }, DEFAULT_VIEW)).toBe(`앞 ${image} 중간  뒤`);
});

test('paragraph-unit records keep exact pairing after illustration replacement', () => {
  const saved = { ...record, unit: 'paragraph' as const, parts: ['앞 ⟦1⟧', '뒤'], total: 2 };
  const pairing = pairParagraphs(`Before ${image}\n\nAfter`, saved, DEFAULT_SETTINGS);
  expect(pairing.kind).toBe('paragraph');
  expect(pairing.pairs).toEqual([{ source: `Before ${image}`, translation: `앞 ${image}` }, { source: 'After', translation: '뒤' }]);
});

test.each([pic, `${pic}</pic>`, '<pic prompt="self" />', image, failure, skipped])('illustrations are always protected and restored: %s', (markup) => {
  const source = `Before ${markup} After`;
  const p = protect(source, { ...DEFAULT_SETTINGS, protectHtml: false, protectCode: false });
  expect(p.text).toBe('Before ⟦1⟧ After');
  expect(restore(p.text, p.pieces)).toBe(source);
});

test('model receives no illustration markup in target or previous context, including continuation', async () => {
  let calls = 0;
  const r = await translate({ direction: 'incoming', source: `Before ${image} After`, presets: [],
    settings: { ...DEFAULT_SETTINGS, protectHtml: false, contextEnabled: true, contextIncludeOriginal: true, contextIncludeTranslation: true, autoContinue: true },
    previous: [{ role: 'assistant', content: `Story ${pic} ${failure}`, translation: `이야기 ${image} ${skipped}` }],
  }, { async complete(req) {
    const request = req.system + req.user;
    for (const forbidden of ['<pic', '&lt;pic', '그림:', '/api/v1/image-gen', '그림 생성 실패', '그림 상한', 'sunset']) expect(request).not.toContain(forbidden);
    calls++;
    return calls === 1 ? { text: '앞 ⟦1⟧', finishReason: 'length' } : { text: ' 뒤', finishReason: 'stop' };
  } });
  expect(calls).toBe(2);
  expect(recordToText(r)).toContain(image);
  expect(r.status).toBe('done');
});

test('legacy raw key can be verified after a swap using retained protected markup', () => {
  const original = `Before ${pic} After`;
  const mt = { entries: { [legacyHash(original)]: record } };
  expect(recordFor(mt, `Before ${image} After`)).toBe(record);
  // Never choose a translation merely because it is the only/latest entry.
  expect(recordFor(mt, `Edited ${image} After`)).toBeNull();
});

test('URL parentheses, multiple states, and dangling closing tags keep positions', () => {
  const complex = '![그림:p123|sunset](/api/v1/image-gen/results/a(b))';
  const original = `One ${pic}\nTwo ${pic} </pic>\nThree ${pic}`;
  const current = `One ${complex}\nTwo ${failure} </pic>\nThree ${skipped}`;
  expect(sourceHash(original)).toBe(sourceHash(current));
  const p = protect(current, DEFAULT_SETTINGS);
  expect(p.text).toBe('One ⟦1⟧\nTwo ⟦2⟧\nThree ⟦3⟧');
  expect(restore(p.text, p.pieces)).toBe(current);
});

test('an unterminated tag does not swallow the next valid illustration', () => {
  const source = `<pic prompt="broken ${pic}`;
  const p = protect(source, DEFAULT_SETTINGS);
  expect(p.text).toBe('⟦1⟧⟦2⟧');
  expect(restore(p.text, p.pieces)).toBe(source);
});

test('partial paragraph translation resumes after image replacement without restarting', async () => {
  const partial = { ...record, unit: 'paragraph' as const, parts: ['앞 ⟦1⟧'], total: 2, status: 'partial' as const };
  let calls = 0;
  const resumed = await translate({ direction: 'incoming', source: `Before ${image}\n\nAfter`, presets: [], previous: [],
    settings: { ...DEFAULT_SETTINGS, translationUnit: 'paragraph' }, resume: partial,
  }, { async complete(req) {
    calls++;
    expect(req.user).toContain('After');
    expect(req.user).not.toContain('Before');
    return { text: '뒤', finishReason: 'stop' };
  } });
  expect(calls).toBe(1);
  expect(resumed.status).toBe('done');
  expect(recordToText(resumed)).toBe(`앞 ${image}\n\n뒤`);
});
