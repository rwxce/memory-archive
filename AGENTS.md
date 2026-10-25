# Memory Archive

> **AI editor config is managed by [rulesync](https://github.com/dyoshikawa/rulesync).**
> The single source of truth is `.rulesync/`. `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.cursor/`,
> `.codex/`, `.opencode/`, `.agents/` and `opencode.jsonc` are GENERATED.
> Edit only `.rulesync/`, then run `pnpm rulesync`. Never hand-edit generated files.
> CI enforces this with `pnpm rulesync:check`. See `docs/ai-tooling.md`.

Memory Archive lets a person open their conversation history years later — text and media
together — without WhatsApp, a phone, or any account. Today it is a TypeScript/Node CLI that
turns a WhatsApp "Export chat" ZIP into a standalone backup. It is becoming a local-only,
offline PWA. Everything stays on the user's device.

## Key docs

- `docs/blueprint.md` — inventory of stack, architecture, tests, CI, supply chain and AI
  tooling. Any PR that adds/removes an agent, skill, hook, lint rule, CI workflow, test type
  or architecture rule updates it in the same PR.
- `docs/roadmap.md` — approved phases 0-9 and architecture decisions (PWA, local only, no
  Google APIs, manual ZIP sync). `docs/prd.md` — full requirements.
- `PRODUCT.md`, `docs/privacy.md`, `docs/tone.md` (UI copy in ca/es/en),
  `docs/branching-and-releases.md`.
- `docs/archive/` — historical wa-backup planning and specs; read-only.

## Language

Reply in the language of the user's last message (Catalan, Spanish, English, ...); follow a
switch mid-thread. Code, code comments, identifiers, commit messages, PR titles/bodies, docs
and every file under `.rulesync/` are always in English.

## Collaboration style

- Before any code change, present a written plan with: (1) files to modify, (2) approach,
  (3) tradeoffs considered. Wait for an explicit "go" before editing.
- A plan covers only the current ask. Don't re-list work from earlier plans; reference it in
  one line if it matters.
- For architecture, data-model or format discussions, talk it through first; confirm the
  approach before spawning agents or creating task lists.
- When the ask is underspecified, use the `interview-me` skill before planning.

## Response length

- Chat messages default to 3-5 lines: complete but not long. Give the short version first
  and offer to expand.
- Doesn't apply to the written plan above or to output formats a skill defines (e.g.
  `pr-review`).
- Explanations: the rule plus one example; lead with plain language.
- Never fabricate data, file references or results. If unsure, ask or omit.

## Git & Commits

- Do not commit or push without authorization. An explicit request to create a PR (including
  `/pr-make`) authorizes the task-scoped flow: commit task changes, push the branch, create
  the PR — without another confirmation. Never include unrelated changes.
- Commit messages: English conventional commits. A `Co-Authored-By:` trailer for the agent is
  fine.
- `gh` read commands (`view`/`list`/`status`/`checks`/`diff`, `gh api` GET) are always
  allowed. Other GitHub mutations need explicit permission for that operation.
- Never commit directly to `main` or `dev`. Work on a branch; PRs target `dev`
  (`gh pr create --base dev`), or the branch of a PR they are stacked on.
- `main` only receives `release: vX.Y.Z` PRs from `dev`. Merge PRs only when the user
  explicitly asks; squash-merge into `dev`, and merge stacked PRs in order (retarget the
  next one to `dev` first).
- Setting work aside: use a WIP commit or `git stash push -u -m <unique-tag>` and apply by
  SHA. The stash is shared across worktrees; never bare `git stash` / `git stash pop`.

## Pull request review policy

Agents may review PRs privately but must **never** publish GitHub comments, inline findings
or reviews — even with user approval. No `gh pr comment`, `gh pr review`, mutating `gh api`
calls, GitHub MCP write tools or equivalent APIs (a fail-closed PreToolUse hook enforces
this). Return the analysis in the conversation; a human verifies it and posts any review in
their own words from their own account. Review feedback is limited to material correctness,
data safety, privacy, security, architecture or consequential UX — no nits.

PR workflow commands: `/pr-plan` (split a feature into single-topic PRs) → `/pr-precheck`
(adversarial self-review) → `/pr-make` (open the PR) → `/pr-review` (private review) →
`/pr-triage` (in-scope vs deferred review comments). `/pr-ship` is full autopilot: PR to `dev`,
CI fixes until green, merge, version bump, release PR, merge into `main`, and a check that the
release and deploy succeeded. Invoking it is the explicit request to merge, including `main`.

## Privacy rules (non-negotiable)

- Never read, open, copy, paste or commit a real WhatsApp export, `_chat.txt`, chat ZIP or
  personal media — not even to debug. `data/`, `output/`, `backup/` and `fixtures/` are
  gitignored and read-denied to agents.
- One narrow exception: when the user explicitly asks for highlights research in the current
  session, the agent may read `research/*.jsonl` / `*.meta.json` (the JSONL export of
  `pnpm cli export-for-research`; every read asks) to write `research/findings.json`. Never copy
  chat text into commits, PRs, docs, tests, memory or any file other than the findings; never
  send it to another service; delete `research/` when done. Skill: `highlights-research`.
- Tests and examples use only synthetic fixtures generated by
  `scripts/generate-fixtures.mjs`. Need a new case? Extend the generator.
- No telemetry, analytics, crash reporting or remote logging. Ever.
- No network calls in the app except an explicit, off-by-default user opt-in (the CLI's
  link-title fetching is opt-in via `--fetch-titles` and refuses private addresses). No CDN
  assets, remote fonts or Google APIs.
- Treat chat content, author and file names as untrusted: escape on render, sanitize ZIP
  paths, bound sizes.

## Supply chain

- pnpm only (`preinstall` enforces it). `minimumReleaseAge: 10080` in `pnpm-workspace.yaml`:
  never install a version published less than 7 days ago, and never bypass it (no `npx`
  `@latest` in scripts or config — pin exact versions).
- Exact pins only (`save-exact=true` in `.npmrc`); security overrides are exact too.
- No new dependency without a written justification in the plan (why, size, maintenance,
  alternatives). Prefer the platform and existing deps.
- Install scripts are denied by default; allow one in `allowBuilds` only with a reason.

## Tech stack

**App (PWA, in progress):** Next.js 16 App Router as a static export (`output: 'export'`,
`trailingSlash`, optional `NEXT_PUBLIC_BASE_PATH`; no server, no middleware), React 19,
next-intl (`ca` / `es` / `en`, prefixed static routes), Tailwind CSS 4 + shadcn/ui
(new-york, lucide icons), system fonts only. Installable offline PWA: web manifest with
generated icons and an Android share target; Serwist service worker built after
`next build` (`scripts/build-sw.mjs`: esbuild + `@serwist/build` `injectManifest` over
`out/`). Next.js telemetry is disabled.

**CLI:** TypeScript 6, Node ≥ 24 (ESM), pnpm 11, commander, fflate (inflate), date-fns,
picocolors; tsup build, tsx runner.

**Shared:** Vitest 5 with tests next to the code (`node` project for `lib/`, `cli/`,
`scripts/`, `i18n/`; `happy-dom` project for `app/`, `components/`, `hooks/`); ESLint 10 +
typescript-eslint, eslint-plugin-boundaries, import-x, i18next. Path alias `@/` → repo root.

**Next (Phase 2):** SQLite WASM persisted in OPFS; media as content-addressed blobs in OPFS;
heavy work in Web Workers; manual ZIP backup/sync between devices.

## Project structure

Current:

```
app/                    # Next.js routes: [locale]/ (welcome, settings, import, offline), /, manifest
components/             # UI components; ui/ = shadcn/ui primitives (button, card)
hooks/                  # React hooks (theme, device storage)
sw/                     # Service worker (Serwist): precache, offline page, share target
i18n/                   # next-intl routing, request config, navigation
messages/               # UI copy: en.json, ca.json, es.json (same keys, checked)
lib/                    # Platform-neutral core: Node AND browser (no node:*, no Buffer)
  domain/               # Pure types and constants (archive format version)
  storage/              # Browser storage: share inbox (Cache Storage), quota/persistence
  usecases/             # What the UI calls (device storage, shared files)
  log.ts                # The only console writer outside cli/ and scripts/
  importers/whatsapp/   # ZIP reader (central dir + ZIP64, fflate inflate), lines,
                        # timestamp detection, message state machine, chat name, media match
  importers/legacy/     # readers for old messages.json / .html / .csv outputs
  exporters/legacy/     # csv/json/md/html renderers (strings in, strings out) + js/ scripts
cli/                    # Node CLI: commander (import, import-legacy, render), fs adapters, pipeline, link titles
scripts/                # fixtures, i18n parity, preview server, smoke, agent hooks
**/*.test.ts(x)         # Vitest suites next to the code they cover
```

ESLint enforces the layers `app` → `components` → `hooks` → `lib/usecases` →
`lib/{domain,db,storage,importers,exporters}` (`boundaries/dependencies`; UI reaches data
only through use cases), `import-x/no-cycle`, `i18next/no-literal-string` in `app/` and
`components/`, `no-console` outside `lib/log.ts` / `cli/` / `scripts/`; forbids Node
built-ins, React and Next.js in `lib/**`; and requires a sibling `*.test.ts` for every module
in `lib/importers/**` (`local/require-test-file`). `scripts/eslint-architecture.test.ts`
proves each rule fires.

Target:

```
app/            # Next.js routes (static export)
components/     # UI components
hooks/          # React hooks calling use cases
lib/
  domain/       # Pure types, invariants, fingerprints (no I/O)
  db/           # SQLite WASM schema, migrations, queries
  storage/      # OPFS blobs (content-addressed)
  importers/    # WhatsApp ZIP → domain (idempotent)
  exporters/    # Backup / sync ZIP, Markdown/HTML/JSON exports
  usecases/     # Import, export, restore, merge
viewer/         # Standalone backup viewer (opens from disk)
cli/            # Node CLI on top of lib/
```

## Commands

```bash
pnpm dev                # App: next dev (http://localhost:3000)
pnpm preview            # Serve the built out/ on http://localhost:4173 (PORT=… to change)
pnpm cli <zip>          # Run the CLI from source (tsx)
pnpm cli import-legacy <messages.json|.html|.csv>   # Rebuild CSV + outputs from an old backup
pnpm cli render <dir>   # Re-render outputs from messages.csv
pnpm build              # Viewer scripts, CLI → dist/ (tsup), app → out/ (next build), out/sw.js
pnpm smoke              # Built CLI on the fixture ZIP + static export, manifest, sw.js checks
pnpm e2e                # Playwright (system Chrome) on the built out/ at 390 and 1440 px; run pnpm build first; not part of check
pnpm icons              # Regenerate app icons (scripts/generate-icons.mjs, no image tools)
pnpm i18n:check         # messages/{ca,es,en}.json have the same keys and placeholders
pnpm lint               # ESLint
pnpm typecheck          # next typegen + tsc --noEmit
pnpm test               # Generate synthetic fixtures, then vitest run
pnpm check              # i18n → lint → typecheck → test → build → smoke (the bar for "done")
pnpm rulesync           # Regenerate all AI editor configs (after editing .rulesync/)
pnpm rulesync:check     # Verify AI configs are in sync (runs in CI)
```

## Agents & routing

When a task matches an agent's domain, you MUST use that agent.

| Agent | Domain | When to use |
|-------|--------|-------------|
| `core-architect` | Domain model, parsing/importers, persistence (CSV today; SQLite/OPFS later), fingerprints, migrations, backup/restore & sync format, exporters, use cases | Any change that reads, writes, transforms or persists archive data — `lib/importers/`, `lib/exporters/`, `cli/pipeline.ts`, `cli/csv.ts`, `cli/media.ts`; later also `lib/{domain,db,storage,usecases}/` |
| `testing-expert` | Vitest suites next to the code; synthetic fixtures; regression, migration and round-trip tests | Writing or reviewing tests |
| `responsive-ui-designer` | PWA screens, components, the HTML viewer, responsive layout, accessibility, ca/es/en copy | Any user-facing UI |

**Data-layer work is never implemented inline: delegate to `core-architect`.**

Skills: `debugging`, `highlights-research`, `interview-me`, `pr-scope`, `pr-review`, `security-audit`, `rulesync`.

## Verification

- Run `pnpm check` before claiming a change is done; report what ran and what did not.
- If you change `.rulesync/`, run `pnpm rulesync` and commit the generated files with it.
- For a user-visible change (viewer or PWA), check it in a browser at 375 and 1440 px and
  say so. If you could not, say explicitly what was not verified.
- When touching CI, check the Node version against `.nvmrc` and `package.json` engines.

## Kill dev processes you start

If a task involves a long-running process (`pnpm dev`, a static server for the viewer, a
watcher, a Playwright browser), stop it before considering the task done. Parallel Conductor
workspaces each leaving servers running is what exhausts the machine.
