# Memory Archive blueprint

What this repo **has** — architecture, test types, tools, agents, rules — with the technical
name of each piece and the path where it lives. It is an inventory, not a manual: follow the
path when you need the detail. Items marked **(planned)** are approved in
[`roadmap.md`](roadmap.md) but not built yet.

Keeping it current: adding or removing an agent, skill, hook, custom lint rule, CI workflow,
test type or architecture rule means updating this file **in the same PR**.

## 1. Stack

- **Today (CLI):** TypeScript 6 (`strict`), Node 24 ESM (`.nvmrc`), pnpm 11.
  - `commander` — CLI arguments (`src/index.ts`).
  - `fflate` — streaming unzip of the WhatsApp export (`src/extract.ts`).
  - `date-fns` — date formatting in renderers.
  - `picocolors` — terminal output.
  - `tsup` (bundle to `dist/`), `tsx` (run TS directly), ESLint 10 flat config, `node:test`.
- **App (planned):** Next.js 16 with `output: 'export'` (static files only, no server) as an
  installable **PWA**, React 19, Tailwind CSS 4 + shadcn/ui, next-intl (`ca` / `es` / `en`),
  zod 4, SQLite WASM (`@sqlite.org/sqlite-wasm`) persisted in the browser's **OPFS**, Serwist
  service worker, Vitest 4.
- **Hosting (planned):** Cloudflare Pages for the public URL; GitHub Pages workflow so any fork
  gets its own URL with no secrets.
- **No backend, no accounts, no third-party APIs.** No Google Cloud, no OAuth, no telemetry.

## 2. Layered architecture

- **Today — single pipeline** (`src/model.ts`): `chatInfoFromZip` → `extractChatTxt` →
  `parseMessages` → `mergeCsv` → `enrichTitles` → `reconcileMedia` → `renderOutputs`.
- **CSV as source of truth** — `messages.csv` (`timestamp_iso,type,author,text,media,url_titles`),
  merged and deduplicated on every run (`src/csv.ts`); JSON / Markdown / HTML are re-rendered
  from it (`src/render/`).
- **Shared browser scripts** — `src/render/js/{linkify,transcript,xss-sanitize}.js` run both
  in Node and in the generated HTML.
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
  recommended; browser globals only for `src/render/js/**`.
- **Planned** (Phase 2, Zliding style): `eslint-plugin-boundaries` for the layers above,
  `import-x/no-cycle`, `no-console` outside the logger, `i18next/no-literal-string` in UI,
  custom `local/require-test-file` for `lib/importers` and `lib/usecases`.

## 4. Tests

- **Runner:** `node:test` + `node:assert/strict` via `tsx` (`pnpm test`); Vitest 4 planned
  in Phase 1, tests moving next to the code.
- **Fixtures:** synthetic only — `scripts/generate-fixtures.mjs` (runs as `pretest`) writes
  two chats and a ZIP into the git-ignored `fixtures/`. Real exports are never committed.
- **Test types** (`test/`):
  - Parsing — `timestamp`, `tracer`, `classify`.
  - Data — `csv` (escaping round-trip, legacy 5-column rows), `integration` (merge, dedupe,
    idempotent second run).
  - Media — `media`, `html-media` (reconciliation, inline data URIs).
  - Rendering — `render` (XSS payloads stay inert in all outputs), `linkify`, `theme`.
  - Network — `title` (link-title fetch with mocked `fetch`).
  - Tooling — `block-agent-github-review-writes` (the hook script, run end to end with the
    stdin JSON agents send). The vendored `security-audit` validators have their own
    `node --test` suite.
- **Planned:** browser-environment tests for the core, Playwright checks of the PWA at
  390 px and 1440 px, an automated run of the PRD acceptance scenario (backup → restore on a
  clean browser).

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

- **`pnpm check`** — lint → typecheck → test → build.
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
