import { describe, expect, test } from 'bun:test';
import { renderMessage } from '../src/display/render';
import { softenIndentedCode } from '../src/display/indent';
import { DEFAULT_SETTINGS, DEFAULT_VIEW, type ChatSettings, type TranslationRecord } from '../src/shared';

// Synthetic: the model pulled a dialogue out of item 2 and put blank lines around it.
const translation = '  핵심 세부사항:\n    - 항목 하나\n\n  시작점:\n    1. 첫째\n    2. 둘째\n\n    "대사 한 줄"\n\n    3. 셋째\n    4. 넷째';
const content = '\r\n  关键细节:\r\n    - 一\r\n\r\n  开场点:\r\n    1. 甲\r\n    2. 乙：“话”\r\n    3. 丙\r\n    4. 丁\r\n';
const record: TranslationRecord = { parts: [translation], pieces: [], total: 1, unit: 'whole', truncatedPart: -1, status: 'done', updatedAt: 0 };
const settings = (displayMode: ChatSettings['displayMode']): ChatSettings => ({ ...DEFAULT_SETTINGS, displayMode });
const indentedAfterBlank = (t: string) => t.split('\n').some((l, i, a) => i > 0 && !a[i - 1]!.trim() && /^( {4,}|\t)\S/.test(l));

describe('indented code block defense', () => {
  test('every mode leaves no 4+ space line after a blank line in the translation', () => {
    expect(indentedAfterBlank(translation)).toBe(true);
    for (const mode of ['only', 'below', 'above', 'collapsed', 'collapsed-source'] as const) {
      const out = renderMessage(content, record, settings(mode), DEFAULT_VIEW);
      const tr = mode === 'only' ? out : out.split(/<hr class="stt-separator">|<summary>[^<]*<\/summary>/).slice(1).join('\n');
      expect(indentedAfterBlank(tr || out)).toBe(false);
    }
  });
  test('source side is untouched', () => {
    const out = renderMessage(content, record, settings('below'), DEFAULT_VIEW);
    expect(out.startsWith(content)).toBe(true);
  });
  test('caps at 3 spaces, keeps following lines and non-blank-adjacent indentation', () => {
    expect(softenIndentedCode('가\n\n    - a\n    - b')).toBe('가\n\n   - a\n    - b');
    expect(softenIndentedCode('가:\n    - a')).toBe('가:\n    - a');
    expect(softenIndentedCode('가\n\n\t나')).toBe('가\n\n   나');
    expect(softenIndentedCode('    처음')).toBe('   처음');
    expect(softenIndentedCode('가\n\n  나')).toBe('가\n\n  나');
  });
  test('fenced code is untouched', () => {
    const t = '가\n\n```\n\n    x\n\n    y\n```\n\n~~~py\n\n    z\n~~~';
    expect(softenIndentedCode(t)).toBe(t);
  });
});
