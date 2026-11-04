import type { ChatSettings, Store, UserBundle } from './shared';
import { parseGlossary } from './translate/glossary';

export type GuideLibrary = Pick<Store, 'userBundles'>;
export type Guides = Pick<ChatSettings, 'glossary' | 'freeContext' | 'incomingVoicePrompt'>;

/** Resolve links at request time without changing the saved room additions or enable toggles. */
export function effectiveGuides(store: GuideLibrary, settings: ChatSettings): Guides {
  const bundle = store.userBundles.find((b) => b.id === settings.bundleId);
  if (!bundle) return { glossary: settings.glossary, freeContext: settings.freeContext, incomingVoicePrompt: settings.incomingVoicePrompt };
  const roomTerms = new Set(parseGlossary(settings.glossary).map((p) => p.left));
  const glossary = [
    ...parseGlossary(bundle.glossary).filter((p) => !roomTerms.has(p.left)),
    ...parseGlossary(settings.glossary),
  ].map((p) => `${p.left} = ${p.right}`).join('\n');
  const join = (base: string, room: string) => [base.trim(), room.trim()].filter(Boolean).join('\n\n');
  return {
    glossary,
    freeContext: join(bundle.freeContext, settings.freeContext),
    incomingVoicePrompt: join(bundle.incomingVoicePrompt, settings.incomingVoicePrompt),
  };
}

/** randomUUID is secure-context-only; getRandomValues also works on plain HTTP. */
export function newBundleId(cryptoApi: Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>> | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === 'function') return `bundle-${cryptoApi.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `bundle-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Update the shared library, keeping references linked to the same id. */
export function saveBundle(store: Store, value: UserBundle): UserBundle {
  if (!value || typeof value.name !== 'string' || !value.name.trim()) throw new Error('묶음 이름을 입력해 주세요.');
  const existing = store.userBundles.findIndex((b) => b.id === value.id);
  let id = existing >= 0 ? store.userBundles[existing]!.id : newBundleId();
  while (existing < 0 && store.userBundles.some((b) => b.id === id)) id = newBundleId();
  const bundle: UserBundle = {
    id, name: value.name.trim(),
    glossary: typeof value.glossary === 'string' ? value.glossary : '',
    freeContext: typeof value.freeContext === 'string' ? value.freeContext : '',
    incomingVoicePrompt: typeof value.incomingVoicePrompt === 'string' ? value.incomingVoicePrompt : '',
  };
  if (existing >= 0) store.userBundles[existing] = bundle;
  else store.userBundles.push(bundle);
  return bundle;
}

export function deleteBundle(store: Store, id: string): void {
  store.userBundles = store.userBundles.filter((b) => b.id !== id);
  for (const settings of [store.defaults, ...Object.values(store.chats)]) {
    if (settings.bundleId === id) settings.bundleId = '';
  }
}
