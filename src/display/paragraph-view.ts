// Paragraph Reader style view: original paragraph N paired with translation N.
// The result is message content for the host renderer, so Markdown and HTML inside each
// paragraph render exactly like the original message. Paragraph text is kept between blank
// lines so Markdown is parsed inside the wrapper elements.

import { currentIllustrations, normalizeIllustrations } from '../illustrations';

import type { ChatSettings, ParagraphOrder, ParagraphView, TranslationRecord } from '../shared';
import { partSources, type ProtectExtra, recordToText } from '../translate/engine';
import { cleanReply } from '../translate/clean-reply';
import { htmlGroups, splitParagraphs } from '../translate/paragraphs';
import { protect, restore } from '../translate/protect';

export const PENDING_TEXT = '아직 번역하지 않은 문단입니다.';

export interface Pair {
  source: string;
  /** null = not translated yet. */
  translation: string | null;
}

export interface Pairing {
  pairs: Pair[];
  /** 'paragraph': translated paragraph by paragraph. 'matched': whole translation split by paragraphs.
   *  'whole': paragraph counts differ, shown as one pair. */
  kind: 'paragraph' | 'matched' | 'whole';
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => normalizeIllustrations(v) === normalizeIllustrations(b[i]!));
}

export function pairParagraphs(content: string, record: TranslationRecord, settings: ChatSettings, extra?: ProtectExtra): Pairing {
  if (record.unit === 'paragraph') {
    try {
      const prot = protect(content, { ...settings, ...extra });
      const sources = partSources(prot.text, { ...settings, translationUnit: 'paragraph' });
      if (sameArray(prot.pieces, record.pieces) && sources.length === record.total) {
        const current = currentIllustrations(content);
        const pairs = sources.map((s, i) => {
          const text = cleanReply(record.parts[i] ?? '');
          return {
            source: restore(s, prot.pieces),
            translation: text.trim() ? current.replace(restore(text, record.pieces)) : null,
          };
        });
        const rest = current.remaining();
        const last = pairs.findLast((pair) => pair.translation !== null);
        if (rest && last) last.translation += `\n\n${rest}`;
        return { kind: 'paragraph', pairs };
      }
    } catch {
      // exclude rules changed and no longer parse: fall through to matching by count
    }
  }
  const sources = splitParagraphs(content);
  const translations = splitParagraphs(recordToText(record, content));
  if (sources.length === translations.length && record.status !== 'partial') {
    return { kind: 'matched', pairs: sources.map((source, i) => ({ source, translation: translations[i]! })) };
  }
  return { kind: 'whole', pairs: [{ source: content.trim(), translation: recordToText(record, content).trim() || null }] };
}

/** Merges pairs whose HTML spans several paragraphs, so every block is rendered whole. */
export function groupPairs(pairs: Pair[]): Pair[] {
  return htmlGroups(pairs.map((p) => p.source)).map((group) => {
    if (group.length === 1) return pairs[group[0]!]!;
    const items = group.map((i) => pairs[i]!);
    return {
      source: items.map((p) => p.source).join('\n\n'),
      translation: items.some((p) => p.translation === null) ? null : items.map((p) => p.translation).join('\n\n'),
    };
  });
}

const NOTES: Record<Pairing['kind'], string> = {
  paragraph: '',
  matched: '메시지 전체 번역을 문단 수와 순서로 맞춰 보여 줍니다.',
  whole: '원문과 번역의 문단 수가 달라 전체 대조로 보여 줍니다. 문단별로 맞추려면 번역 단위를 "문단별"로 바꿔 다시 번역하세요.',
};

function block(cls: string, label: string, body: string): string {
  return `<div class="${cls}"><div class="stt-pr-label">${label}</div>\n\n${body}\n\n</div>`;
}

export function buildParagraphView(content: string, record: TranslationRecord, settings: ChatSettings, view: ParagraphView, order: ParagraphOrder = 'source-first', extra?: ProtectExtra): string {
  const pairing = pairParagraphs(content, record, settings, extra);
  const pairs = groupPairs(pairing.pairs);
  const whole = pairing.kind === 'whole';
  const out: string[] = [`<div class="stt-pr${view === 'tap' ? ' stt-pr-tap' : ''}${view !== 'tap' && order === 'translation-first' ? ' stt-pr-tfirst' : ''}">`];
  if (NOTES[pairing.kind]) out.push(`<div class="stt-pr-note">${NOTES[pairing.kind]}</div>`);
  let n = 0;
  pairs.forEach((pair) => {
    if (pair.translation !== null && pair.translation === pair.source) {
      // Kept as is (separator, markup, excluded part): shown once.
      out.push(`<div class="stt-pr-pair stt-pr-same">\n\n${pair.source}\n\n</div>`);
      return;
    }
    n++;
    const sourceLabel = whole ? '원문 전체' : `원문 ${n}`;
    const targetLabel = whole ? '번역 전체' : `번역 ${n}`;
    const target = pair.translation ?? `<span class="stt-pr-pending">${PENDING_TEXT}</span>`;
    if (view === 'tap' && pair.translation !== null) {
      out.push(
        `<div class="stt-pr-pair">\n${block('stt-pr-tgt', targetLabel, target)}\n` +
          `<details class="stt-pr-orig"><summary>${sourceLabel} · 눌러서 원문 열기 / 닫기</summary>\n\n${pair.source}\n\n</details>\n</div>`,
      );
    } else {
      const src = block('stt-pr-src', sourceLabel, pair.source);
      const tgt = block('stt-pr-tgt', targetLabel, target);
      out.push(`<div class="stt-pr-pair">\n${order === 'translation-first' ? `${tgt}\n${src}` : `${src}\n${tgt}`}\n</div>`);
    }
  });
  out.push('</div>');
  return out.join('\n');
}
