# Adversarial review — empirical catalog

> **Provenance.** This catalog was seeded from the review history of a sibling project and
> adapted to Memory Archive. The finding classes are generic; the examples are rewritten for
> this repo (parser, importers, OPFS/SQLite, backup format, CLI). Refine it with this repo's
> own review history: add classes that recur here, drop the ones that never fire.

Complement to `.rulesync/skills/pr-review/references/pr-review.md` and
`.rulesync/checks/memory-archive-review.md`. Those cover the generic ground (secrets, tests,
types, structure). This document does **not** duplicate them: it covers only the finding
classes that recur in review and that a generic checklist tends to miss.

For each class: the question to ask against the diff, examples for this repo, and how to verify
it. Apply all of them in every round of the `/pr-precheck` loop — it is not a one-pass
checklist, it is what round B reviews.

Remember the distinction from `pr-scope.md` §2.0: if the finding is a **completion** (the code
already in the diff does not work without it), it is always in scope even if the file is not in
the baseline. If it is an **extension**, it is deferred.

---

## 1. Idempotency and re-runs

**Question:** if this operation runs twice (re-import of the same export, retried import after
a crash, sync ZIP applied twice), is the result the same as running it once?

**Examples:**
- Re-importing the same WhatsApp ZIP inserts every message again because the identity key is
  an auto-increment id instead of a stable hash of (chat, timestamp, sender, body, ordinal).
- An import interrupted halfway (tab closed) leaves half the messages; the next import skips
  the chat because it "already exists".
- Applying a sync ZIP from another device overwrites newer local edits.

**Verification:** every write path in importers and sync has a stable, content-derived key and
an upsert/skip rule. Multi-step writes run inside a single SQLite transaction or are resumable.
A test imports the same synthetic fixture twice and asserts identical row counts.

## 2. State before `await` (concurrency)

**Question:** between the start of an async operation and its completion, what happens if a
second request arrives (double click on "Import", two tabs, a second sync started while the
first is running)?

**Examples:**
- The "importing" flag is set after `await readZip(...)`, so a double click starts two
  imports of the same file.
- Two tabs open the same OPFS database and both run migrations.

**Verification:** the "in progress" state is written **before** the first `await`, not after.
Long operations are guarded (disabled button, lock, Web Locks API) and the guard is released on
error too.

## 3. Incomplete propagation (renames, new variants, registration)

**Question:** this diff renames a symbol, adds a variant to a union/enum, adds a new format or
importer, or changes a signature — has every consumer been updated, and is the new piece
registered where it is looked up?

**Examples:**
- A new date format added to the format list in `src/parse/` but not to the detection order,
  so it is never tried.
- A new message kind (e.g. `poll`) added to the domain type but not handled by the Markdown,
  HTML, or CSV renderers, which silently drop it.
- A field renamed in the domain model but still read under the old name by an exporter.
- A new migration file not added to the migration list.

**Verification:** `git grep -n "<old-name>"` returns nothing outside changelog/history.
Exhaustive `switch` statements use a `never` check so the typecheck fails on a missing variant.
Round C of the loop covers the direct callers.

## 4. Locale propagation

**Question:** does this code parse or render something locale-dependent (WhatsApp timestamps,
dates in the UI, UI strings)? Does it receive the locale explicitly, or does it assume a
default?

**Examples:**
- The parser assumes `DD/MM/YYYY` and silently swaps day and month on a US-locale export.
- Dates in the viewer are formatted with the system locale instead of the user's chosen UI
  locale (ca/es/en).
- A new UI string is added to one locale's messages but not the other two.

**Verification:** locale-dependent functions take the locale (or detected format) as an
explicit parameter. Parser changes are tested against synthetic fixtures for several export
locales, including ambiguous dates (day <= 12). New UI keys exist in all three locales.

## 5. Migrations on existing data

**Question:** a new required column or changed constraint in the schema — is it compatible with
archives created by older versions, or will reads/validations fail until a backfill runs?

**Examples:**
- A `NOT NULL` column added without a default; opening an existing OPFS database fails.
- A migration that rewrites all media rows in one statement on a large archive and is not
  resumable.

**Verification:** introduce it as optional or with a default, run an idempotent backfill, or
document why existing rows are never read through this path. Test the migration against a
database produced by the previous version (generated from synthetic fixtures).

## 6. Backup / restore round-trip and format versioning

**Question:** does every field the exporter writes get read back by the importer, and does the
backup carry a format version that a newer app can still read?

**Examples:**
- The exporter adds `reactions` to the backup JSON but restore ignores it, so a backup-restore
  cycle loses data.
- The backup format changes shape without bumping its version, and an older backup can no
  longer be restored.

**Verification:** a round-trip test: import fixture → export backup → restore into an empty
store → compare. Format changes bump the version and keep a reader for the previous one.

## 7. Secrets and `.env`

**Question:** does this diff loosen `.gitignore`, add a committed `.env`, or embed a key or
token in client code?

**Examples:** an `.env.local` accidentally un-ignored; an API key for an optional opt-in
service inlined in a component and shipped in the static bundle.

**Verification:** mechanical — `node scripts/check-pr-preflight.mjs` blocks it. Remember that
with `output: 'export'` everything in the client bundle is public.

## 8. Untrusted input from the export

**Question:** content from the ZIP (file names, paths, message bodies, sender names) is
attacker-controllable. Is it treated as untrusted everywhere it is used?

**Examples:**
- A ZIP entry named `../../something` is written outside the output folder (zip-slip) by the
  CLI extractor.
- A message body is inserted into the generated HTML or the viewer without escaping.
- A media file name is used in a `src` attribute without validation and can inject a
  `javascript:` URL.

**Verification:** normalize and confine every ZIP entry path to the target directory. Escape
all message content in HTML output (eta `<%= %>`, React text nodes, never raw HTML). Test with a
synthetic fixture containing hostile names and bodies.

## 9. Unbounded memory and scans

**Question:** does this code load a whole chat, a whole ZIP, or a whole table into memory, or
query "all rows" without a limit?

**Examples:**
- Reading `_chat.txt` with `readFile` instead of streaming line by line.
- Unzipping a video entry into a single `Uint8Array` instead of streaming it to disk/OPFS.
- The viewer runs `SELECT * FROM messages` for a chat with 200k messages instead of paging.

**Verification:** large inputs are streamed; queries that back lists use `LIMIT`/cursor
pagination. Check with a large synthetic fixture.

## 10. Dead links and routes

**Question:** does a button, link, or media reference point at something that actually exists
in the static export or the output folder?

**Examples:** a link to a settings page that does not exist in `app/`; the generated HTML
referencing `media/IMG-001.jpg` while the extractor wrote it under a different name; a
dynamic route that cannot be pre-rendered with `output: 'export'`.

**Verification:** `pnpm build` succeeds with the static export; links are checked against the
built output; renderer tests assert that every referenced media file exists.

## 11. Assets missing from the static build

**Question:** does the code load a file at runtime that the build does not ship (SQLite WASM
binary, worker script, font, template), or that the service worker does not precache for
offline use?

**Examples:** the SQLite WASM file is fetched from a path that exists in dev but not in the
exported `out/`; a new worker is not in the PWA precache list, so the app breaks offline.

**Verification:** build, serve `out/` statically, load the app, go offline, reload. Every
runtime asset must resolve from the static output.

## 12. Accessibility and responsive

**Question:** has a new visual change (dialog, import progress, message bubble) been checked on
mobile and with a screen reader? Do interactive elements have correct semantics?

**Examples:** an import progress indicator that is not announced; a long dialog that cannot be
scrolled on a short viewport; icon-only buttons without accessible names.

**Verification:** test at ~375px width. Confirmation/error elements are announceable
(`role="alert"`, `aria-live`). Long dialogs scroll. Icon buttons have labels in all three
locales.

## 13. Tests that lie, and missing tests for new branches

**Question:** does the mock or fixture reflect the **current** contract, or an older one? Does
every new branch (new format, new error path, new message kind) have a test that fails if the
logic breaks?

**Examples:** a renderer test still asserting the old JSON shape via a hand-written fixture;
a new parser branch for multi-line system messages with no test; a test that passes because
it asserts on an empty array.

**Verification:** when you change a return type or payload, grep all mocks and fixtures that
imitate it. Temporarily break the new logic and confirm a test fails. Fixtures come from
`scripts/generate-fixtures.mjs`, never from real exports.

## 14. State across tabs / instances

**Question:** if the user has two tabs open, or the app is updated while a tab is open, does new
state propagate (imported chats, deleted chats, settings, schema version)?

**Examples:** a chat deleted in one tab still shown in another; a tab running the old code
writes to a database already migrated by a newer tab.

**Verification:** state shared through OPFS/SQLite needs a coordination channel
(`BroadcastChannel`, `storage` event, Web Locks) and a schema-version check on open.

## 15. Swallowed or leaky errors

**Question:** is a caught error lost (generic log, empty `catch`), or exposed with sensitive
content (message text, file paths, contact names) where it should not be?

**Examples:** a `catch {}` around a single malformed line that silently drops the rest of the
chat; an error message that includes a full message body in the CLI output or a UI toast.

**Verification:** errors keep enough context to debug (file, line number, phase) but no message
content or personal data. Parse errors are counted and reported, not swallowed. Failures leave
the store in a consistent state.

## 16. Privacy and network

**Question:** does this change add a network request, a third-party script, analytics, a CDN
asset, or any way for data to leave the device? Does it persist something new the user was not
told about?

**Examples:** a font or icon loaded from a CDN (a network call on every load); a crash reporter
or analytics snippet; logging message content to the console; a new persisted field with
personal data that the backup does not cover or the delete action does not remove.

**Verification:** search the diff for `fetch(`, `http://`, `https://`, `<script`, and new
dependencies with network side effects. Any network access must be explicit opt-in. Delete
and export paths cover every new persisted field.

## 17. Stale docs and comments

**Question:** does the diff change behaviour that a README, CLI `--help` text, code comment,
or doc page still describes the old way?

**Examples:** the README still lists a removed CLI flag; a comment above the parser says
"only 24h formats are supported" after 12h support was added; the backup-format doc lacks the
new field.

**Verification:** `git grep` for the changed flag, option, or concept in `*.md` and comments.
Updating an existing doc in the baseline is in scope; writing a new doc page is an extension.
