---
status: complete
phase: 01-parsing-model-core
source: 01-01-SUMMARY.md, 01-02-SUMMARY.md, 01-03-SUMMARY.md
started: 2026-08-21T16:05:00Z
updated: 2026-08-21T21:10:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: From a clean state: npm install succeeds, npm run build emits dist/index.js, and running the CLI on a real export ZIP produces a messages.csv without errors.
result: pass

### 2. Parse Real Export to CSV
expected: Running `npx tsx src/index.ts <zip> --out <dir>` creates `<dir>/<chat name>/messages.csv` whose first line is exactly `timestamp_iso,type,author,text,media` and first data row is the end-to-end encryption notice at 2026-07-23T09:47:18.
result: pass

### 3. Media Rows Correct
expected: Sticker/photo/video messages become rows with EMPTY text and the media filename in the last column (e.g. line 10 of Plataforma WK → sticker row with 00003010-STICKER-….webp).
result: pass

### 4. Multi-line Message Joined
expected: The WiFi credentials message appears as ONE row containing both "Rede: Conexão WK - Staff" and "Senha: TIMEWK2026" joined by a newline — no separate row for the Senha line.
result: pass
resolved_by: 01-04-PLAN (newline escaped; retested as test 13)
note: original issue "yes, but this will be a invalid CSV. The line break character must be escaped"

### 5. No Phantom Empty Rows
expected: Where WhatsApp emitted an empty message immediately followed by an attachment (lines 36-37), the CSV has ONE photo row — no empty-text row right before it.
result: pass

### 6. Same-second Burst Preserved
expected: The 5 photos Gian Carlo sent within the same second appear as FIVE distinct rows with different media filenames — none collapsed.
result: pass

### 7. Locale Auto-detection Report
expected: Running with `--verbose` prints a detection report: order DAY/MM, clock 24h, and a sample timestamp — no manual configuration needed.
result: pass
resolved_by: 01-04-PLAN (--zip alias + help examples; retested as test 14)
note: original issue "npm run start --verbose --zip ... -> npm swallowed --verbose"

### 8. Day/month Override Flags
expected: `--month-first` swaps ambiguous-date interpretation (report shows MM/DAY); `--day-first` forces back to DAY/MM.
result: pass
resolved_by: 01-04-PLAN (flag-safe help; retested as test 15)
note: original issue "npm warn Unknown cli config --day-first - flags never reach the program"

### 9. Omitted / Deleted / System Types
expected: "sticker omitted"/"image omitted"/"document omitted" rows have type=omitted with marker text kept; "Mensagem apagada" rows have type=deleted; group-event lines ("X added Y") keep their sender as author.
result: pass

### 10. Re-run Merge Without Duplicates
expected: Running the CLI a SECOND time into the same out dir reports "Merged 0 new message(s)" and the CSV row count is unchanged.
result: pass

### 11. CSV Always Sorted Ascending
expected: Scanning messages.csv top to bottom, timestamps never go backwards.
result: pass

### 12. Raw Author Strings Preserved
expected: Authors are byte-for-byte what WhatsApp exported — phone-number authors keep their invisible bidi wrappers, nicknames keep the "~ " prefix.
result: pass

## Summary

total: 20
passed: 14
issues: 5
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-01-17
  truth: "Output folder is the bare chat name (prefix stripped) and slugified for terminal use"
  status: resolved
  resolved_by: 01-06-PLAN
  resolved_at: 2026-08-21
  reason: "User reported: output folder should be only the chat name, without 'WhatsApp Chat - ' and slugified"
  severity: minor
  test: 17
  root_cause: "chatNameFromZip returns the raw display name; no prefix strip or slugification exists"
  artifacts:
    - path: "src/extract.ts"
      issue: "no slugify step"
  missing:
    - "slugifyChatName: strip ^WhatsApp Chat - , NFD-diacritics-free, lowercase, non-alphanum runs -> '-'"

- gap_id: G-01-16
  truth: "Output subfolder is the chat name derived from the ZIP file name when the export keeps _chat.txt at the archive root"
  status: resolved
  resolved_by: 01-05-PLAN
  resolved_at: 2026-08-21
  reason: "User reported: file was saved into ./backup/chat/messages.csv - the output folder should be named as the chat name from the zip file name"
  severity: major
  test: 16
  root_cause: "chatNameFromZip only reads the top-level FOLDER inside the zip; real WhatsApp exports place _chat.txt at the archive ROOT (no folder), so the fallback chain ends at the generic 'chat'"
  artifacts:
    - path: "src/extract.ts"
      issue: "fallback ignores the zip file basename; returns 'chat' for root-level _chat.txt"
  missing:
    - "When _chat.txt has no top-level folder, derive the chat name from the ZIP file basename (strip .zip), sanitized"

- gap_id: G-01-4
  status: resolved
  resolved_by: 01-04-PLAN
  resolved_at: 2026-08-21
  truth: "Multi-line messages are single rows whose embedded newline does not break the physical line structure of the CSV"
  status: failed
  reason: "User reported: yes, but this will be a invalid CSV. The line break character must be escaped"
  severity: major
  test: 4
  root_cause: "csvField applies RFC-4180 quoting but preserves RAW newlines inside quoted fields; the user requires one physical line per row (escaped \n)"
  artifacts:
    - path: "src/csv.ts"
      issue: "csvField keeps literal line breaks inside quoted fields; readCsv has no inverse escape"
  missing:
    - "csvField: escape backslash and CR/LF to literal \\\\ / \\n before quoting check"
    - "readCsv: unescape \\n / \\\\ back to real characters after field parse"
    - "Update tests that assert embedded real newlines in CSV text"

- gap_id: G-01-7
  status: resolved
  resolved_by: 01-04-PLAN
  resolved_at: 2026-08-21
  truth: "--verbose reaches the CLI through the documented start command and prints the format-detection report"
  status: failed
  reason: "User reported: npm run start --verbose --zip ... - npm intercepted --verbose (requires -- separator) and --zip is not a supported option; no report shown"
  severity: major
  test: 7
  root_cause: "npm run start consumes --verbose (npm requires the -- separator) AND the CLI defines no --zip option - ZIP is positional-only"
  artifacts:
    - path: "src/index.ts"
      issue: "commander accepts only positional <zip>; no --zip option alias"
    - path: "package.json"
      issue: "no documented flag-safe invocation; help does not show npm-run usage"
  missing:
    - "Add --zip <path> option as alias for the positional argument"
    - "Show copy-paste usage examples in --help (npm run dev -- <zip> --verbose)"

- gap_id: G-01-8
  status: resolved
  resolved_by: 01-04-PLAN
  resolved_at: 2026-08-21
  truth: "--day-first/--month-first override flags reach the parser through the documented start command"
  status: failed
  reason: "User reported: npm warn Unknown cli config --day-first - flags never reach the program through npm run"
  severity: major
  test: 8
  root_cause: "Same as G-01-7: npm intercepts pre--- flags; override flags never reach commander"
  artifacts:
    - path: "src/index.ts"
      issue: "flag reachability depends on invocation form not taught anywhere"
  missing:
    - "Covered by G-01-7 fixes (--zip alias + help examples)"
