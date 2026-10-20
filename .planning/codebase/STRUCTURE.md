# Codebase Structure

**Analysis Date:** 2026-08-23

## Directory Layout

```
wa-backup/
├── src/                      # All TypeScript source (ESM, type: module)
│   ├── index.ts              # CLI entry (commander), buildCli(), parseAsync
│   ├── model.ts              # Orchestrator: runParser(), renderOutputs(), verboseReport()
│   ├── extract.ts            # ZIP streaming of _chat.txt, chat-name/slug resolution
│   ├── csv.ts                # CSV source-of-truth: escape, read, write, mergeCsv
│   ├── media.ts              # ZIP central-dir parse, media reconcile, buildMediaMap
│   ├── title.ts              # URL→title enrichment (per-platform fetchers)
│   ├── parse/                # Streaming line parser + timestamp logic
│   │   ├── message.ts        # State machine: parseMessages(), classifyType()
│   │   ├── timestamp.ts      # TS_RE, detectFormat(), tryParseTimestamp()
│   │   └── types.ts          # Message, MessageType contracts
│   └── render/               # Output renderers
│       ├── json.ts           # renderJson() -> messages.json
│       ├── md.ts             # renderMarkdown() -> messages.md
│       ├── html.ts           # renderHtml() -> messages.html (string template)
│       ├── colors.ts         # accentHue(), getAccentColor(), initials()
│       └── js/               # Browser-shared + client viewer JS
│           ├── linkify.js     # URL_RE, deriveTitle, unwrapUrl, linkifyHtml/Markdown
│           ├── transcript.js  # DOM viewer reading #chat-data island
│           └── xss-sanitize.js# setText()/clear() safe DOM helpers
├── test/                     # node:test suites (one file per concern)
│   ├── integration.test.ts   # End-to-end: runParser over fixtures + dedupe/order
│   ├── csv.test.ts           # CSV round-trip, dedupeKey, mergeCsv
│   ├── timestamp.test.ts     # detectFormat / tryParseTimestamp
│   ├── classify.test.ts      # classifyType, ATTACHED/OMITTED/DELETED
│   ├── media.test.ts         # reconcileMedia, normalizeMediaName, buildMediaMap
│   ├── title.test.ts         # enrichTitles, platform dispatch
│   ├── render.test.ts        # JSON/MD/HTML output assertions
│   ├── html-media.test.ts    # HTML media embeds/placeholders
│   ├── theme.test.ts         # colors.ts accent/initials
│   ├── linkify.test.ts       # linkify.js URL handling
│   └── tracer.test.ts        # internal tracing/debug helper
├── scripts/
│   └── generate-fixtures.mjs  # Synthetic fixture generator (run via pretest)
├── fixtures/                 # Generated synthetic chats + ZIPs (gitignored? see note)
│   ├── WhatsApp Chat - Notas pessoais/   # _chat.txt + media files
│   ├── WhatsApp Chat - Plataforma WK/    # _chat.txt + media files
│   └── WhatsApp Chat - *.zip             # pre-built ZIPs for tests
├── dist/                     # Built JS (tsup output; bin target)
├── data/                     # Developer's real exports (gitignored, not used by tests)
├── output/                   # Default CLI output dir (gitignored)
├── .planning/                # GSD planning artifacts
├── docs/                     # Distribution/docs notes
├── package.json              # ESM, bin, scripts, deps
├── tsconfig.json             # ES2022, strict, noEmit (tsup builds)
├── tsup.config.ts            # Build config -> dist/index.js w/ shebang
└── eslint.config.js          # ESLint 9 flat config (typescript-eslint)
```

## Directory Purposes

**`src/` (and subdirs):**
- Purpose: All application source. ESM modules, `"type": "module"`.
- Contains: CLI, orchestrator, parsing, persistence, enrichment, rendering.
- Key files: `src/index.ts`, `src/model.ts`, `src/parse/*`, `src/render/*`, `src/csv.ts`, `src/media.ts`, `src/title.ts`.

**`src/parse/`:**
- Purpose: The streaming parser and the data contract.
- Contains: `message.ts` (state machine), `timestamp.ts` (detection + parsing), `types.ts` (`Message`/`MessageType`).
- Key files: `src/parse/message.ts:82` (`parseMessages`), `src/parse/timestamp.ts:32` (`TS_RE`), `src/parse/types.ts:11` (`Message`).

**`src/render/`:**
- Purpose: Emit the four synchronized outputs + shared client JS.
- Contains: `json.ts`, `md.ts`, `html.ts`, `colors.ts`, `js/{linkify,transcript,xss-sanitize}.js`.
- Key files: `src/render/json.ts:79` (`renderJson`), `src/render/md.ts:84` (`renderMarkdown`), `src/render/html.ts:248` (`renderHtml`).

**`src/render/js/`:**
- Purpose: JavaScript modules shared between Node renderers (imported as `.js`) and the browser viewer. `linkify.js` is consumed by `html.ts`/`md.ts`/`transcript.js`; `transcript.js` is embedded into `messages.html` (`src/render/html.ts:264`); `xss-sanitize.js` provides safe `setText`/`clear` (`src/render/js/transcript.js:5`).
- Contains: `linkify.js`, `transcript.js`, `xss-sanitize.js`.

**`test/`:**
- Purpose: `node:test` suites run via `npm test` (which runs `pretest` → `generate-fixtures.mjs` first).
- Contains: 11 `.test.ts` files; `integration.test.ts` is the authoritative end-to-end suite.
- Key files: `test/integration.test.ts:61` (WK assertions), `test/integration.test.ts:123` (dedupe), `test/csv.test.ts`.

**`scripts/`:**
- Purpose: Build/tooling helpers. `generate-fixtures.mjs` writes synthetic `fixtures/` so CI needs no personal data.
- Key files: `scripts/generate-fixtures.mjs:115` (`main()`).

**`fixtures/`:**
- Purpose: Synthetic WhatsApp exports (text + tiny placeholder media + ZIPs) for tests. Generated by `scripts/generate-fixtures.mjs`. Not committed personal data.
- Contains: `WhatsApp Chat - Notas pessoais/`, `WhatsApp Chat - Plataforma WK/`, and matching `.zip` files.

## Key File Locations

**Entry Points:**
- `src/index.ts` — CLI entry; `buildCli().parseAsync(process.argv)` at `src/index.ts:78`. Bin target `dist/index.js` (`package.json:7`).
- `src/model.ts` — Programmatic API: `runParser`, `renderOutputs`.

**Configuration:**
- `package.json` — ESM, bin, scripts (`dev`/`build`/`test`/`lint`/`typecheck`), deps (`commander`, `date-fns`, `fflate`, `picocolors`).
- `tsconfig.json` — `target ES2022`, `strict`, `noEmit`, `moduleResolution: Bundler`, `include: [src, test]`.
- `tsup.config.ts` — bundles `src/index.ts` → `dist/`, injects shebang, `bin` entry.
- `eslint.config.js` — ESLint 9 flat config with `typescript-eslint`.

**Core Logic:**
- `src/model.ts` — orchestration.
- `src/parse/message.ts` — parsing state machine.
- `src/csv.ts` — CSV source-of-truth + merge/dedupe.

**Output Artifacts (per run):**
- `<out>/<slug>/messages.csv` — source-of-truth.
- `<out>/<slug>/messages.json` — `renderJson`.
- `<out>/<slug>/messages.md` — `renderMarkdown`.
- `<out>/<slug>/messages.html` — `renderHtml`.
- `<out>/<slug>/media/` — reconciled media files (`src/media.ts:182`).

**Testing:**
- `test/*.test.ts` — `node --import tsx --test "test/*.test.ts"` (`package.json:39`).

## Naming Conventions

**Files:**
- TypeScript modules: `kebab-case.ts` (e.g. `parse-messages` → here `message.ts`, `timestamp.ts`, `media.ts`).
- Browser-shared JS: `kebab-case.js` (e.g. `linkify.js`, `transcript.js`, `xss-sanitize.js`).
- Test files: mirror the concern, `kebab-case.test.ts` (e.g. `csv.test.ts`, `timestamp.test.ts`).
- Fixtures: `WhatsApp Chat - <Name>/` (exact export naming, so `slugifyChatName` logic is exercised).
- Output artifacts: fixed names `messages.csv` / `messages.json` / `messages.md` / `messages.html` (`src/csv.ts:51`, `src/render/json.ts:87`, `src/render/md.ts:123`, `src/render/html.ts:370`).

**Directories:**
- `src/` subdirs are lower-case, single-word or short (`parse/`, `render/`, `render/js/`).
- Output folders use the slugified chat name (`src/extract.ts:118` → e.g. `plataforma-wk`).

**Exports:**
- Functions are `export function` (named exports), e.g. `export async function parseMessages`, `export async function runParser`.
- Types are `export interface`/`export type` (`src/parse/types.ts`).
- Constants like `TS_RE` (`src/parse/timestamp.ts:32`), `URL_RE` (`src/render/js/linkify.js:5`), `INLINE_MAX_BYTES` (`src/media.ts:13`) are `UPPER_SNAKE` `export const`.

**Functions / variables:**
- `camelCase` for functions/variables (`runParser`, `mergeCsv`, `reconcileMedia`, `dedupeKey`).
- File-local helpers are `function` (module-private) unless exported.
- `async` generators for streaming: `parseMessages` is `AsyncGenerator<Message>` (`src/parse/message.ts:82`); `extractChatTxt` returns `Promise<AsyncIterable<string>>` (`src/extract.ts:16`).

## Where to Add New Code

**New message type / parsing rule:**
- Parser state machine: `src/parse/message.ts` — extend `classifyType` (`src/parse/message.ts:40`) and the regexes (`SENDER_RE`, `ATTACHED_RE`, `OMITTED_RE`, `DELETED_RE`).
- Add the type to `MessageType` union in `src/parse/types.ts:1`.
- Keep the renderer branching in sync (search for `type === 'system' || type === 'deleted' || type === 'omitted'`).

**New output format (e.g. PDF):**
- Add `src/render/<fmt>.ts` exporting `async function render<Fmt>(csvPath, outDir, chatName, opts)`.
- Wire it into `renderOutputs` (`src/model.ts:69`).
- Add a test under `test/` (e.g. `render.test.ts`).

**New title-enrichment platform:**
- Add dispatch branch + helpers in `src/title.ts` (`platformOf`, `fetchTitle`).
- Reuse `extractTitle`/`metaContent` and the `urlTitles` column already in CSV (`src/csv.ts:45`).

**New media handling / inline rule:**
- `src/media.ts`: `normalizeMediaName`, `mimeFromExt`, `isInlineable`, `INLINE_MAX_BYTES`.

**New test:**
- `test/<concern>.test.ts`, import from `../src/<module>`. Use the synthetic fixtures (generated by `pretest`). For end-to-end, follow `test/integration.test.ts` (`run()` helper builds a ZIP from `fixtures/<chat>/_chat.txt`).

**Utilities:**
- Shared server/browser helpers go in `src/render/js/` (imported as `.js` so they load in both Node and browser). Pure Node helpers go in the relevant `src/*.ts`.

## Special Directories

**`fixtures/`:**
- Purpose: Synthetic test data.
- Generated: Yes — by `scripts/generate-fixtures.mjs` via the `pretest` npm script.
- Committed: Typically generated at test time; may be gitignored. Not derived from personal data.

**`dist/`:**
- Purpose: Built distributable (`tsup` output, includes `index.js` bin + `.d.ts`).
- Generated: Yes (build artifact).
- Committed: No (`files: ["dist"]` in `package.json` controls npm publish only).

**`data/` and `output/`:**
- Purpose: Developer's real exports (`data/`) and default CLI output (`output/`).
- Generated: `output/` at runtime.
- Committed: No — both are gitignored (`git log` shows "gitignore generated backup/ output").

**`media/` (under each `<out>/<slug>/`):**
- Purpose: Reconciled media files copied from the ZIP by `reconcileMedia`.
- Generated: Yes, at run time.
- Committed: No.

---

*Structure analysis: 2026-08-23*
