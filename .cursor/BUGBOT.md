<!-- rulesync:check:memory-archive-review -->
## memory-archive-review

# Memory Archive PR review checklist

Flag any of the following in a PR diff:

## Privacy and personal data
- A real WhatsApp export, `_chat.txt`, `*.zip`, personal photo/video/audio, real name or phone
  number committed anywhere (fixtures, tests, docs, screenshots). Fixtures must come from
  `scripts/generate-fixtures.mjs`.
- A new network call (fetch, XHR, WebSocket, `<img>`/`<script>`/font from a remote origin,
  CDN asset) that is not behind an explicit, off-by-default user opt-in.
- Any telemetry, analytics, crash reporting or remote logging.
- Message text or author names written to logs outside an explicit verbose/debug path.

## Untrusted input
- ZIP entry names used as file-system or OPFS paths without rejecting `..`, absolute paths
  and drive letters.
- Whole-archive or whole-file buffering where streaming is possible; no bounds on entry
  size or count.
- Chat content, author names or file names inserted into HTML without escaping.

## Data integrity
- A change to message normalization or fingerprinting (`dedupeKey` today) without a
  migration plan and tests proving re-imports still deduplicate.
- A SQLite schema change without a numbered, transactional migration and a test upgrading
  from the previous version.
- A backup/sync ZIP format change without a `formatVersion` bump and a test that older
  versions still restore.
- An import path that can leave partial data behind on failure.

## Supply chain and tooling
- A new dependency without a stated justification, a non-exact version, or a version
  published less than 7 days ago.
- Hand edits to generated agent config (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.cursor/`,
  `.codex/`, `.opencode/`) instead of `.rulesync/`.
- `.gitignore` no longer ignoring `.env*`, `fixtures/`, `data/`, `output/` or `backup/`.

## Tests
- New parser/importer branches, migrations or format changes with no test in the same PR.
