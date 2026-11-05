// Settings drawer for SillyTavern: one `.inline-drawer` in #extensions_settings2 plus a `번역 설정`
// entry in the wand menu (#extensionsMenu). Port of the Lumiverse panel (ref/frontend.ts renderPanel).
// Talks to the rest of the extension only through TranslatorApi.

import type { TranslatorApi } from './api';
import {
  type ChatSettings,
  type CompatSettings,
  DEFAULT_SETTINGS,
  DEFAULT_VIEW,
  type DisplayMode,
  FONT_MAX,
  FONT_MIN,
  INHERIT_PRESET_ID,
  MAX_TOKENS_MAX,
  MAX_TOKENS_MIN,
  normalizeView,
  type ParagraphOrder,
  type PresetSummary,
  type UserBundle,
  type ViewSettings,
  effectiveConnectionId,
} from '../shared';
import { ExcludeRuleError, lenientTags, parseTags } from '../translate/protect';
import { type ConnectionSource, pickConnection } from '../connection';
import { MARINARA_TRANSLATION_GENERAL_PROMPTS } from '../presets/upstream/general';

type Children = Array<Node | string | null | false | undefined>;

interface StContext {
  callGenericPopup?: (content: string | Element, type: number, inputValue?: string, options?: Record<string, unknown>) => Promise<unknown>;
  POPUP_TYPE?: { CONFIRM: number; TEXT: number };
  POPUP_RESULT?: { AFFIRMATIVE: number };
}
declare const SillyTavern: { getContext(): StContext } | undefined;
declare const toastr: { info(m: string): void; warning(m: string): void; error(m: string): void } | undefined;

const stContext = (): StContext => {
  try {
    return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
  } catch {
    return {};
  }
};

function notify(kind: 'info' | 'warning' | 'error', text: string): void {
  try {
    if (typeof toastr !== 'undefined') toastr[kind](text);
    else console.warn(`[st-translator] ${text}`);
  } catch {
    console.warn(`[st-translator] ${text}`);
  }
}

const POPUP_CONFIRM_FALLBACK = 2;
const RESULT_YES_FALLBACK = 1;

/** ST confirmation popup. Resolves true only when the user presses the OK button. */
async function confirmPopup(text: string, okLabel = '확인'): Promise<boolean> {
  const ctx = stContext();
  if (!ctx.callGenericPopup) return window.confirm(text);
  const result = await ctx.callGenericPopup(text, ctx.POPUP_TYPE?.CONFIRM ?? POPUP_CONFIRM_FALLBACK, '', { okButton: okLabel, cancelButton: '취소' });
  return result === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? RESULT_YES_FALLBACK) || result === true;
}

/** Popup holding a form; `onSubmit` returns false to keep it open (validation failed). */
async function formPopup(content: HTMLElement, okLabel: string, onSubmit: () => boolean): Promise<void> {
  const ctx = stContext();
  if (!ctx.callGenericPopup) return;
  const yes = ctx.POPUP_RESULT?.AFFIRMATIVE ?? RESULT_YES_FALLBACK;
  await ctx.callGenericPopup(content, ctx.POPUP_TYPE?.CONFIRM ?? POPUP_CONFIRM_FALLBACK, '', {
    okButton: okLabel,
    cancelButton: '취소',
    wide: true,
    allowVerticalScrolling: true,
    leftAlign: true,
    // Must return true explicitly to let the popup close.
    onClosing: (popup: { result?: unknown }) => (popup.result === yes ? onSubmit() : true),
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, children: Children = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in node) (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const button = (label: string, onClick: () => void, cls = '', title?: string) =>
  el('button', { type: 'button', class: `menu_button stt-btn ${cls}`.trim(), title: title ?? label, 'aria-label': title ?? label, onClick }, [label]);

const SUGGESTED_TAGS = ['choices', 'options', 'status', 'stats'];

const DISPLAY_LABELS: Record<DisplayMode, string> = {
  below: '원문 아래에 번역문',
  above: '번역문 먼저 (번역문 아래에 원문)',
  only: '번역문만 (원문 숨김)',
  collapsed: '원문 + 접힌 번역문',
  'collapsed-source': '번역문 + 접힌 원문',
  paragraph: '문단 대조 (Paragraph Reader)',
};

const SOURCE_TEXT: Record<ConnectionSource, string> = {
  chosen: '고른 연결',
  chat: '고른 연결',
  active: '지금 쓰는 연결 프로필',
  default: '기본 연결',
  first: '첫 연결',
  host: '지금 쓰는 API 연결',
};

const MENU_ID = 'stt_open_settings';
const DRAWER_ID = 'stt_settings_drawer';

export function mountSettings(api: TranslatorApi): () => void {
  let disposed = false;
  let dirty = false;
  let draft: ChatSettings = { ...DEFAULT_SETTINGS };
  let status = '';
  let markDirtyUi: (() => void) | null = null;

  // ---- drawer skeleton (ST's delegated `.inline-drawer-toggle` click handler toggles it) ----
  const panel = el('div', { class: 'stt-panel' });
  const drawer = el('div', { class: 'inline-drawer', id: DRAWER_ID }, [
    el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
      el('b', {}, ['양방향 번역']),
      el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
    ]),
    el('div', { class: 'inline-drawer-content' }, [panel]),
  ]);
  const wrapper = el('div', { class: 'stt-settings extension_container' }, [drawer]);

  // ---- placement: #extensions_settings2 and #extensionsMenu may be built after us ----
  let menuItem: HTMLElement | null = null;
  const place = (): boolean => {
    const host = document.getElementById('extensions_settings2');
    const menu = document.getElementById('extensionsMenu');
    if (host && !host.contains(wrapper)) host.append(wrapper);
    if (menu && !menu.querySelector(`#${MENU_ID}`)) {
      menuItem = el('div', { id: MENU_ID, class: 'list-group-item flex-container flexGap5', title: '양방향 번역 설정 열기' }, [
        el('div', { class: 'fa-solid fa-earth-asia extensionsMenuExtensionButton' }),
        el('span', {}, ['번역 설정']),
      ]);
      menuItem.addEventListener('click', openSettings);
      menu.append(menuItem);
    }
    return !!host && !!menu;
  };
  let observer: MutationObserver | null = null;
  if (!place()) {
    observer = new MutationObserver(() => {
      if (place()) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Never watch forever: both containers exist shortly after APP_READY.
    window.setTimeout(() => {
      observer?.disconnect();
      observer = null;
    }, 60_000);
  }

  /** Opens the extensions side panel (if closed), expands our drawer and scrolls to it. */
  function openSettings(): void {
    const block = document.getElementById('rm_extensions_block');
    if (block && !block.classList.contains('openDrawer')) {
      // Same click ST's own navbar icon gets; doNavbarIconClick toggles openDrawer/closedDrawer.
      document.querySelector<HTMLElement>('#extensions-settings-button .drawer-toggle')?.click();
    }
    const content = drawer.querySelector<HTMLElement>(':scope > .inline-drawer-content');
    const open = !!content && getComputedStyle(content).display !== 'none';
    if (!open) drawer.querySelector<HTMLElement>(':scope > .inline-drawer-toggle')?.click();
    // The panel slides open (animation); scroll after it has laid out.
    window.setTimeout(() => drawer.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
    // The wand menu would otherwise stay open on top of the panel.
    document.getElementById('extensionsMenu')?.style.setProperty('display', 'none');
  }

  // ---- focus: a rebuilt container must not drop keyboard focus ----
  const FOCUSABLE = 'input, select, textarea, button';
  function keepFocus(container: HTMLElement, rebuild: () => void): void {
    const active = document.activeElement as HTMLElement | null;
    const list = active && container.contains(active) ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    const at = active ? list.indexOf(active) : -1;
    const tag = active?.tagName;
    rebuild();
    if (at < 0) return;
    const next = container.querySelectorAll<HTMLElement>(FOCUSABLE)[at];
    if (next && next.tagName === tag && !(next as HTMLButtonElement).disabled) next.focus({ preventScroll: true });
  }
  let ownViewSave = false;

  // ---- paragraph view: fonts ----
  let fontStatusText = '모든 채팅에 적용 · 자동 저장';
  let viewSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let localView: ViewSettings = { ...DEFAULT_VIEW };
  let fontHost: HTMLElement | null = null;

  function applyFontVars(): void {
    const chat = document.getElementById('chat');
    chat?.style.setProperty('--stt-source-size', `${localView.sourceFontSize}px`);
    chat?.style.setProperty('--stt-translation-size', `${localView.translationFontSize}px`);
  }

  function changeFonts(values: Partial<ViewSettings>): void {
    localView = normalizeView({ ...localView, ...values });
    applyFontVars();
    fontStatusText = '크기 저장 중…';
    renderFonts();
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => {
      viewSaveTimer = null;
      const view = localView;
      fontStatusText = '크기를 저장했습니다.';
      renderFonts();
      // Our own font save changes nothing else in the panel: do not rebuild it (keeps keyboard focus).
      ownViewSave = true;
      try {
        api.saveView(view);
      } finally {
        ownViewSave = false;
      }
    }, 300);
  }

  /** Font sizes for the paragraph view. They apply and save at once (not part of the save button). */
  function renderFonts(): void {
    if (!fontHost) return;
    const host = fontHost;
    keepFocus(host, () => buildFonts(host));
  }

  function buildFonts(host: HTMLElement): void {
    const rows = ([['sourceFontSize', '원문'], ['translationFontSize', '번역']] as const).map(([key, label]) => {
      const value = localView[key];
      const range = el('input', { type: 'range', min: FONT_MIN, max: FONT_MAX, step: 1, value, 'aria-label': `${label} 글자 크기` });
      range.addEventListener('change', () => changeFonts({ [key]: Number(range.value) }));
      const minus = button('−', () => changeFonts({ [key]: Math.max(FONT_MIN, value - 1) }), 'stt-step', `${label} 글자 크기 줄이기`);
      const plus = button('+', () => changeFonts({ [key]: Math.min(FONT_MAX, value + 1) }), 'stt-step', `${label} 글자 크기 키우기`);
      // aria-disabled instead of disabled: a disabled button that has focus drops it (the click clamps anyway).
      minus.setAttribute('aria-disabled', String(value <= FONT_MIN));
      plus.setAttribute('aria-disabled', String(value >= FONT_MAX));
      return el('div', { class: 'stt-font-row' }, [el('label', { class: 'stt-font-label' }, [el('span', {}, [label]), range]), minus, el('output', {}, [`${value}px`]), plus]);
    });
    host.replaceChildren(
      el('span', {}, [`글자 크기 · 원문 ${localView.sourceFontSize} / 번역 ${localView.translationFontSize}`]),
      ...rows,
      el('div', { class: 'stt-row' }, [
        button('기본 크기', () => changeFonts({ sourceFontSize: DEFAULT_VIEW.sourceFontSize, translationFontSize: DEFAULT_VIEW.translationFontSize })),
        el('span', { class: 'stt-note' }, [fontStatusText]),
      ]),
    );
  }

  // ---- form helpers ----
  function markDirty(): void {
    dirty = true;
    status = '';
    markDirtyUi?.();
  }

  function clearDirty(): void {
    dirty = false;
    markDirtyUi?.();
  }

  function check(label: string, key: keyof ChatSettings, onChange?: () => void): HTMLElement {
    const input = el('input', { type: 'checkbox', checked: draft[key] === true });
    input.addEventListener('change', () => {
      (draft as unknown as Record<string, unknown>)[key] = input.checked;
      markDirty();
      onChange?.();
    });
    return el('label', { class: 'checkbox_label stt-check' }, [input, el('span', {}, [label])]);
  }

  /** Compat switches are global and saved at once (not part of the save button). */
  function compatCheck(label: string, key: keyof CompatSettings): HTMLElement {
    const input = el('input', { type: 'checkbox', checked: api.getStore().compat[key] === true });
    input.addEventListener('change', () => api.saveCompat({ ...api.getStore().compat, [key]: input.checked }));
    return el('label', { class: 'checkbox_label stt-check' }, [input, el('span', {}, [label])]);
  }

  function text(label: string, key: keyof ChatSettings, opts: { multiline?: boolean; placeholder?: string; cls?: string } = {}): HTMLElement {
    const input = opts.multiline
      ? el('textarea', { value: String(draft[key] ?? ''), placeholder: opts.placeholder ?? '', class: `text_pole ${opts.cls ?? ''}`.trim(), spellcheck: false })
      : el('input', { type: 'text', class: 'text_pole', value: String(draft[key] ?? ''), placeholder: opts.placeholder ?? '' });
    input.setAttribute('data-stt-field', key);
    input.addEventListener('input', () => {
      (draft as unknown as Record<string, unknown>)[key] = input.value;
      // The same setting can appear in two places (내 언어 / 도착 언어): keep them equal.
      panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[data-stt-field="${key}"]`).forEach((other) => {
        if (other !== input) other.value = input.value;
      });
      markDirty();
    });
    return el('label', { class: 'stt-field' }, [el('span', {}, [label]), input]);
  }

  function numberField(label: string, value: number, attrs: { min?: number; max?: number; step?: number }, onInput: (n: number) => void): HTMLElement {
    const n = el('input', { type: 'number', class: 'text_pole', value, ...attrs });
    n.addEventListener('input', () => {
      onInput(Number(n.value));
      markDirty();
    });
    return el('label', { class: 'stt-field' }, [el('span', {}, [label]), n]);
  }

  function select(label: string, value: string, options: Array<[string, string]>, onChange: (v: string) => void, unsaved = true, rerender = false): HTMLElement {
    const s = el('select', { class: 'text_pole' }, options.map(([v, l]) => el('option', { value: v, selected: v === value }, [l])));
    s.addEventListener('change', () => {
      onChange(s.value);
      // Mark dirty before re-rendering: renderPanel() rebuilds the draft from the saved settings when clean.
      if (unsaved) markDirty();
      if (rerender) renderPanel();
    });
    return el('label', { class: 'stt-field' }, [el('span', {}, [label]), s]);
  }

  // ---- prompts and presets ----
  function promptSection(direction: 'incoming' | 'outgoing', presets: PresetSummary[]): HTMLElement {
    const presetKey = direction === 'incoming' ? 'incomingPresetId' : 'outgoingPresetId';
    const promptKey = direction === 'incoming' ? 'incomingPrompt' : 'outgoingPrompt';
    const presetId = draft[presetKey];
    const preset = presets.find((p) => p.id === presetId);
    const inherit = !preset || presetId === INHERIT_PRESET_ID;
    const box = el('div', { class: 'stt-field' });
    const options: Array<[string, string]> = presets.map((p) => [p.id, p.builtin ? p.name : `${p.name} (내 프리셋)`]);
    box.append(
      select(direction === 'incoming' ? '응답 번역 프롬프트 (Incoming)' : '내 메시지 번역 프롬프트 (Outgoing)', presetId, options, (v) => {
        draft[presetKey] = v;
      }, true, true),
    );
    if (inherit) {
      box.append(text('이 채팅의 프롬프트 (비워 두면 기본 번역 프롬프트, {{targetLanguage}} 사용 가능)', promptKey, { multiline: true, cls: 'stt-prompt', placeholder: MARINARA_TRANSLATION_GENERAL_PROMPTS.base }));
    } else {
      box.append(el('textarea', { class: 'text_pole stt-prompt', readOnly: true, value: preset.prompt }));
    }
    box.append(el('span', { class: 'stt-note' }, ['저장한 뒤 새로 번역하는 메시지부터 적용됩니다. 이미 번역된 메시지는 메시지의 "다시 번역" 버튼으로 새로 번역하세요.']));
    return box;
  }

  function editPreset(existing: PresetSummary | null): void {
    const name = el('input', { type: 'text', class: 'text_pole', value: existing?.name ?? '', placeholder: '프리셋 이름' });
    const prompt = el('textarea', { class: 'text_pole', value: existing?.prompt ?? '', placeholder: '번역 시스템 프롬프트. {{targetLanguage}} 는 대상 언어로 바뀝니다.', spellcheck: false });
    const form = el('div', { class: 'stt-modal' }, [
      el('h3', {}, [existing ? '프리셋 수정' : '새 프리셋']),
      el('label', { class: 'stt-field' }, [el('span', {}, ['이름']), name]),
      el('label', { class: 'stt-field' }, [el('span', {}, ['프롬프트 전문']), prompt]),
    ]);
    void formPopup(form, '저장', () => {
      if (!name.value.trim() || !prompt.value.trim()) {
        notify('warning', '이름과 프롬프트를 입력해 주세요.');
        return false;
      }
      try {
        api.savePreset({ id: existing?.id ?? '', name: name.value, prompt: prompt.value });
        return true;
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e));
        return false;
      }
    });
  }

  function presetManager(presets: PresetSummary[]): HTMLElement {
    const mine = presets.filter((p) => !p.builtin);
    const row = el('div', { class: 'stt-row' }, [
      button('+ 새 프리셋', () => editPreset(null)),
      button('기본 프리셋 복사해서 새로 만들기', () => {
        const base = presets.find((p) => p.id === draft.incomingPresetId && p.prompt);
        editPreset(base ? { ...base, id: '', name: `${base.name} 사본`, builtin: false } : null);
      }, '', '응답 번역에 선택된 프리셋을 복사합니다'),
    ]);
    const list = mine.map((p) =>
      el('div', { class: 'stt-row' }, [
        el('span', { class: 'stt-grow' }, [p.name]),
        button('수정', () => editPreset(p)),
        button('삭제', async () => {
          if (await confirmPopup(`"${p.name}" 프리셋을 삭제할까요? 이 프리셋을 쓰던 채팅은 "채팅 설정 유지"로 돌아갑니다.`, '삭제')) api.deletePreset(p.id);
        }, 'stt-danger'),
      ]),
    );
    return el('div', { class: 'stt-field' }, [row, ...(list.length ? list : [el('span', { class: 'stt-note' }, ['내 프리셋이 없습니다. 기본 프리셋은 읽기 전용입니다.'])])]);
  }

  // ---- bundles ----
  function editBundle(existing: UserBundle | null): void {
    const source = existing ?? draft;
    const name = el('input', { type: 'text', class: 'text_pole', value: existing?.name ?? '', placeholder: '묶음 이름' });
    const glossary = el('textarea', { class: 'text_pole', value: source.glossary, spellcheck: false, placeholder: '내 언어 용어 = 모델 언어 용어' });
    const freeContext = el('textarea', { class: 'text_pole', value: source.freeContext, spellcheck: false });
    const voice = el('textarea', { class: 'text_pole', value: source.incomingVoicePrompt, spellcheck: false });
    const form = el('div', { class: 'stt-modal stt-bundle-editor' }, [
      el('h3', {}, [existing ? '묶음 편집' : '새 묶음으로 저장']),
      el('div', { class: 'stt-note' }, [existing
        ? '저장하면 이 묶음을 사용하는 모든 방의 다음 번역부터 반영됩니다.'
        : '이 방에 입력한 단어집·추가 지침·캐릭터 말투를 복사합니다. 저장 후 목록에서 선택해 주세요. 방의 입력 내용은 그대로 남습니다.']),
      el('label', { class: 'stt-field' }, [el('span', {}, ['이름']), name]),
      el('label', { class: 'stt-field' }, [el('span', {}, ['단어집']), glossary]),
      el('label', { class: 'stt-field' }, [el('span', {}, ['추가 지침']), freeContext]),
      el('label', { class: 'stt-field' }, [el('span', {}, ['캐릭터 말투 (응답 번역에만)']), voice]),
    ]);
    void formPopup(form, '저장', () => {
      if (!name.value.trim()) {
        notify('warning', '묶음 이름을 입력해 주세요.');
        return false;
      }
      try {
        api.saveBundle({ id: existing?.id ?? '', name: name.value, glossary: glossary.value, freeContext: freeContext.value, incomingVoicePrompt: voice.value });
        return true;
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e));
        return false;
      }
    });
  }

  function bundleSection(): HTMLElement {
    const bundles = api.getStore().userBundles;
    const selected = bundles.find((b) => b.id === draft.bundleId);
    const edit = button('묶음 편집', () => { if (selected) editBundle(selected); });
    const remove = button('삭제', async () => {
      if (!selected) return;
      const ok = await confirmPopup(`"${selected.name}" 묶음을 삭제할까요? 이 묶음을 쓰는 모든 방과 새 채팅 기본값의 선택이 "없음"으로 바뀝니다. 각 방에 추가한 내용은 남습니다.`, '삭제');
      if (ok) api.deleteBundle(selected.id);
    }, 'stt-danger');
    edit.disabled = remove.disabled = !selected;
    const preview = selected ? el('details', { class: 'stt-bundle-preview' }, [
      el('summary', {}, [`${selected.name} · 내용 보기 (읽기 전용)`]),
      ...([
        ['단어집', selected.glossary], ['추가 지침', selected.freeContext], ['캐릭터 말투', selected.incomingVoicePrompt],
      ] as const).map(([label, value]) => el('label', { class: 'stt-field' }, [
        el('span', {}, [label]), el('textarea', { class: 'text_pole', readOnly: true, value, placeholder: '내용 없음' }),
      ])),
    ]) : null;
    return el('div', { class: 'stt-section' }, [
      el('h3', {}, ['번역 지침 묶음']),
      select('이 방의 묶음', draft.bundleId, [['', '없음'], ...bundles.map((b): [string, string] => [b.id, b.name])], (value) => {
        draft.bundleId = value;
      }, true, true),
      el('div', { class: 'stt-row' }, [button('새 묶음으로 저장', () => editBundle(null), '', '이 방의 현재 3개 내용으로 새 묶음 저장'), edit, remove]),
      el('div', { class: 'stt-note' }, ['묶음 선택은 아래 저장 버튼으로 적용합니다. 추가 지침·말투의 사용 여부는 방마다 정하며, 묶음과 이 방 추가분에 함께 적용됩니다. 같은 용어는 이 방 단어장이 우선합니다.']),
      preview,
    ]);
  }

  // ---- save ----
  function save(asDefault: boolean): boolean {
    try {
      draft.excludeTags = parseTags(draft.excludeTags).join(', ');
    } catch (e) {
      notify('error', e instanceof ExcludeRuleError ? e.message : '제외할 태그 이름을 확인해 주세요.');
      return false;
    }
    // Clear before saving: the save fires onChange, which re-renders from the saved settings when clean.
    clearDirty();
    status = asDefault ? '저장했습니다. 새 채팅의 기본값으로도 저장했습니다.' : '저장했습니다.';
    try {
      api.saveSettings({ ...draft }, asDefault);
    } catch (e) {
      dirty = true;
      status = '';
      notify('error', e instanceof Error ? e.message : String(e));
      markDirtyUi?.();
    }
    return !dirty;
  }

  /** The scrolling ancestor (ST's extensions block) jumps when the panel is rebuilt: keep its position. */
  function scrollParent(): HTMLElement | null {
    let n: HTMLElement | null = panel.parentElement;
    while (n) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return null;
  }

  function connectionBlock(connectionOptions: Array<[string, string]>): HTMLElement[] {
    const connections = api.connections();
    const picked = pickConnection(
      connections.map((c) => ({ id: c.id, name: c.name, is_default: c.isDefault })),
      draft.connectionId || undefined,
      { activeId: api.activeConnectionId() ?? undefined },
    );
    const pickedName = picked ? (connections.find((c) => c.id === picked.id)?.name ?? picked.id) : '';
    // Same rule as the translation itself (complete.ts): chosen connection -> active connection profile -> current API.
    const usesProfile = !!picked && (!!draft.connectionId || picked.source === 'active' || picked.source === 'chosen');
    const note = !connections.length
      ? el('div', { class: 'stt-note stt-warn' }, ['연결을 고르려면 SillyTavern의 Connection Manager(연결 프로필)가 필요합니다. 지금은 현재 API 연결로 번역합니다.'])
      : el('div', { class: `stt-note${picked?.staleId ? ' stt-warn' : ''}` }, [
          picked?.staleId
            ? `고른 연결이 삭제돼 대신 ${usesProfile ? `"${pickedName}" (${SOURCE_TEXT[picked.source]})` : SOURCE_TEXT.host}으로 번역합니다. 다시 골라 주세요.`
            : usesProfile
              ? `번역에 쓰일 연결: ${pickedName} (${SOURCE_TEXT[picked!.source]}). 연결은 모든 채팅에 공통이며, 고르는 즉시 저장됩니다.`
              : `번역에 쓰일 연결: ${SOURCE_TEXT.host}. 연결 프로필을 고르지 않았고 지금 쓰는 연결 프로필도 없습니다. 연결은 모든 채팅에 공통이며, 고르는 즉시 저장됩니다.`,
        ]);
    return [
      select('번역에 쓸 AI 연결', draft.connectionId, connectionOptions, (v) => {
        draft.connectionId = v;
        status = '연결을 저장했습니다.';
        api.saveConnection(v);
      }, false),
      note,
    ];
  }

  function renderPanel(): void {
    if (disposed) return;
    keepFocus(panel, buildPanel);
  }

  function buildPanel(): void {
    const keepScroll = scrollParent();
    const scrollTop = keepScroll?.scrollTop ?? 0;
    const chatId = api.chatId();
    const presets = api.presets();
    const connections = api.connections();
    const store = api.getStore();
    if (!dirty) {
      draft = { ...api.settings() };
      draft.connectionId = effectiveConnectionId(store, chatId);
    }
    // A shared bundle can be deleted while this room has other unsaved edits.
    if (draft.bundleId && !store.userBundles.some((b) => b.id === draft.bundleId)) draft.bundleId = '';
    const connectionOptions: Array<[string, string]> = [
      ['', '자동 (고른 연결 → 지금 쓰는 연결 프로필 → 지금 쓰는 API)'],
      ...connections.map((c): [string, string] => [c.id, `${c.name} · ${c.model}${c.isDefault ? ' (기본)' : ''}`]),
    ];
    if (draft.connectionId && !connections.some((c) => c.id === draft.connectionId)) connectionOptions.push([draft.connectionId, '(삭제된 연결)']);

    const saveNotice = el('span', { class: 'stt-unsaved-note', role: 'status' }, ['저장하지 않은 변경이 있어요. 저장 버튼을 눌러야 적용됩니다.']);
    const saveRow = el('div', { class: 'stt-row stt-sticky' }, [
      saveNotice,
      button('저장', () => save(false), 'stt-primary'),
      chatId ? button('저장 + 새 채팅 기본값으로', () => save(true)) : null,
      button('되돌리기', () => {
        clearDirty();
        renderPanel();
      }),
      status ? el('span', { class: 'stt-note' }, [status]) : null,
    ]);
    markDirtyUi = () => {
      saveRow.classList.toggle('stt-unsaved', dirty);
      saveNotice.hidden = !dirty;
      drawer.classList.toggle('stt-dirty', dirty);
    };
    markDirtyUi();

    const contextSub = el('div', { class: 'stt-sub' }, [
      el('div', { class: 'stt-row' }, [check('원문 포함', 'contextIncludeOriginal'), check('번역문 포함', 'contextIncludeTranslation'), check('내 메시지 번역에도 포함', 'contextIncludeUserInput')]),
      numberField('최근 메시지 수 (1~10)', draft.contextMessageCount, { min: 1, max: 10 }, (n) => { draft.contextMessageCount = n || 3; }),
    ]);
    fontHost = el('div', { class: 'stt-field' });
    const paragraphMode = draft.displayMode === 'paragraph';
    const paragraphSection = () => el('div', { class: 'stt-section' }, [
      el('h3', {}, ['문단 대조 (Paragraph Reader)']),
      select('보기', localView.paragraphView, [['interleave', '원문·번역 교차'], ['tap', '눌러서 원문 (번역만 보이고, 문단마다 눌러서 원문을 펼침)']], (v) => {
        localView = { ...localView, paragraphView: v === 'tap' ? 'tap' : 'interleave' };
        api.saveView(localView);
      }, false),
      localView.paragraphView === 'interleave'
        ? select('문단 안 순서', localView.paragraphOrder, [['source-first', '원문 → 번역'], ['translation-first', '번역 → 원문']], (v) => {
            localView = { ...localView, paragraphOrder: (v === 'translation-first' ? 'translation-first' : 'source-first') as ParagraphOrder };
            api.saveView(localView);
          }, false)
        : null,
      text('도착 언어 (응답을 번역할 언어, "내 언어"와 같은 설정)', 'myLanguage'),
      fontHost,
      el('div', { class: 'stt-note' }, ['보기와 글자 크기는 바로 적용되고 저장됩니다. 도착 언어는 아래 저장 버튼으로 저장합니다.']),
    ]);

    panel.replaceChildren(
      el('div', { class: 'stt-note' }, [chatId ? '지금 열린 채팅의 번역 설정입니다.' : '열린 채팅이 없어 새 채팅의 기본값을 편집합니다.']),
      el('div', { class: 'stt-section' }, [
        el('h3', {}, ['기본 번역']),
        ...connectionBlock(connectionOptions),
        el('div', { class: 'stt-row' }, [text('모델 언어 (내 메시지를 이 언어로)', 'modelLanguage'), text('내 언어 (응답을 이 언어로)', 'myLanguage')]),
        numberField(`번역 최대 출력 토큰 (${MAX_TOKENS_MIN}~${MAX_TOKENS_MAX})`, draft.maxTokens, { min: MAX_TOKENS_MIN, max: MAX_TOKENS_MAX, step: 256 }, (n) => { draft.maxTokens = n; }),
        check('AI 응답 자동 번역', 'autoTranslate'),
        check('번역이 끊기면 자동으로 이어서 번역', 'autoContinue'),
        select('번역문 표시 방식', draft.displayMode, Object.entries(DISPLAY_LABELS) as Array<[string, string]>, (v) => (draft.displayMode = v as DisplayMode), true, true),
        select('번역 단위', draft.translationUnit, [
          ['whole', '메시지 통째로 (1회 요청, 문단 수가 같으면 문단별로 맞춰 보여 줌)'],
          ['paragraph', '문단별 (문단마다 1회 요청, 문단 대조가 정확히 맞음)'],
        ], (v) => (draft.translationUnit = v === 'paragraph' ? 'paragraph' : 'whole')),
        check('내 메시지를 보내기 전에 번역 (채팅에는 번역문이 남습니다)', 'translateMyMessages'),
        check('입력창 옆에 번역 버튼 표시', 'showDraftButton'),
      ]),
      ...(paragraphMode ? [paragraphSection()] : []),
      el('div', { class: 'stt-section' }, [el('h3', {}, ['프롬프트 프리셋']), promptSection('incoming', presets), promptSection('outgoing', presets), presetManager(presets)]),
      bundleSection(),
      el('div', { class: 'stt-section' }, [
        el('h3', {}, ['단어장']),
        text('이 방에만 추가 · 한 줄에 한 쌍: 내 언어 용어 = 모델 언어 용어 (양방향 적용)', 'glossary', { multiline: true, placeholder: '마리나라 = Marinara\n로어북 = lorebook' }),
      ]),
      el('div', { class: 'stt-section' }, [
        el('h3', {}, ['참고 정보']),
        check('기타 지침 추가 (장르·시대·지역·배경 등)', 'freeContextEnabled', renderPanel),
        draft.freeContextEnabled ? el('div', { class: 'stt-sub' }, [text('이 방에만 추가 · 기타 지침', 'freeContext', { multiline: true })]) : null,
        check('대사 지침 추가 (응답 번역에만)', 'incomingVoiceEnabled', renderPanel),
        draft.incomingVoiceEnabled ? el('div', { class: 'stt-sub' }, [text('이 방에만 추가 · 대사 지침 (# Character Voice Instructions)', 'incomingVoicePrompt', { multiline: true })]) : null,
        check('이전 대화를 번역 참고로 포함', 'contextEnabled', renderPanel),
        draft.contextEnabled ? contextSub : null,
      ]),
      el('div', { class: 'stt-section' }, [
        el('h3', {}, ['번역하지 않을 부분']),
        check('HTML 태그·속성, <style>, <script> 는 그대로 두고 글자만 번역', 'protectHtml'),
        check('코드 블록(```) 은 번역하지 않음', 'protectCode'),
        el('div', { class: 'stt-field' }, [
          text('제외할 HTML 태그 (쉼표·공백으로 구분)', 'excludeTags', { placeholder: 'choices, status, ui' }),
          el('div', { class: 'stt-row' }, [
            button('추천 태그 넣기', () => {
              const have = new Set(lenientTags(draft.excludeTags));
              for (const t of SUGGESTED_TAGS) have.add(t);
              draft.excludeTags = [...have].join(', ');
              markDirty();
              renderPanel();
            }, '', `${SUGGESTED_TAGS.join(', ')} 를 목록에 더합니다`),
          ]),
          el('div', { class: 'stt-note' }, ['이 태그의 요소(여는 태그부터 닫는 태그까지, 안쪽 내용 포함)는 번역에 보내지 않고 그대로 되돌립니다. <style>·<script> 는 항상 제외됩니다. strong·em 은 안의 글자를 그대로 번역합니다.']),
        ]),
        text('제외 규칙 (한 줄에 하나)', 'excludeRules', { multiline: true, placeholder: '<status>\n/HP: \\d+\\/\\d+/\n[상태창] ... [/상태창]' }),
        el('div', { class: 'stt-note' }, ['<태그> 는 그 요소 전체, /정규식/ 은 일치하는 부분, 시작 ... 끝 은 그 사이 전체를 원문 그대로 둡니다. {{매크로}} 는 항상 그대로 둡니다.']),
      ]),
      el('div', { class: 'stt-section' }, [
        el('h3', {}, ['긴 지문']),
        numberField('이 글자 수 이상이면 문단별로 나눠 번역 (0 = 나누지 않음)', draft.longSplitChars, { min: 0, step: 500 }, (n) => { draft.longSplitChars = Math.max(0, n || 0); }),
      ]),
      el('div', { class: 'stt-section' }, [
        el('h3', {}, ['다른 확장과 함께 쓰기']),
        compatCheck('LoreVeil 태그 보호 (내 메시지 번역)', 'loreveil'),
        compatCheck('제외 태그·코드 블록은 한 번만 표시 (원문과 번역을 함께 보여 줄 때)', 'singleInstance'),
        compatCheck('JS 러너(Tavern Helper) 다시 그리기', 'thRerender'),
        compatCheck('디버그 로그', 'debug'),
        el('div', { class: 'stt-note' }, ['이 항목은 바로 저장됩니다. LoreVeil 의 속성 방식(<div 태그>)은 위의 HTML 보호가 켜져 있어야 닫는 태그까지 지켜집니다.']),
      ]),
      saveRow,
    );
    renderFonts();
    if (keepScroll) keepScroll.scrollTop = scrollTop;
  }

  // Translate / continue ask to save first when there are unsaved edits (runtime consults this).
  api.setUnsavedGuard({ isDirty: () => dirty, save: () => save(false) });

  // Leaving the page with unsaved settings loses them: let the browser ask first.
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  const off = api.onChange((reason) => {
    // Unsaved edits belong to the chat they were made in.
    if (reason === 'chat') dirty = false;
    if (!viewSaveTimer) localView = { ...api.getStore().view };
    applyFontVars();
    if (ownViewSave) return;
    renderPanel();
  });

  localView = { ...api.getStore().view };
  applyFontVars();
  renderPanel();

  return () => {
    disposed = true;
    off();
    api.setUnsavedGuard(null);
    observer?.disconnect();
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (viewSaveTimer) {
      clearTimeout(viewSaveTimer);
      viewSaveTimer = null;
      api.saveView(localView);
    }
    menuItem?.remove();
    wrapper.remove();
  };
}
