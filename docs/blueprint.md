# Memory Archive blueprint

What this repo **has** — architecture, test types, tools, agents, rules — with the technical
name of each piece and the path where it lives. It is an inventory, not a manual: follow the
path when you need the detail. Items marked **(planned)** are approved in
[`roadmap.md`](roadmap.md) but not built yet.

Keeping it current: adding or removing an agent, skill, hook, custom lint rule, CI workflow,
test type or architecture rule means updating this file **in the same PR**.

## 1. Stack

- **Today (CLI):** TypeScript 6 (`strict`), Node 24 ESM (`.nvmrc`), pnpm 11.
  - `commander` — CLI arguments (`cli/index.ts`).
  - `fflate` — streaming raw-DEFLATE `Inflate` behind the ZIP reader
    (`lib/importers/whatsapp/zip.ts`).
  - `date-fns` — timestamp formatting in the parser.
  - `picocolors` — terminal output.
  - `tsup` (bundle `cli/index.ts` to `dist/`), `tsx` (run TS directly), ESLint 10 flat
    config, Vitest 5.
  - TypeScript path alias `@/` → repo root (`tsconfig.json`, `vitest.config.ts`).
- **App (planned):** Next.js 16 with `output: 'export'` (static files only, no server) as an
  installable **PWA**, React 19, Tailwind CSS 4 + shadcn/ui, next-intl (`ca` / `es` / `en`),
  zod 4, SQLite WASM (`@sqlite.org/sqlite-wasm`) persisted in the browser's **OPFS**, Serwist
  service worker, Vitest.
- **Hosting (planned):** Cloudflare Pages for the public URL; GitHub Pages workflow so any fork
  gets its own URL with no secrets.
- **No backend, no accounts, no third-party APIs.** No Google Cloud, no OAuth, no telemetry.

## 2. Layered architecture

- **Platform-neutral core (`lib/`)** — runs in Node and in the browser (Web Worker in
  Phase 2). Inputs are `Blob`s, web `ReadableStream`s and async iterables of lines; no
  `node:*` imports, no `Buffer`/`process`.
  - `lib/importers/whatsapp/` — `zip.ts` (single ZIP reader: central directory + ZIP64 over
    `Blob.slice`, fflate streaming inflate per entry), `lines.ts` (UTF-8 decoding + line
    splitting), `timestamp.ts`, `message.ts` (state machine), `chat.ts` (transcript entry,
    chat name/slug), `media.ts` (media matching), `import.ts` (`parseWhatsAppZip`).
  - `lib/exporters/legacy/` — wa-backup output formats as pure functions: `csv.ts`,
    `json.ts`, `md.ts`, `html.ts`, `media.ts` (media map, MIME), `colors.ts` + `sha256.ts`.
- **Node CLI (`cli/`)** — commander entry, `fs.openAsBlob` adapter, CSV/media/output
  writing, link-title fetching. Pipeline (`cli/pipeline.ts`): `parseWhatsAppZip` →
  `mergeCsv` → `enrichTitles` → `reconcileMedia` → `renderOutputs`.
- **Why the ZIP reader uses the central directory** — WhatsApp exports store members with
  data descriptors; a forward-only reader (fflate `Unzip`) must guess where such a member ends
  and splits a stored inner `.zip` into bogus entries (regression test in `zip.test.ts`).
- **CSV as source of truth** — `messages.csv` (`timestamp_iso,type,author,text,media,url_titles`),
  merged and deduplicated on every run; JSON / Markdown / HTML are re-rendered from it.
- **Shared browser scripts** — `lib/exporters/legacy/js/{linkify,transcript,xss-sanitize}.js`
  run both in Node and in the generated HTML. `scripts/build-viewer-script.mjs` concatenates
  them into one classic script, committed as `js/viewer-script.generated.ts` (`VIEWER_SCRIPT`)
  and inlined by `html.ts`, so no file is read at runtime (the old runtime read broke the built
  CLI). `pnpm build` regenerates it; a test fails when it is stale.
- **Link titles** (`cli/titles.ts`) — opt-in (`--fetch-titles`), the CLI's only network
  access. `guardedFetch` allows only http(s), resolves the host and refuses private /
  loopback / link-local / CGNAT / multicast / ULA targets, re-checks every redirect (max 3)
  and reads at most 512 KB. Stored titles are never wiped; only missing ones are fetched.
- **Message types** — `text`, `photo`, `video`, `sticker`, `document`, `audio` (`.opus`,
  `.m4a`, `.mp3`, `.ogg`, `PTT-*`, `AUD-*`), `system`, `deleted`, `omitted`.
- **Planned layers** (enforced by ESLint once they exist):
  `app/` → `components/` → `hooks/` → `lib/usecases/` → `lib/domain/` · `lib/db/` ·
  `lib/storage/` · `lib/importers/<source>/` · `lib/exporters/`.
- **Planned storage model** — SQLite (profiles, conversations, participants, messages,
  media, timeline events, associations, import batches, favorites, annotations, meta) +
  **content-addressed blobs** (`blobs/sha256/ab/cd/<hash>`), immutable, paths relative to the
  archive root. Source data is separate from user-defined associations.
- **Planned message fingerprint** — `sha256(conversation | normalized local timestamp |
  participant | NFC text | media hash | ordinal within the same minute)`; imports are
  idempotent.
- **Planned archive file** — `memory-archive-YYYY-MM-DD.zip` = database snapshot + blobs +
  `manifest.json` (format/schema version, sha256 and size per file). Change packs for manual
  sync use the same format with only the new import batches.
- **Read-only viewer is separate from the archive** — the portable HTML viewer is an export,
  never the storage format.

## 3. Architecture as code

- **ESLint** (`eslint.config.js`) — `@eslint/js` recommended + `typescript-eslint`
  recommended.
  - `lib/**` (non-test): browser + worker globals; `no-restricted-imports` bans every Node
    built-in (`node:*`, `fs`, `path`, …) and imports from `cli/`; `no-restricted-globals`
    bans `Buffer`, `process`, `__dirname`, `require`, ….
  - `local/require-test-file` (inline plugin in `eslint.config.js`) — every module in
    `lib/importers/**` needs a sibling `*.test.ts` (`index.ts`, `types.ts` exempt).
- **Planned** (Phase 2, Zliding style): `eslint-plugin-boundaries` for the layers above,
  `import-x/no-cycle`, `no-console` outside the logger, `i18next/no-literal-string` in UI,
  `local/require-test-file` extended to `lib/usecases`.

## 4. Tests

- **Runner:** Vitest 5 (`vitest.config.ts`), tests next to the code as `*.test.ts`;
  assertions mostly `node:assert/strict` (carried over) and Vitest `expect`.
  `pnpm test` = generate fixtures + `vitest run`.
- **Fixtures:** synthetic only — `scripts/generate-fixtures.mjs` (run by `pnpm test`) writes
  the chats and ZIPs into the git-ignored `fixtures/`. Real exports are never committed.
  `FORMAT_FIXTURES` covers one root-level ZIP per export style: Android en-US (M/D/YY,
  `AM`/`PM`, `(file attached)`, system lines, multiline, identical same-minute messages),
  iOS en-US with and without media (U+202F before `AM`/`PM`, U+200E system lines), Android
  es (`p. m.`), iOS es (`<adjunto: …>`), Android pt (24h, no comma) and Android ca
  (best-effort strings).
- **Test types:**
  - Importer units (`lib/importers/whatsapp/*.test.ts`) — `timestamp`, `lines` (chunk
    boundaries, CRLF, UTF-8), `zip` (data descriptors, ZIP64, corrupt input), `chat`,
    `media`, `message`, `import`, `formats` (every message of every format fixture:
    detection + classification).
  - CLI format runs — `cli/formats.test.ts` (each format fixture end to end: media copied,
    idempotent re-import, identical same-minute messages counted, not collapsed).
  - Platform neutrality — `lib/platform.test.ts`: scans `lib/` for Node imports/globals and
    runs importer + exporters from a `Blob` with `Buffer`/`setImmediate` removed.
  - Exporter units — `lib/exporters/legacy/legacy.test.ts` (sha256 vs `node:crypto`, CSV,
    media map, inline loader), `js/linkify.test.ts`.
  - CLI end to end (`cli/*.test.ts`) — `tracer`, `classify`, `integration` (merge, dedupe,
    idempotent second run), `csv`, `media`, `html-media`, `render` (XSS stays inert),
    `theme`, `titles` (mocked `fetch`), `titles-guard` (SSRF guard, redirects, kept titles),
    `regressions` (one block per fixed known bug).
  - Packaging — `scripts/build-viewer-script.test.ts` (bundle fresh and self-contained) and
    `pnpm smoke` (built CLI).
  - Tooling — `scripts/block-agent-github-review-writes.test.ts` (the hook script, run end
    to end with the stdin JSON agents send). The vendored `security-audit` validators have
    their own `node --test` suite.
- **Planned:** Playwright checks of the PWA at 390 px and 1440 px, an automated run of the PRD
  acceptance scenario (backup → restore on a clean browser).

## 5. CI/CD and branches

- **Branch model:** feature branch → squash into `dev` → release PR `dev` → `main` titled
  `release: vX.Y.Z` (squash) → tag. `main` only contains release commits
  ([`branching-and-releases.md`](branching-and-releases.md)).
- **`ci.yml`** — on PRs to `dev`/`main` and pushes to `dev`: pnpm install (frozen lockfile,
  7-day release age) → `pnpm check`.
- **`branch-policy-guard.yml`** — `pull_request_target`; `main` only accepts PRs from `dev`
  titled `release: vX.Y.Z`.
- **`release.yml`** — on push to `main`: reads the version from the commit subject, creates the
  tag and GitHub Release, back-merges `main` into `dev` (`-s ours`). No release bot.
- **`dependabot.yml`** — npm and GitHub Actions, target `dev`, 7-day cooldown.
- **`CODEOWNERS`** and **PR template** (`.github/pull_request_template.md`).
- **Planned:** `deploy.yml` (Cloudflare Pages: `main` = production, `dev` = preview) and
  `pages.yml` (GitHub Pages for forks).

## 6. Quality gates and supply chain

- **`pnpm check`** — lint → typecheck → test → build → smoke (`scripts/smoke.mjs` runs the
  built `dist/` CLI on the fixture ZIP into a temp dir and checks the four outputs + media).
- **Exact versions** (`.npmrc` `save-exact=true`, `engine-strict=true`), **`minimumReleaseAge`
  of 7 days** (`pnpm-workspace.yaml`, 10080 minutes), exact security **`overrides`**,
  **`allowBuilds`** allowlist for install scripts, `only-allow pnpm` (`preinstall`).
- New dependencies need a reason in the PR description; prefer no dependency.
- `ajv` is a direct devDependency only as a workaround: pnpm 11 drops `ajv-formats`' optional
  peer and `rulesync` crashes without it. Remove when upstream fixes the peer.
- ESLint ignores the generated agent folders (`.claude/`, `.codex/`, `.cursor/`,
  `.opencode/`, `.agents/`) and `.rulesync/`.

## 7. AI tooling

- **rulesync — single source** — edit `.rulesync/`, run `pnpm rulesync`; it generates
  `AGENTS.md`, `CLAUDE.md` and the per-tool folders for Claude Code, Codex CLI, Cursor and
  OpenCode. CI fails on drift (`pnpm rulesync:check`). Config: `rulesync.jsonc`. Details:
  [`ai-tooling.md`](ai-tooling.md).
- **Root rule** — `.rulesync/rules/CLAUDE.md`.
- **Subagents** (`.rulesync/subagents/`):
  - `core-architect` — mandatory owner of the data layer: parser, model, storage, importers,
    exporters, use cases.
  - `testing-expert` — tests, fixtures, regressions.
  - `responsive-ui-designer` — router for UI work (mobile-first PWA, `ca`/`es`/`en`).
- **Commands — PR flow** (`.rulesync/commands/`): `pr-plan` → `pr-precheck` → `pr-make` →
  `pr-review` → `pr-triage`.
- **Skills** (`.rulesync/skills/`): `debugging`, `interview-me`, `pr-scope`, `pr-review`,
  `security-audit`, `rulesync`. Planned with the UI: a design skill and `local-test`
  (Playwright, mobile + desktop viewports).
- **Hooks** (`.rulesync/hooks.jsonc`):
  - `PreToolUse` (fail-closed) — `scripts/block-agent-github-review-writes.mjs`: agents
    cannot post GitHub comments or reviews.
  - `Stop` (advisory) — lint, `scripts/check-pr-preflight.mjs --advisory`.
  - `SessionEnd` — kills dev processes on the Conductor workspace ports.
- **Permissions** (`.rulesync/permissions.jsonc`) — read-only `gh` allowed; `gh` comment,
  review and mutating `gh api` denied; `.env*`, secrets, build output, fixtures, outputs
  and any WhatsApp export read-denied. A `codexcli` block restates the rules in a form Codex
  can enforce. **Ignore list** (`.rulesync/.aiignore`, deprecated upstream) only feeds
  `.cursorignore`.
- **MCP servers** (`.rulesync/mcp.jsonc`) — Playwright only, pinned (not `@latest`, which would
  bypass the 7-day release age).
- **Review checklist** — `.rulesync/checks/memory-archive-review.md` (privacy, untrusted input,
  data integrity, supply chain); generates `.cursor/BUGBOT.md` and feeds `pr-precheck` /
  `pr-review`.
- **Known gaps** — OpenCode does not run the GitHub-write guard hook (only the permission
  denies apply there); Codex has no project-level slash commands.

## 8. Working rules (people and agents)

- **Plan and "go"** — a written plan and an explicit go-ahead before any edit.
- **Data layer goes through `core-architect`.**
- **Privacy first** — never read, copy or commit real chats or personal media; synthetic
  fixtures only. No network calls from the app except an explicit user opt-in.
- **Never lose data** — imports are transactional and idempotent; nothing is silently
  dropped (unparseable lines are kept as raw text).
- **Kill the dev servers you start.**
- **Git** — no commits without authorization; PRs into `dev`; agents merge only when explicitly asked and never post reviews.
- **Language** — reply in the user's language; code, commits, PRs, docs and `.rulesync/` in
  English.

## 9. Product and copy

- [`PRODUCT.md`](../PRODUCT.md) — mission, users, principles.
- [`prd.md`](prd.md) — full product requirements (multi-profile, imports, backup/restore,
  screens, acceptance criteria).
- [`tone.md`](tone.md) — voice rules for UI copy in `ca` / `es` / `en`.
- [`privacy.md`](privacy.md) — what stays where, and what the app never does.

## 10. Reference documents (`docs/`)

- `roadmap.md` — phases 0–9 with scope, PR breakdown and verification.
- `branching-and-releases.md` — branch and release procedure.
- `ai-tooling.md` — rulesync layout and how to add rules, skills and commands.
- `archive/planning/` — the original GSD planning of the wa-backup CLI (phases 1–3, codebase
  map, concerns). Historical, read-only.
- `archive/specs/` — design specs and plans of the CLI features (linkification, link titles,
  thumbnails + lightbox).
