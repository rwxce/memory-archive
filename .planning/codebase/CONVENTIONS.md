# Coding Conventions

**Analysis Date:** 2026-08-23

## Naming Patterns

**Files (source — `src/`):**
- kebab-case for multi-word modules: `src/parse/message.ts`, `src/parse/timestamp.ts`, `src/render/html.ts`, `src/media.ts`.
- Single-word modules are lowercase: `src/model.ts`, `src/title.ts`, `src/csv.ts`, `src/extract.ts`, `src/index.ts`.
- Browser-side scripts under `src/render/js/` use kebab-case too: `linkify.js`, `transcript.js`, `xss-sanitize.js` (plain `.js`, run inside the generated HTML, not bundled by tsup).
- Test files mirror source: `test/message.test.ts` would pair with `src/parse/message.ts`; actual tests are named by concern: `test/timestamp.test.ts`, `test/csv.test.ts`, `test/media.test.ts`, `test/render.test.ts`, `test/title.test.ts`, `test/classify.test.ts`, `test/linkify.test.ts`, `test/theme.test.ts`, `test/html-media.test.ts`, `test/tracer.test.ts`, `test/integration.test.ts`.

**Functions / variables:**
- `camelCase` for functions and locals: `parseMessages`, `classifyType`, `detectFormat`, `tryParseTimestamp`, `resolveYear`, `stripInvisible`, `mergeCsv`, `reconcileMedia`, `slugifyChatName`, `chatInfoFromZip`.
- `PascalCase` for types and interfaces: `Message`, `MessageType`, `Detection`, `ParsedTimestamp`, `RunOptions`, `ParseOptions`, `RenderResult` (`src/model.ts`, `src/parse/types.ts`).

**Constants / regexes:**
- `SCREAMING_SNAKE_CASE` for module-level constants and regexes: `TS_RE`, `SENDER_RE`, `ATTACHED_RE`, `OMITTED_RE`, `DELETED_RE`, `INVISIBLE_CHARS`, `SANITY_MIN_YEAR` (`src/parse/timestamp.ts`), `SAMPLE_LINES` (`src/parse/message.ts`), `INLINE_MAX_BYTES` (`src/media.ts`).
- Unit-separator `0x1F` used as the dedupe-key joiner: `dedupeKey` in `src/csv.ts` (`[m.timestamp_iso, m.author, m.text, m.media].join('\u001f')`).

## Code Style

**Formatting:** No Prettier. Style is enforced indirectly by ESLint + `typescript-eslint` recommended. TypeScript `strict: true` in `tsconfig.json` (no `any` tolerated by default, but `@typescript-eslint/no-explicit-any` is explicitly turned **off** in `eslint.config.js`).

**Linting:** ESLint flat config at `eslint.config.js`:
- extends `js.configs.recommended` + `tseslint.configs.recommended`.
- `@typescript-eslint/no-unused-vars`: `warn`, ignoring names matching `^_` (args & vars).
- `@typescript-eslint/no-explicit-any`: `off`.
- `@typescript-eslint/no-non-null-assertion`: `off`.
- `@typescript-eslint/no-require-imports`: `off`.
- `no-control-regex` and `no-misleading-character-class`: `off` — required because the parser intentionally matches Unicode invisible runs / control chars (see `src/parse/timestamp.ts` `INVISIBLE_CHARS`).
- A second config block (`files: ['src/render/js/**/*.js']`) swaps the globals to `globals.browser` (these scripts run in the generated HTML viewer, not Node).
- Ignored paths: `dist/`, `node_modules/`, `.planning/`, `lab/`, `backup/`, `out/`, `output/`, `coverage/`, `docs/`.

**Module system:** `"type": "module"` in `package.json`. All source is ESM. Imports use the `node:` prefix for built-ins (`node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:http`, `node:assert/strict`, `node:test`). No `require()`, no CommonJS.

## Import Organization

No `import/order` rule is enforced by ESLint, but the codebase follows a consistent de-facto order:
1. **Node built-ins** with `node:` prefix — `import * as fs from 'node:fs';`
2. **Third-party packages** — `import { Command } from 'commander';`, `import pc from 'picocolors';`, `import { zipSync } from 'fflate';`, `import { format } from 'date-fns';`
3. **Local relative imports** — `import { parseMessages } from './parse/message';`, `import type { Message } from './parse/types';`

Two styles appear for named imports from `node:test`: most files use `import { test } from 'node:test';` but several use default `import test from 'node:test';` (`test/theme.test.ts`, `test/linkify.test.ts`, `test/html-media.test.ts`). Both work; `test/tracer.test.ts` uses the named form.

`import type { ... }` is used for type-only imports (`src/model.ts`, `src/parse/message.ts`).

No barrel files (`index.ts` re-exports) exist; modules are imported directly by path.

## Error Handling

**Parse-level "soft" failures return `null` rather than throwing.** `tryParseTimestamp` in `src/parse/timestamp.ts` returns `null` when a line matched the timestamp shape but the date is invalid (`31/02`, year out of the `SANITY_MIN_YEAR`..`curYear+1` sanity window) — signalling the caller to treat the line as a *continuation* (appended to the open message), not a crash. The same `null`-as-signal pattern is used by `parseTimestamp` (a thin wrapper). This keeps the streaming parser resilient to malformed rows.

**Warning collection pattern.** Callers pass an optional `warnings?: string[]` collector (`ParseOptions` in `src/parse/message.ts`, `tryParseTimestamp` in `src/parse/timestamp.ts`). Problems are pushed as human-readable strings and surfaced later via `verboseReport` (`src/model.ts`) on stderr — never thrown.

**Defensive parsing with safe fallbacks.** `jsonOrEmpty` in `src/csv.ts` wraps `JSON.parse` in `try/catch` and returns `{}` on failure. `readCsv` skips rows with `< 5` fields rather than throwing, preserving malformed rows as best-effort (`text` only).

**Media resolution never throws.** `reconcileMedia` (`src/media.ts`) resolves referenced media and copies matched files to `<dir>/media/`; missing refs are reported on stderr and rendered as placeholders (MEDIA-03/MEDIA-04). Tests assert `runParser` does not throw on unresolved media (`test/media.test.ts`).

**CLI error handling.** `src/index.ts` wraps the `.action` callback in `try/catch`; on error it writes `pc.red('✗ ' + err.message)` to stderr and sets `process.exitCode = 1`. Invalid / conflicting CLI input uses `program.help({ error: true })` or `process.exitCode = 1` (no `process.exit()` calls).

**Logging convention.** Diagnostics go to `console.error` (never `console.log` for status), using `picocolors` (`pc.red`, `pc.green`, `pc.dim`, `pc.cyan`, `pc.yellow`). Every `console.*` use in source carries an `// eslint-disable-next-line no-console` comment (e.g. `src/model.ts` `verboseReport`). User-facing success uses `pc.green`.

## Comments

**JSDoc-style block comments above exported functions** describe behavior *and link to design-doc IDs* from the research phase (e.g. `D-01`, `D-03`, `D-04`, `D-07`, `D-08`, `D-12`, `D-15`, `D-16`, `D-17`, `D-19`, `PARSE-03`, `PARSE-04`, `PARSE-05`, `MEDIA-03`, `MEDIA-04`, `OUT-05`, `T-01-04`, `A1`, `A2`). These IDs trace requirements to implementation.
Example from `src/parse/message.ts`:
```typescript
/**
 * Streaming line state-machine parser (RESEARCH §3).
 * - Non-timestamp line => append to open message's `text` (continuation, PARSE-04).
 * - Timestamp that fails to parse ... => continuation (+ optional warning).
 */
export async function* parseMessages(...)
```

**Inline comments** explain non-obvious regex or control-flow decisions (e.g. why `SENDER_RE` requires `\s|$` — "keeps URLs from being mistaken for senders", `src/parse/message.ts`).

There is no enforced TSDoc lint rule; comments are written for human maintainers and for traceability to `research/`.

## Function Design

**Streaming via async generators.** The core parser is an `async function*` (`parseMessages`, `src/parse/message.ts`) that yields `Message` objects one at a time — memory-safe for large chats. Callers consume with `for await (const m of parseMessages(...))`.

**Pure helpers preferred.** `detectFormat`, `tryParseTimestamp`, `resolveYear`, `classifyType`, `classifyFromFilename`, `csvField`, `unescapeField`, `dedupeKey` are pure and exported for direct unit testing (no I/O). The `Message` model (`src/parse/types.ts`) is a plain interface with explicit field documentation.

**Options objects.** Functions take `opts`-style parameter objects (`ParseOptions`, `RunOptions`, `DetectOptions`, enrich-titles options) rather than long positional lists, supporting forward-compatible flags like `--day-first` / `--month-first` / `--inline` / `--no-fetch-titles`.

**Generator-internal emit queue.** `parseMessages` uses a `queue: Message[]` + `emit()` closure to bridge the streaming loop and `yield`, making the single-pass parser re-entrant over the buffered sample window.

## Module Design

**Layered, no circular imports observed:**
- `src/parse/` — tokenization & parsing (`types.ts`, `timestamp.ts`, `message.ts`).
- `src/csv.ts` — the CSV source-of-truth (read/write/merge/dedupe).
- `src/media.ts` — media reconciliation & inline.
- `src/title.ts` — URL title enrichment (fetched + platform-specific derivation).
- `src/render/` — `json.ts`, `md.ts`, `html.ts`, `colors.ts` (renderers re-read `messages.csv` from disk).
- `src/extract.ts` — ZIP extraction & chat-name/slug derivation (`chatInfoFromZip`, `slugifyChatName`).
- `src/model.ts` — orchestration (`runParser`, `renderOutputs`, `verboseReport`).
- `src/index.ts` — CLI entry (`buildCli`), plus `buildCli().parseAsync(process.argv)` at module load.

**Dynamic import for optional heavy path.** `runParser` uses `await import('./title.js')` (`src/model.ts`) to load the title-enrichment module lazily.

**Dynamic `import()` of browser scripts is not done** — `src/render/js/*.js` are copied/read as static text and embedded into the HTML output.

**No global mutable singletons** beyond module-level regex/constant definitions (all immutable). State (current/held message, detection, buffer) is local to the `parseMessages` generator invocation.

---

*Convention analysis: 2026-08-23*
