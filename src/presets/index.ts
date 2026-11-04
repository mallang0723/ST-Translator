// Every built-in preset of Translation Tools 1.5.4 (legacy, v2 and additional ones),
// in the upstream display order, followed by the user's own presets.

import type { PresetSummary, UserPreset } from '../shared';
import type { PromptPreset } from '../translate/prompt';
import { ADDITIONAL_BUILTIN_PRESETS, BUILTIN_PRESET_ORDER, BUILTIN_PRESETS, V2_PRESETS } from './catalog';

interface CatalogPreset {
  id: string;
  name: string;
  prompt: string;
  replace: boolean;
}

const BUILTINS: CatalogPreset[] = [...BUILTIN_PRESETS, ...V2_PRESETS, ...ADDITIONAL_BUILTIN_PRESETS]
  .map((p) => ({ id: p.id, name: p.name, prompt: p.prompt, replace: p.replace }))
  .sort((a, b) => (BUILTIN_PRESET_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (BUILTIN_PRESET_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER));

export const BUILTIN_IDS = new Set(BUILTINS.map((p) => p.id));

export function promptPresets(userPresets: UserPreset[]): PromptPreset[] {
  return [
    ...BUILTINS.map((p) => ({ id: p.id, prompt: p.prompt, replace: p.replace })),
    ...userPresets.map((p) => ({ id: p.id, prompt: p.prompt, replace: true })),
  ];
}

export function presetSummaries(userPresets: UserPreset[]): PresetSummary[] {
  return [
    ...BUILTINS.map((p) => ({ id: p.id, name: p.name, prompt: p.replace ? p.prompt : '', builtin: true })),
    ...userPresets.map((p) => ({ id: p.id, name: p.name, prompt: p.prompt, builtin: false })),
  ];
}
