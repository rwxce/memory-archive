# Roadmap

Approved 2026-10-20. Turns the wa-backup CLI into **Memory Archive** as described in
[`prd.md`](prd.md). Each phase is split into single-topic PRs into `dev`; every PR keeps
`pnpm check` green and updates [`blueprint.md`](blueprint.md) when it changes tooling or
architecture.

## Decisions

- **Installable PWA built with Next.js 16** (`output: 'export'`): static files only, no server.
  Works on iPhone, Android, Mac, Windows and Linux, offline after the first load. No Electron
  (it cannot run on phones).
- **Local only.** SQLite WASM and media in the browser's private file system (OPFS) on every
  device, desktop included. No Google APIs, no Google Cloud Console, no OAuth, no accounts.
- **The archive file is what counts.** `memory-archive-YYYY-MM-DD.zip` (database snapshot +
  media + manifest) can be exported and opened on any device.
- **Manual sync between devices** with ZIP files: full archive or a small *changes* pack,
  merged on import without duplicates.
- **Google Photos without APIs**: web download of selected photos, Takeout of one album, or the
  device gallery picker — followed by an in-app selection grid.
- **Distribution**: public Cloudflare Pages URL + GitHub Pages workflow for forks + local
  `pnpm dev` / `pnpm preview` for developers. A PWA needs HTTPS (or `localhost`); opening the
  built `index.html` with a double-click does not work. Only the exported viewer does.
- **UI languages**: `ca`, `es`, `en`. **Docs**: English.

## What is reused from wa-backup

Streaming parser (`src/parse/`), fflate ZIP streaming (`src/extract.ts`), sender colors
(`src/render/colors.ts`), `linkify.js`, XSS escaping, the bubble design of `src/render/html.ts`,
the fixture generator and the existing tests.

Known issues to fix while moving the code (Phase 1): `transcript.js` is not shipped in `dist/`
(the published CLI fails when writing HTML); `--no-fetch-titles` wipes stored titles;
`mediaPath` is always `null` in the JSON embedded in the HTML; unclosed `<video>` tags; title
fetching can reach private IPs; the hand-written ZIP reader has no ZIP64; no `audio` type; "me"
is guessed by message count; timestamps carry no timezone; dedupe uses raw text.

## Phase 0 — Tooling and docs

**Status: done.**

- pnpm 11, Node 24, exact pins, `minimumReleaseAge` 7 days, Dependabot cooldown 7 days.
- CI (`pnpm check`), branch policy guard, release workflow, CODEOWNERS, PR template.
- rulesync as the single source of agent rules, skills, commands, subagents, hooks and
  permissions (Claude Code, Codex CLI, Cursor, OpenCode).
- README, blueprint, PRODUCT, PRD, tone, privacy, branching docs; `.planning/` archived.
- **Verify:** `pnpm rulesync:check` clean; the hook blocks `gh pr comment`; CI green.

## Phase 1 — Reusable core (Node + browser) and fixes

**Status: done.**

- Move `src/` into `lib/importers/whatsapp/` and `lib/exporters/legacy/`; web streams /
  `Blob` instead of `fs`; one ZIP reader (fflate, ZIP64).
- Migrate tests to Vitest 4, next to the code; `local/require-test-file`.
- Fix the known issues above; add `audio`; link-title fetching off by default.
- New fixtures: Android, `en-US`, 12h, 2-digit years, multiline, iOS with/without media.
- Versioned JSON envelope (`schemaVersion`, `generator`) and readers for old wa-backup outputs
  (`messages.json`, the `chat-data` script inside `messages.html`, `messages.csv`). Markdown
  is not re-importable.
- **Verify:** same results as before on fixtures (snapshots); the parser also passes in a
  browser-like environment; a smoke test runs the built CLI.

## Phase 2 — PWA skeleton, local database, backup/restore proof of concept

**Status: done, except preview deploys (needs a Cloudflare account and secret, owner decision) and the
on-device checks below (iPhone, Android, airplane mode, a second browser).**

- Next.js 16 static export, `app/[locale]/`, next-intl, shadcn, Zliding-style ESLint
  (boundaries, no-cycle, no-console, no literal strings).
- PWA manifest, icons, Serwist service worker, offline page, Android share target for ZIPs.
- `lib/db`: SQLite WASM in OPFS inside a Web Worker; schema v1 and migrations.
- `lib/storage`: hash-addressed blobs in OPFS (write temp → rename), streaming reads,
  verification.
- Backup/restore into an empty library with manifest, integrity checks and safe extraction
  (no `..` or absolute paths, size and entry limits, manifest-listed paths only).
- Preview deploys from `dev`.
- **Verify:** install on iPhone, Android and desktop; works in airplane mode; round-trip
  archive → backup → restore in another browser gives identical tables and hashes; malicious
  ZIP tests.

## Phase 3 — Profiles and conversations

**Status: done, except the manual checks of the verify line (Safari/Firefox, a real touch device,
screen reader).**

- Create / edit / archive profiles (photo, relationship, description); move conversations
  between profiles without duplicating data.
- Screens: Home / People, Profile details, Conversations, basic Settings; first-run welcome
  with *Start* and *Open an archive*.
- **Verify:** use-case tests on in-memory SQLite; Playwright at 390 px and 1440 px.

## Phase 4 — Incremental WhatsApp import

**Status: done for WhatsApp ZIP exports, bare `.txt` exports made without media and old wa-backup outputs
(`messages.json` / `.html` / `.csv`, messages only: their media files are not in them), picked or shared. Not done:
loose media files as an import source (phase 8), and an on-device check of closing the tab mid-import (covered in
Chromium e2e and unit tests).**

- Import wizard: several files (ZIP, TXT, loose media, old wa-backup outputs) or shared from
  WhatsApp → source detection → profile per file → pick "me" → preview → duplicates →
  confirm → summary. Runs in a worker with progress; warns when space is short and offers
  "import without videos".
- Fingerprint + sha256 dedupe; each import is a transactional batch that can be undone;
  unparseable lines kept as raw text.
- Import history screen.
- **Verify:** same ZIP twice → 0 new; newer export → only the difference; closing the tab
  mid-import leaves the archive intact.

## Phase 5 — Timeline and navigation

**Status: done in code and Chromium e2e (PRs #26, #33-#48). Not done: a check on a real mid-range phone with 200k
messages (only a 200k synthetic archive in Node and 30k in Chromium with a 4x CPU throttle), Safari/Firefox/iOS checks of
the new screens. The Settings button for "erase everything" (`eraseDevice` clears database, search index, media,
thumbnails, share inbox, app keys) and the note button on the conversation rows of the person page are done. Schema was v6 then (v4 timeline index, v5 favorites, v6 notes; v7 highlights and v8 sync tracking followed): an older app refuses
newer backups.**

- Virtualized conversation view in the current HTML style; per-profile timeline, gallery with
  lightbox, audio archive, calendar (year → month → day), FTS5 search, favorites, notes,
  source of each item. Thumbnails with `OffscreenCanvas`.
- **Verify:** 200k-message synthetic archive scrolls smoothly on a mid-range phone.

## Phase 6 — Full backup and restore

**Status: done in code and Chromium e2e.** Done: full ZIP export and restore into an empty library; the Backup and restore screen (`/backup/`: storage usage, full backup, open a backup, integrity check of the library, check of a backup file without restoring). Replacing an existing library with a backup is done too (confirmation dialog, automatic safety copy downloaded first, two-stage progress, Stop until the swap). Optional password-encrypted backups are done too (`.mabackup`, AES-256-GCM; see `docs/formats/encrypted-backup.md`): a switch on the backup card, a password prompt when opening, replacing or checking a protected file, and plain backups marked private. The safety copy that replace downloads stays unencrypted (a documented gap). The acceptance scenario is automated in Chromium (`e2e/backup-restore.spec.ts`: ten people, plain and protected backups, restore on a clean browser, replace over an existing library). Not done: running it on Safari and Firefox, which stays a manual check until those e2e projects exist.

- Backup & restore screen: full export, restore, integrity check, storage usage; replace an
  existing library with confirmation and an automatic safety backup (done); optional
  encrypted backups (done).
- **Verify:** the PRD acceptance scenario automated (10 profiles → backup → restore on a clean
  browser → identical): done in Chromium; Safari and Firefox are checked by hand.

## Phase 7 — Manual device-to-device sync

**Status: done in code and automated tests (queue items 13-17). The changes-pack format is designed and documented in `docs/formats/changes-pack.md`;
schema v8 adds the device id, per-peer watermarks, tombstones and per-record change numbers (every write path stamps them); a restored or
replaced library is a new device; the use cases `lib/usecases/sync-state.ts` exist; a changes pack can be exported (plain or encrypted; watermarks move only
when the caller confirms delivery); importing a pack is a merge (one transaction, watermarks, conflicts kept beside the active record in the schema v9
table `sync_conflicts`, undone imports only offered, `resolveSyncConflict` mine / theirs / both). The `/sync` screen (device code and peers, export with a delivery confirmation, import with password and
result summary, pointers from Backup and the import wizard) is built, and so is the "Items to review" card on it (both versions side by side, keep this device's / take the other's / keep both for notes, offered import undos with a confirmation). Export reminders are done too: a quiet in-app card (People, Sync, Backup) for changes not yet shared with a known device and for no backup in 7 / 14 / 30 days, with "remind me later" (7 days) and "don't remind me", and a Settings section; local only, no notifications. Not done: the manual Safari / Firefox checks.**

- Device id; export a *changes* pack since the last export to that device, or the full
  archive; import = merge (messages by fingerprint, media by hash, profiles / favorites /
  notes by id) with a conflict screen; nothing is lost; export reminders.
- **Verify:** phone → changes pack → desktop gives the same archive; crossed edits raise a
  conflict; importing the same pack twice changes nothing.

## Phase 8 — Google Photos and loose files

**Status: not started.**

- Three ways to pick specific photos: Google Photos web download of a selection, Takeout of
  one album (keeps original dates and locations), or the device gallery picker.
- In-app selection grid grouped by date: only the marked photos are copied, to the chosen
  profiles. No automatic assignment by date. Same hash = one blob.
- **Verify:** synthetic Takeout fixtures; re-import does not duplicate.

## Phase 9 — Portable exports and hardening

**Status: not started.**

- Single-file read-only viewer (`viewer/`) that opens via `file://` with search and timeline;
  one, several or all profiles; date filters. Per-profile HTML / JSON / Markdown / ZIP.
- Volume tests, full-quota phones, failed imports, missing media, corrupted backups, restore on
  a clean device; complete Settings.

## Main risks

- **Browser storage limits on phones** (Safari above all) → persistent storage request, space
  warnings, import without videos or with reduced-quality videos.
- **Safari may clear data of non-installed sites after 7 days without use** → install to the
  home screen; periodic backup reminders.
- **WhatsApp date formats** → more fixtures; always keep the original line.
- **No timezone in WhatsApp exports** → store local time + assumed zone, editable per import.
- **Manual sync depends on the user** → reminders and small change packs.
