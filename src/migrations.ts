// Legacy settings are converted before normalization; runtime protection only uses explicit tags.
import { lenientTags } from './translate/protect';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function migrateStore(value: unknown): Record<string, unknown> {
  const raw = object(value);
  const compat = object(raw.compat);
  const legacy = raw.compat != null && typeof raw.compat === 'object' && !Array.isArray(raw.compat)
    && !('singleInstance' in compat);
  // The old autopic switch defaulted to true, including saved compat objects without that key.
  const enabled = legacy && compat.autopic !== false;
  const tags = lenientTags(typeof raw.legacyExcludeTags === 'string' ? raw.legacyExcludeTags : '');
  if (enabled && !tags.includes('autopic')) tags.push('autopic');
  const { autopic: _old, ...currentCompat } = compat;
  if (legacy) currentCompat.singleInstance = enabled;

  const migrateSettings = (value: unknown, fallbackTags: string): Record<string, unknown> => {
    const settings = object(value);
    if (!tags.length || settings.excludeTagsVersion === 1) return settings;
    const have = lenientTags(typeof settings.excludeTags === 'string' ? settings.excludeTags : fallbackTags);
    return { ...settings, excludeTags: [...new Set([...have, ...tags])].join(', '), excludeTagsVersion: 1 };
  };
  const defaults = migrateSettings(raw.defaults, '');
  const chats = Object.fromEntries(Object.entries(object(raw.chats)).map(([id, settings]) =>
    [id, migrateSettings(settings, typeof defaults.excludeTags === 'string' ? defaults.excludeTags : '')],
  ));
  return {
    ...raw,
    compat: currentCompat,
    defaults,
    chats,
    // Keep this after the old switch is removed: unopened chats still need the same migration.
    legacyExcludeTags: tags.join(', '),
  };
}
