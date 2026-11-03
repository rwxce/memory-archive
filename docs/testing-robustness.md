# Robustness test matrix (Phase 9)

Which "bad day" scenarios are guarded, and where. All inputs are synthetic and built in code.
The rule behind every row: a failure is a typed error and leaves the library as it was.

| Scenario | Guarded by |
| --- | --- |
| Volume: long chat, import -> re-import -> backup -> clean-device restore -> JSON export | `lib/usecases/robustness-volume.test.ts` (30k messages by default; `ROBUSTNESS_MESSAGES=200000` for the stress run) |
| Volume: queries on 200k messages (conversation, person, search, favorites, notes) | `lib/db/*.perf.test.ts` |
| Volume: 20 MiB blob through backup and restore | `lib/usecases/archive.test.ts` ("a large archive") |
| Full storage during import (QuotaExceededError at each media file) | `lib/usecases/robustness.test.ts`; non-quota store failures in `import.test.ts` |
| Full storage during restore (at each media file), retry works | `lib/usecases/robustness.test.ts`; generic store failure in `exporters/archive/archive.test.ts` |
| Estimating space before an import, quota/usage display | `import-space.test.ts`, `archive-health.test.ts`, `lib/storage/quota.test.ts` |
| Failed import: wrong encoding, junk, empty, media-only, truncated ZIP | `robustness.test.ts`; hostile ZIPs and bombs in `import.test.ts` |
| Failed import: abort at every phase, lost connection, DB refusal, lock held | `import.test.ts` |
| Same export twice, overlapping newer export | `import.test.ts`, `robustness.test.ts` (also on a restored device) |
| Missing media at import / backup / export / verify | `import.test.ts`, `archive.test.ts` (`blob-missing`), `viewer-export.test.ts`, `export-package.test.ts`, `archive-health.test.ts` |
| Corrupted backup: bit flips anywhere, in a media entry, truncations incl. central directory | `robustness.test.ts` (sweeps), `exporters/archive/archive.test.ts` (named cases) |
| Corrupted backup: wrong hash/size, zip-slip names, duplicate entries, bombs, newer format/schema | `exporters/archive/archive.test.ts`, `archive-health.test.ts` |
| Encrypted backup: wrong/missing password, tampering, truncation | `exporters/archive/encrypt.test.ts`, `archive-encrypted.test.ts` |
| Older formats still restore | `archive.test.ts` (schema v1/v2), `lib/db/migrations.test.ts` |
| Restore on a clean device, then back up again, import again | `robustness.test.ts`, `import.test.ts` ("backup and restore with imported data") |
| Failed restore never leaves rows or files | `robustness.test.ts`, `exporters/archive/archive.test.ts` |
| Real OPFS / browser round trip | `e2e/backup-restore.spec.ts`, `e2e/import.spec.ts` (Playwright, not part of `pnpm check`) |

Known limits (not gaps): see "documented limits" in `import.test.ts` (media-less export after one
with media; skipped videos are not filled in later).
