// Preset catalog copied verbatim from Marinara-Translation-Tools 1.5.4 extension.js
// (lines 17-162, MIT, (c) 2026 minikkuen). Only the imports and exports were added,
// so the upstream SHA-256 fingerprints (tests/prompt-fingerprints.json) still match.
// Do not edit by hand.
/* eslint-disable */
import { MARINARA_TRANSLATION_GENERAL_PROMPTS } from './upstream/general';
import { MARINARA_TRANSLATION_LITERARY_PROMPTS } from './upstream/literary';
import { MARINARA_TRANSLATION_BILINGUAL_PROMPTS } from './upstream/bilingual-dialogue';
import { MARINARA_TRANSLATION_PARAPHRASE_PROMPTS } from './upstream/paraphrase';
import { MARINARA_TRANSLATION_SOURCE_STYLE_PROMPTS } from './upstream/source-style';
import { MARINARA_TRANSLATION_INPUT_PROMPTS } from './upstream/input';

const { base: BASE_PROMPT, roleplay: ORIGINAL_ROLEPLAY_PROMPT, literaryRoleplay: LITERARY_ROLEPLAY_PROMPT } =
  MARINARA_TRANSLATION_GENERAL_PROMPTS;
const BUILTIN_PRESETS = Object.freeze([
  Object.freeze({
    id: "builtin-inherit",
    name: "채팅 설정 유지",
    prompt: BASE_PROMPT,
    replace: false,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-roleplay",
    name: "자연스러운 RP",
    prompt: ORIGINAL_ROLEPLAY_PROMPT,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-literary-roleplay",
    name: "범용 문학·RP",
    prompt: LITERARY_ROLEPLAY_PROMPT,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-english-korean",
    name: "영어→한국어 문학·RP",
    prompt: MARINARA_TRANSLATION_LITERARY_PROMPTS.legacy.english,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-chinese-korean",
    name: "중국어→한국어 문학·RP",
    prompt: MARINARA_TRANSLATION_LITERARY_PROMPTS.legacy.chinese,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-japanese-korean",
    name: "일본어→한국어 문학·RP",
    prompt: MARINARA_TRANSLATION_LITERARY_PROMPTS.legacy.japanese,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-bilingual-dialogue-korean",
    name: "원문 대사 병기·한국어 RP",
    prompt: MARINARA_TRANSLATION_BILINGUAL_PROMPTS.legacy,
    replace: true,
    builtin: true,
  }),
]);
const V2_PRESETS = [
  {
    id: "builtin-english-korean-v2",
    legacyId: "builtin-english-korean",
    sourceId: "custom-6d2179ba-aa61-443d-b4d0-2871f3b71dd4",
    name: "영어→한국어 문학·RP v2",
    prompt: MARINARA_TRANSLATION_LITERARY_PROMPTS.v2.english,
    replace: true,
    builtin: true,
  },
  {
    id: "builtin-japanese-korean-v2",
    legacyId: "builtin-japanese-korean",
    sourceId: "custom-50681179-369c-47e6-8aa0-c784d6b4f4c4",
    name: "일본어→한국어 문학·RP v2",
    prompt: MARINARA_TRANSLATION_LITERARY_PROMPTS.v2.japanese,
    replace: true,
    builtin: true,
  },
  {
    id: "builtin-chinese-korean-v2",
    legacyId: "builtin-chinese-korean",
    sourceId: "custom-bb53f4d1-e48e-4458-855b-36aeed276cf7",
    name: "중국어→한국어 문학·RP v2",
    prompt: MARINARA_TRANSLATION_LITERARY_PROMPTS.v2.chinese,
    replace: true,
    builtin: true,
  },
  {
    id: "builtin-bilingual-dialogue-korean-v2",
    legacyId: "builtin-bilingual-dialogue-korean",
    sourceId: "custom-05aa88b0-9167-4567-8eb0-bd55007c1669",
    name: "원문 대사 병기·한국어 RP v2",
    prompt: MARINARA_TRANSLATION_BILINGUAL_PROMPTS.v2,
    replace: true,
    builtin: true,
  },
];
const ADDITIONAL_BUILTIN_PRESETS = Object.freeze([
  Object.freeze({
    id: "builtin-english-paraphrase-korean",
    name: "영어→한국어 의역·문학·RP",
    prompt: MARINARA_TRANSLATION_PARAPHRASE_PROMPTS.english,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-english-source-style-korean",
    name: "영어→영문학 번역체·RP",
    prompt: MARINARA_TRANSLATION_SOURCE_STYLE_PROMPTS.english,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-chinese-paraphrase-korean",
    name: "중국어→한국어 의역·문학·RP",
    prompt: MARINARA_TRANSLATION_PARAPHRASE_PROMPTS.chinese,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-literary-roleplay-input",
    name: "문학·RP·3인칭 지문 인풋용",
    prompt: MARINARA_TRANSLATION_INPUT_PROMPTS.literaryRoleplay,
    replace: true,
    builtin: true,
  }),
  Object.freeze({
    id: "builtin-literary-roleplay-input-bilingual-dialogue",
    name: "문학·RP·3인칭 지문 인풋용 대사 병기",
    prompt: MARINARA_TRANSLATION_INPUT_PROMPTS.bilingualDialogue,
    replace: true,
    builtin: true,
  }),
]);
const BUILTIN_PRESET_ORDER = new Map([
  "builtin-inherit",
  "builtin-roleplay",
  "builtin-literary-roleplay",
  "builtin-literary-roleplay-input",
  "builtin-literary-roleplay-input-bilingual-dialogue",
  "builtin-english-korean",
  "builtin-english-korean-v2",
  "builtin-english-paraphrase-korean",
  "builtin-english-source-style-korean",
  "builtin-chinese-korean",
  "builtin-chinese-korean-v2",
  "builtin-chinese-paraphrase-korean",
  "builtin-japanese-korean",
  "builtin-japanese-korean-v2",
  "builtin-bilingual-dialogue-korean",
  "builtin-bilingual-dialogue-korean-v2",
].map((id, index) => [id, index]));

export { BASE_PROMPT, BUILTIN_PRESETS, V2_PRESETS, ADDITIONAL_BUILTIN_PRESETS, BUILTIN_PRESET_ORDER };
