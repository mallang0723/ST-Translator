# Third-party notices

> **Note:** This repository is a SillyTavern port of [LV-Translator](https://github.com/mallang0723/LV-Translator) (0.3.5, MIT, Copyright (c) 2026 mallang0723). The notices below carry over unchanged from the original project.

This repository is licensed under the MIT License (see `LICENSE`, Copyright (c) 2026 mallang0723). The parts listed below keep their own copyright and license.

## Marinara-Translation-Tools 1.5.4

`src/presets/upstream/*` and `src/presets/catalog.ts` are copied verbatim, and `src/translate/prompt.ts` ports the request-building logic, from
[minikkeuen/Marinara-Translation-Tools](https://github.com/minikkeuen/Marinara-Translation-Tools) 1.5.4 (`extension.js`, `prompts/*.js`). `src/presets/upstream/prompt-fingerprints.json` is the upstream `tests/prompt-fingerprints.json`.

```
MIT License

Copyright (c) 2026 minikkuen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Marinara Engine

[Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine), licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html). This extension follows the behaviour of its chat translation feature and reuses two short pieces of its text:

- The default translation prompt sentence ("You are a translator. Translate the given text accurately into {{targetLanguage}}, …"), used as `BASE_PROMPT` from `src/presets/upstream/general.ts`. The same sentence is also part of Marinara-Translation-Tools 1.5.4 `prompts/general.js` (MIT, above), from which that file is copied.
- The user message wording "Translate the following text to <language>:" in `src/translate/prompt.ts`.

## Paragraph Reader 0.2.0

The paragraph split, the no-text paragraph check, the HTML block grouping (`src/translate/paragraphs.ts`) and the paragraph view design come from Paragraph Reader 0.2.0, written by the owner of this repository.

## RP 번역표시 설정 확장 1.0.2 (Marinara 개인 확장)

The excluded-tag list in `src/translate/protect.ts` (`parseTags`, `protectElements`: skipping comments and code, counting same-name nesting, void-tag list, keeping `strong`/`em`) and the choice of display modes in 0.2.0 follow "RP 번역표시 설정 확장" 1.0.2, a Marinara personal extension posted on the DCinside aifrontend mini gallery: https://gall.dcinside.com/mini/board/view/?id=aifrontend&no=4375. The code was adapted for Lumiverse (the tag-scanning regular expression is reused; the rest is rewritten). The post states "수정 재공유 자유" (free to modify and re-share); no separate license file came with it. That extension is not ours and its author keeps whatever rights they have.
