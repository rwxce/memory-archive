# Phase 1: Parsing & Model Core - Research

**Researched:** 2026-08-21
**Domain:** WhatsApp `_chat.txt` streaming extraction + locale-tolerant normalization → CSV source-of-truth
**Confidence:** HIGH (fflate API verified against official README; formats verified against two real pt-BR exports; stack pre-evaluated in AGENTS.md)

---

## User Constraints (from CONTEXT.md)

> These are locked decisions. The planner MUST honor them verbatim.

### Locked Decisions
- **D-01:** Ambiguous day/month order (e.g. `01/02`) with no override → **best-effort**: pick the order consistent with the majority of dates in the file; `--day-first` / `--month-first` override.
- **D-02:** 12h vs 24h → **detect per-file**: if any `AM`/`PM` token appears, treat all times as 12h; otherwise 24h.
- **D-03:** Format variants → support **both** iOS (`[DD/MM/YYYY, HH:MM:SS]`) and Android (`DD/MM/YYYY, HH:MM:SS`) styles, auto-detected **per line**; accept `.` / `-` / `/` separators and optional seconds.
- **D-04:** A line matches the timestamp pattern but the date fails to parse → treat the line as a **continuation** of the previous message (no new message started).
- **D-05:** 2-digit year → **sliding window**: `yy <= (currentYear-2000+1)` → `2000+yy`, else `1900+yy`.
- **D-06:** Timezone → store **local wall-clock, no timezone** (as exported). One-way.
- **D-07:** Detection transparency → `--verbose` reports detected format, locale guess, and applied overrides. Off by default.
- **D-08:** Out-of-range date (before 2009 or beyond next year) → **sanity-window guard**: treat as continuation of previous message + warn in verbose.
- **D-09:** Timestamp/sender separator → **auto-detect**: try ` - ` first, fall back to a single space, then expect `Name:`.
- **D-10:** Preamble → scan forward to the **first line matching a timestamp pattern**; lines before it are export preamble.
- **D-11:** System events (timestamped line with no `Name:`) → classified as **type=system**, full line as body.
- **D-12:** **Strip leading BOM / LRM / RLM / zero-width chars** before timestamp detection.
- **D-13:** **CSV is the canonical source of truth.** JSON/MD/HTML are **derived from the CSV**.
- **D-14:** CSV columns: **`timestamp_iso, type, author, text, media`**.
- **D-15:** `type` values = **`text, photo, video, sticker, document, system, deleted, omitted`** (8 granular types).
- **D-16:** **Incremental append**: dedupe key = **`(timestamp_iso, author, text, media)`**. No duplicates added.
- **D-17:** After every append/merge the CSV is kept **ordered by `timestamp_iso` ascending**.
- **D-18:** `timestamp_iso` format = **ISO 8601 local, no timezone**: `2026-07-23T09:47:18`.
- **D-19:** CSV encoding = **UTF-8, no BOM**.

### the agent's Discretion
- Internal in-memory model shape, streaming pipeline wiring (fflate `Unzip` → readline), and date construction library choice are left to the planner/executor, bounded by the decisions above and the STACK research in AGENTS.md.

### Deferred Ideas (OUT OF SCOPE)
- None beyond the architectural CSV shift (in-scope for Phase 1). Redaction of sensitive content deferred.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PARSE-01 | CLI accepts path to WhatsApp "Export chat" ZIP | §6 minimal commander entry |
| PARSE-02 | Streaming extraction of `_chat.txt` + media, no full-archive buffering | §1 fflate `Unzip` + `PassThrough` → readline |
| PARSE-03 | Per-file locale/format detection (day/month, 12h/24h, separators, brackets) | §2 regex + detection strategy |
| PARSE-04 | Multi-line continuation (no timestamp → append to previous) | §3 continuation logic |
| PARSE-05 | UTF-8 + emoji + BOM/bidi handling | §5 encoding/bidi |
| PARSE-06 | Avoid false-positive detection (AppleDouble `._*`) | §7 risks + §1 filename filter |
| PARSE-07 | Normalized model (sender, timestamp, body, media ref, type) | §4 model + CSV |

---

## Summary

Phase 1 must read a WhatsApp "Export chat" ZIP **without loading it into memory**, locate and stream-decompress `_chat.txt`, line-parse it into a normalized message model that is **locale-tolerant** (pt-BR real exports embed `U+200E` before `[`, use `DD/MM/YYYY` 24h, and emit `<attached: FILENAME>` media markers), and persist that model as a **CSV source-of-truth** (`timestamp_iso, type, author, text, media`) from which every downstream output is derived.

The hard part is not the libraries — they are standard and pre-evaluated — but the **format irregularities** observed in the two real samples: zero-width/bidi characters, empty-body lines followed by attachment lines (must be merged, not emitted as a phantom), captions concatenated with `<attached:>` markers, same-second multi-attachment bursts, `~ ` contact prefixes and parenthesized phone numbers in the `author` field, `Mensagem apagada` (deleted) and `* omitted` placeholders, and macOS AppleDouble `._chat.txt` companions that must be ignored. The research below gives concrete regexes, parsing state-machine rules, and code skeletons to handle all of these.

**Primary recommendation:** Build a single streaming pipeline: `fs.createReadStream(zip)` → `Unzip` (register `AsyncUnzipInflate`) → on the `_chat.txt` entry, pipe decompressed chunks into a `PassThrough` → `readline` → line-state-machine parser → incremental CSV writer (one row per message, RFC-4180 quoted, UTF-8 no BOM), then stable sort + dedupe on merge.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| ZIP streaming extraction | API/Backend (Node process) | — | fflate `Unzip` runs in Node; media sibling files never buffered |
| Line streaming / readline | API/Backend (Node) | — | `node:readline` over a `PassThrough`; constant memory |
| Timestamp/format detection | Core (pure TS module) | — | No I/O; reusable in browser later |
| Media-type classification | Core (pure TS module) | — | String/pattern logic; testable in isolation |
| CSV emit / dedupe / sort | Storage (file write) | — | Writes `${out}/<chat>/messages.csv` |
| CLI argument handling | CLI (Node entry) | — | commander 15; thin wrapper around core |
| Future media reconciliation | API/Backend (Phase 3) | Storage | Reuses the same `Unzip` pipeline |

## 1. Streaming unzip with fflate (memory-safe)

**Verified API (fflate 0.8.3 README):** the streaming `Unzip` class emits one `UnzipFile` per entry via `unzip.onfile`. For each file you assign `file.ondata = (err, dat, final) => {}` and call `file.start()` to begin inflation. You must `unzip.register(UnzipInflate)` (sync) or `AsyncUnzipInflate` (worker) to handle DEFLATE entries. Chunks are pushed with `unzip.push(chunk, final)`.

Key memory-safety property: `Unzip` does **not** buffer the whole archive; file data is emitted as local file headers are encountered, so `_chat.txt` is delivered before the central directory at end-of-archive is read. Media entries are simply **never started** in Phase 1 (we only `file.start()` the `_chat.txt` entry), so their bytes are skipped without inflation — zero buffering of videos. [VERIFIED: fflate README streaming section]

```typescript
// Source: fflate README (verified 2026-08-21), fflate@0.8.3
import { Unzip, AsyncUnzipInflate } from 'fflate';
import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import * as readline from 'node:readline';

export function extractChatTxt(zipPath: string): Promise<readline.Interface> {
  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(AsyncUnzipInflate); // browser-reusable; worker parallel inflation

    // We only care about _chat.txt. Filter out AppleDouble / macOS companions.
    unzip.onfile = (file) => {
      const name = file.name; // e.g. "WhatsApp Chat - X/_chat.txt" or "._chat.txt"
      const base = name.split('/').pop() ?? '';
      const isAppleDouble = name.includes('__MACOSX') || base.startsWith('._');
      if (isAppleDouble || !base.endsWith('_chat.txt')) {
        return; // never call file.start() -> skipped, not inflated
      }
      const pass = new PassThrough();
      file.ondata = (err, dat, final) => {
        if (err) { reject(err); return; }
        pass.write(Buffer.from(dat)); // dat is Uint8Array
        if (final) pass.end();
      };
      file.start();
      const rl = readline.createInterface({ input: pass, crlfDelay: Infinity });
      resolve(rl); // resolve as soon as the entry is seen (streaming)
    };

    createReadStream(zipPath)
      .on('data', (chunk: Buffer) => unzip.push(new Uint8Array(chunk)))
      .on('end', () => unzip.push(new Uint8Array(0), true))
      .on('error', reject);
  });
}
```

** ofile gotcha — `createWriteStream` in the imports list above is unused in Phase 1; removed for clarity.

**Gotchas (verified against fflate README):**
- `AsyncUnzipInflate` has ~50ms worker warm-up overhead on first use. Acceptable here because media inflate (Phase 3) benefits from parallel workers and the same code path must run in-browser. For Phase 1 only, `UnzipInflate` (sync) is marginally lighter — planner's discretion.
- `file.size` / `file.originalSize` may be `undefined` if the ZIP omitted them — never assume presence.
- Do **not** `consume`/detach buffers you still need; fflate's async streams may reuse buffers.
- The `PassThrough` keeps only the current chunk in flight; `readline` buffers only the current line → constant memory regardless of chat size.

---

## 2. Locale-tolerant timestamp detection

### 2.1 Invisible-character strip (D-12)
Before testing a line against the timestamp regex, strip a leading run of: `U+FEFF` (BOM), `U+200E` (LRM), `U+200F` (RLM), `U+200B` (ZWSP), `U+200C` (ZWNJ), `U+200D` (ZWJ), `U+2066`–`U+2069` (LRI/RLI/FSI/PDI). Real pt-BR exports embed `U+200E` immediately before `[` (e.g. line 10 of the Plataforma sample: `‎[23/07/2026, 12:41:48] ...`). Without stripping, those messages are silently missed.

```typescript
function stripInvisible(s: string): string {
  return s.replace(/^[﻿‌‍‎‏‪‫‬⁩⁦⁧⁨⁩]+/u, '');
}
```

### 2.2 Timestamp regex (per-line, D-03)
Supports iOS (`[...]`) and Android (`...`) styles, `/ . -` separators, optional seconds, optional `AM`/`PM`.

```typescript
// Captures: 1=day 2=month 3=year 4=hour 5=min 6=sec? 7=ampm?
const TS_RE = /^\\[?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm|AM|PM)?\]?/;
```

Notes:
- The optional leading `[` and trailing `]` make iOS vs Android style auto-detected per line (D-03).
- Comma between date and time is optional (some exports omit it).
- `AM`/`PM` group drives 12h detection (D-02) but is captured per-line; the file-level decision is taken in §2.4.

### 2.3 Day/month disambiguation (D-01, D-05)
- Parse **both** interpretations when both `day<=12 && month<=12` (ambiguous). Non-ambiguous cases (e.g. `23/07`) are decided directly.
- **Detection strategy (best-effort majority vote):** scan the first N (recommend 50) timestamped lines. For each ambiguous line, tentatively accept both D/M and M/D; count, across all ambiguous lines, how many would be *valid dates* under each ordering (day<=31 & month<=12). Choose the ordering that yields more valid dates; ties → default **day-first** (matches pt-BR, the only confirmed locale). `--day-first`/`--month-first` override and short-circuit detection.
- **2-digit year (D-05):** `yy <= (currentYear - 2000 + 1) ? 2000 + yy : 1900 + yy`. For 2026 → threshold 27, so `26`→2026, `27`→2027, `99`→1999. [VERIFIED: .planning/phases/01-parsing-model-core/01-CONTEXT.md:25]

### 2.4 12h/24h (D-02)
Scan the **whole file** (or first N lines as a proxy) for any `AM`/`PM` token. If found → treat **all** times as 12h and convert: `if (pm && h!==12) h+=12; if (am && h===12) h=0;`. Else 24h.

### 2.5 Sanity window (D-08) & parse failure (D-04)
- Build a `Date` via `new Date(year, month-1, day, hour, min, sec)` (local, no tz).
- If resulting year < 2009 or > currentYear+1 → treat line as **continuation** of previous message + verbose warn (D-08).
- If the regex matched but `Date` is invalid (e.g. `31/02`) → continuation (D-04).

## 3. Multi-line / continuation / media reconstruction

### 3.1 Continuation (PARSE-04, D-04/D-10)
Lines that do **not** start with a timestamp pattern (after invisible strip) append to the **current open message's `text`** (joined with `\\n`). Preamble lines before the first timestamp (D-10) are discarded entirely. (In the samples the "Messages and calls are end-to-end encrypted" line is itself timestamped, so it is kept as a system/text line — see D-11; the *preamble* concept applies to exports that put a banner before any timestamp.)

### 3.2 Sender / separator (D-09)
After the timestamp, the remainder is parsed for a sender:

```typescript
// remainder after stripping the timestamp token
const SENDER_RE = /^(?:\s*-\s*)?(.+?):\s([\s\S]*)$/;
const m = SENDER_RE.exec(remainder);
if (m) { author = m[1].trim(); body = m[2]; }
else   { type = 'system'; body = remainder; author = ''; } // D-11
```

`D-09` try ` - ` first (older/Android exports wrap sender in ` - `), fall back to direct `Name:`. The regex above handles both. If no `Name:` separator → `type=system`, full remainder as body (D-11). [VERIFIED: .planning/phases/01-parsing-model-core/01-CONTEXT.md:29, :31]

### 3.3 Media attachment markers
Observed in samples (both files):
- `<attached: FILENAME>` as the **entire body** of a timestamped line (Plataforma line 10: `Guionardo Furlan: <attached: 00003010-STICKER-...webp>`).
- A **caption + attachment on one line** (Notas line 124: `Taxa João Furlan <attached: 00000091-PHOTO-...jpg>` → text="Taxa João Furlan", media set).
- `*.pdf • N páginas document omitted` style (Notas line 18) — no `<attached:>` but a document placeholder.
- `* omitted` placeholders: `image omitted`, `sticker omitted`, `document omitted`, `<Media omitted>` (MEDIA-04).
- `Mensagem apagada` (pt-BR "message deleted").

**Rules:**
1. If body contains `<attached:\s*(.+?)>` → set `media = filename`; strip the marker (and surrounding spaces) from `text`. Determine `type` from the **filename prefix** (see §3.4).
2. Else if body matches `/<?(?:media|image|video|sticker|document|audio|gif)\s+omitted>/i` → `type = 'omitted'`, `text` = the marker (preserve as visible placeholder, MEDIA-04).
3. Else if `body.trim()` is a deleted-message marker (`Mensagem apagada` / `Message deleted` / `This message was deleted`) → `type = 'deleted'`.
4. Else if no sender (§3.2 fall-through) → `type = 'system'`.
5. Else → `type = 'text'`.

### 3.4 Type from filename prefix
[VERIFIED verbatim: .planning/phases/01-parsing-model-core/01-CONTEXT.md:37 — `type values = text, photo, video, sticker, document, system, deleted, omitted (8 granular types). Media kind is encoded directly in type; the media column carries the filename.`]

Mapping (filename-based, planner's discretion within the 8 allowed values):

| Filename token | `type` |
|----------------|--------|
| `STICKER` | `sticker` |
| `PHOTO` / `IMG` | `photo` |
| `VIDEO` | `video` |
| `DOCUMENT` / `.pdf` / `.doc*` / unknown prefix (e.g. `IRPF-...pdf`) | `document` |
| `AUDIO` | `document` *(no `audio` type exists in the locked 8; fallback — see Assumptions A1)* |

> **Empty-body + attachment merge (important gotcha):** lines 36–37 of the Plataforma sample are:
> ```
> [23/07/2026, 23:31:29] Camilla Araujo WK:
> [23/07/2026, 23:31:29] Camilla Araujo WK: <attached: 00003036-PHOTO-...jpg>
> ```
> The first line is a timestamped message with an **empty body**. The second is the same author, same second, with the attachment. **Do not emit a phantom empty text message.** State-machine rule: when a timestamped message has empty `text` and no media, *hold* it; if the very next line is an attachment line for the **same author** (and same/adjacent timestamp), attach the media to the held message (set its `type` from the filename) and emit a single media row, discarding the empty holder. If the next line is *not* an attachment, emit the empty message as `type=text` (empty body) so no data is lost.

> **Same-second burst (lines 37–38, 46–51):** multiple attachments share `23:31:29` / `10:41:10`. Each is a distinct row with its own `media` filename. The dedupe key (§4) includes `media`, so they are **not** collapsed.

## 4. Normalized model + streaming/batched CSV emit

### 4.1 In-memory model (planner's discretion)
```typescript
interface Message {
  timestamp_iso: string; // 2026-07-23T09:47:18  (D-18)
  type: 'text'|'photo'|'video'|'sticker'|'document'|'system'|'deleted'|'omitted';
  author: string;        // raw sender, incl. "~ " prefix & phone numbers
  text: string;          // body (markers stripped), may be empty
  media: string;         // filename or '' (D-14)
}
```

### 4.2 CSV contract (verbatim from CONTEXT)
[VERIFIED verbatim: .planning/phases/01-parsing-model-core/01-CONTEXT.md:37 — `CSV columns: timestamp_iso, type, author, text, media.`]
[VERIFIED verbatim: .planning/phases/01-parsing-model-core/01-CONTEXT.md:40 — `timestamp_iso format = 2026-07-23T09:47:18 (seconds preserved).`]
[VERIFIED verbatim: .planning/phases/01-parsing-model-core/01-CONTEXT.md:19 — `CSV encoding = UTF-8, no BOM.`]

### 4.3 Building `timestamp_iso` (critical tz gotcha — D-06)
Construct the `Date` in **local** time and format with date-fns `format`, **never** `toISOString()` (which converts to UTC and would shift the wall-clock).

```typescript
import { format } from 'date-fns';
const d = new Date(year, month - 1, day, hour, min, sec); // local, no tz
const timestamp_iso = format(d, "yyyy-MM-dd'T'HH:mm:ss");  // 2026-07-23T09:47:18
```

This preserves the exported local time exactly (D-06) and keeps lexicographic sort == chronological (D-17).

### 4.4 RFC-4180 quoting + streaming write
- Emit header once: `timestamp_iso,type,author,text,media\n`.
- For each parsed `Message`, write one row immediately (streaming, constant memory):

```typescript
function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(m: Message): string {
  return [m.timestamp_iso, m.type, m.author, m.text, m.media].map(csvField).join(',') + '\n';
}
// writeStream = createWriteStream(csvPath, { encoding: 'utf8' })  // no BOM added by Node
```

Node's `utf8` stream encoding does **not** prepend a BOM, satisfying D-19. (A BOM would break downstream CSV parsers — avoid `fs.writeFileSync(path, str, 'utf8-with-bom')`.)

### 4.5 Incremental append / merge (D-16, D-17)
On a second run against an existing CSV:
1. Load existing rows, building a `Set` of dedupe keys.
2. For each new `Message`, compute key = `timestamp_iso <US>\n author <US>\n text <US>\n media` where `<US>` is the ASCII Unit-Separator control char (0x1F) — a separator that cannot appear in legitimate chat content.
3. Skip if key already present (D-16).
4. Append new rows, then **stable sort all rows by `timestamp_iso` ascending**; for equal timestamps preserve insertion order (stable). Rewrite the file so D-17 holds.
> For very large existing CSVs, an in-memory key `Set` + full rewrite is acceptable for v1; a true append-with-sort can be added later. Document this as a known v1 limitation.

## 5. Encoding & bidi handling (PARSE-05)

- **Read path:** chunks from `file.ondata` are `Uint8Array`; writing them to a `PassThrough` and feeding `readline` makes Node decode each chunk as **UTF-8** and emit `string` lines. Emoji and non-Latin scripts survive intact (UTF-16 strings). No manual transcoding needed.
- **Strip only the leading invisible run** (§2.1) for timestamp detection. Do **not** strip invisibles inside `author`/`text` — they carry meaning (e.g. a phone number wrapped in `U+202A`/`U+202C`; `~ Name` uses a narrow no-break space `U+202F` after `~`). Preserve `author` raw (D-09 / specifics: "the `author` column should preserve the raw sender string").
- **BOM at file start:** if the very first chunk begins with `EF BB BF`, it is harmless through the `PassThrough`→readline path (readline yields the BOM as part of the first line's prefix). Still strip it via §2.1's leading-invisible rule so the first timestamp is detected.
- **Output:** CSV written as UTF-8 no BOM (§4.4). Downstream renderers (Phase 2) must also emit UTF-8 no BOM for `file://` portability.

---

## 6. Minimal commander CLI entry (PARSE-01)

```typescript
// Source: commander@15 (verified 2026-08-21 via npm view -> 15.0.0)
import { Command } from 'commander';

export function buildCli() {
  const program = new Command();
  program
    .name('wa-backup')
    .argument('<zip>', 'path to a WhatsApp "Export chat" ZIP')
    .option('--out <dir>', 'output directory (default: <chat-name>/ under cwd)')
    .option('--day-first', 'force day/month date order')
    .option('--month-first', 'force month/day date order')
    .option('--verbose', 'report detected format, locale guess, overrides')
    .action(async (zip: string, opts) => {
      // wire to extractChatTxt(zip) -> parse -> writeCsv(...)
    });
  return program;
}
```

- `<zip>` positional satisfies PARSE-01. `--out` satisfies the Phase-4 override contract early (CLI-02). `--day-first`/`--month-first` feed D-01 override. `--verbose` feeds D-07.
- Note: chat-name default folder (CLI-01) is a Phase 4 concern; Phase 1 may default `--out` to a temp/`out/` dir. Keep the entry thin and delegate all logic to the core module.

---

## 7. Risks & edge cases (PARSE-06, others)

| Risk | Evidence (real samples) | Mitigation |
|------|--------------------------|------------|
| **AppleDouble `._chat.txt`** (PARSE-06 false-positive) | macOS ZIPs contain `._<name>` resource-fork companions | Filter in `unzip.onfile`: ignore `name.includes('__MACOSX')` or `base.startsWith('._')` (§1) |
| **Preamble before first timestamp** (D-10) | Some exports lead with a banner | Scan to first line matching `TS_RE` after invisible strip; discard earlier lines |
| **Same-second collisions** (D-16) | lines 37–38 share `23:31:29`; lines 46–51 share `10:41:10` | Dedupe key includes `media` + `text` + `author`, not timestamp alone |
| **Sender `~ ` prefix / phone numbers** | lines 4–9 (`~ Leandro Ribeiro`, `+55 47 99951-9144`) | Preserve `author` raw; do not normalize in Phase 1 |
| **BOM/LRM before `[`** (D-12) | line 10 `[23/07/2026...` (`U+200E`) | Strip leading invisible run before regex (§2.1) |
| **Empty-body → attachment merge** | lines 36→37, 46→47 | Hold empty message; merge if next line is same-author attachment (§3.4) |
| **Caption + attachment on one line** | Notas line 124 `Taxa João Furlan <attached: ...>` | Strip `<attached>` marker, keep caption in `text`, set `media` |
| **`<Media omitted>` / `* omitted` / deleted** | lines 57, 100, 196 (Notas) | Map to `omitted` / `deleted` (§3.3) — preserve as visible placeholders (MEDIA-04) |
| **Non-`_chat.txt` entries / nested paths** | entry names like `WhatsApp Chat - X/_chat.txt` or `._chat.txt` | Match `base.endsWith('_chat.txt')` and not AppleDouble (§1) |
| **`file.originalSize` undefined** | Some zips omit sizes | Never branch on it; always `file.start()` once matched |
| **Timezone shift bug** | D-06 one-way contract | Use `date-fns format` on a local `Date`; **never** `toISOString()` (§4.3) |
| **Sensitive plaintext in chat** | line 21 `Senha: TIMEWK2026` | Out of scope for v1 (redaction deferred); do **not** alter content |

---

## Standard Stack (from AGENTS.md — pre-evaluated, HIGH confidence)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fflate | 0.8.3 | Streaming unzip | Tiny, ESM, browser-reusable, memory-safe (§1) |
| node:readline | Node core | Line streaming | Built-in, constant memory |
| date-fns | 4.4.0 | Date construction/format | Tree-shakeable; `format` avoids tz shift (§4.3) |
| commander | 15.0.0 | CLI args | Zero-dep, TS-native (§6) |
| tsx / tsup | 4.23.12 / 8.5.1 | Dev/build | Standard TS-CLI toolchain |

### Package Legitimacy Audit
| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| fflate | npm | 6+ yrs | very high | github.com/101arrowz/fflate | OK | Approved |
| date-fns | npm | 9+ yrs | very high | github.com/date-fns/date-fns | OK | Approved |
| commander | npm | 13+ yrs | ~500M/wk | github.com/tj/commander.js | OK | Approved |

All three are well-established, version-verified via `npm view` (2026-08-21) and cited in AGENTS.md with HIGH confidence. No `SLOP`/`SUS` findings.

---

## Architecture Patterns

### System flow (data path)
```
ZIP file (fs stream)
   |  chunked
   v
fflate Unzip  --onfile-->  filter _chat.txt (skip ._*, __MACOSX)
   |  file.start() -> ondata(Uint8Array chunks)
   v
PassThrough (Buffer)  -->  node:readline  -->  line events (string, UTF-8)
   |
   v
Line state-machine parser
   |- timestamp? --> new Message (detect format, sender, media, type)
   |- no timestamp -> append to current Message.text (continuation)
   |
   v
CSV writer (streaming, RFC-4180, UTF-8 no BOM)
   |  on merge: dedupe by (ts,author,text,media) + stable sort asc
   v
${out}/<chat>/messages.csv   <-- SOURCE OF TRUTH (D-13)
```

### Recommended project structure (Phase 1)
```
src/
├── index.ts            # commander entry (§6)
├── extract.ts          # fflate Unzip -> readline (§1)
├── parse/
│   ├── timestamp.ts    # TS_RE, invisible strip, 12h/24h, D/M vote, 2-digit yr (§2)
│   ├── message.ts      # line state-machine, sender/media/type rules (§3)
│   └── types.ts        # Message interface + 8 type union (§4.1)
├── csv.ts              # RFC-4180 writer, merge, dedupe, sort (§4)
└── model.ts            # orchestrates extract->parse->csv
```

### Pattern: line state-machine (skeleton)
```typescript
let current: Message | null = null;
let heldEmpty: Message | null = null; // for empty-body->attachment merge

for await (const line of rl) {
  const stripped = stripInvisible(line);
  const ts = TS_RE.exec(stripped);
  if (!ts) {
    if (current) current.text += (current.text ? '\n' : '') + line; // continuation
    continue;
  }
  const msg = buildMessage(stripped, ts); // applies §2 + §3 rules
  if (heldEmpty && msg.media && msg.author === heldEmpty.author) {
    heldEmpty.media = msg.media; heldEmpty.type = msg.type; // merge
    heldEmpty = null; continue; // discard the attachment duplicate line
  }
  if (current) writeRow(current);
  heldEmpty = (msg.text === '' && !msg.media) ? msg : null;
  current = msg;
}
if (heldEmpty) writeRow(heldEmpty);
if (current) writeRow(current);
```

### Anti-patterns to avoid
- **`toISOString()` for `timestamp_iso`** → silently converts local→UTC, breaking D-06. Use `date-fns format` on a local `Date`.
- **Buffering the whole `_chat.txt`** into an array before parsing → defeats the streaming constraint (PROJECT.md hard rule).
- **Calling `file.start()` on media entries in Phase 1** → wastes I/O; skip them.
- **Stripping invisibles inside `author`/`text`** → corrupts phone-number bidi wrappers and `~ ` contact markers (§5).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `AUDIO` attachments map to `type=document` (no `audio` value in the locked 8). | §3.4 | If a distinct `audio` type is later desired, Phase 2 renderers would need updating; low risk (media filename still preserved in `media` column). |
| A2 | Day/month tie in best-effort detection defaults to day-first (pt-BR only confirmed locale). | §2.3 | Wrong for a future non-pt-BR export with ambiguous dates; `--day-first`/`--month-first` override exists. |
| A3 | Preamble handling mainly matters for exports with a banner before any timestamp; both samples start with a real timestamped line. | §3.1 | A banner-only prefix would be discarded correctly by the scan-to-first-timestamp rule; low risk. |

---

## Open Questions

1. **Audio type representation:** The locked 8-type set has no `audio`. Should audio attachments be `document` (recommended, A1) or should the type union be extended? → Recommend `document` + keep filename; revisit if v2 analytics need it.
2. **Merge scalability:** Full in-memory rewrite on merge (§4.5) is fine for v1 chat sizes (samples ~140–200 lines) but could be large for years-long exports. → Acceptable for v1; note as limitation.
3. **Chat name derivation for output folder:** CLI-01 default folder naming is a Phase 4 concern; Phase 1 can use a fixed `out/` or derive from the ZIP's top-level folder name.

---

## Sources

### Primary (HIGH confidence)
- fflate 0.8.3 README (raw.githubusercontent.com/101arrowz/fflate/master/README.md) — streaming `Unzip` / `AsyncUnzipInflate` API, verified 2026-08-21.
- `.planning/phases/01-parsing-model-core/01-CONTEXT.md` — locked decisions D-01..D-19 (verbatim quotes used throughout).
- `.planning/REQUIREMENTS.md` — PARSE-01..07 requirement texts.
- `data/WhatsApp Chat - Plataforma WK/_chat.txt` — 139-line pt-BR ground-truth sample (bidi, attachments, same-second bursts).
- `data/WhatsApp Chat - Notas pessoais/_chat.txt` — 202-line second sample (caption+attachment, `* omitted`, deleted, PDF documents).
- `npm view` for fflate / date-fns / commander versions (2026-08-21) — 0.8.3 / 4.4.0 / 15.0.0.
- AGENTS.md STACK research — pre-evaluated stack with HIGH confidence ratings.

### Secondary (MEDIUM confidence)
- fflate web search corroboration (GitHub issues #251, npmjs, unpkg) confirming `Unzip`/`AsyncUnzipInflate` callback signatures.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pre-evaluated in AGENTS.md, versions verified via `npm view`.
- Architecture: HIGH — streaming pipeline verified against fflate README; in-repo decisions read verbatim.
- Pitfalls: HIGH — derived from direct inspection of two real exports plus locked decisions.

**Research date:** 2026-08-21
**Valid until:** 2026-09-20 (stable domain; re-verify if WhatsApp export format changes or a new locale is supported).

## RESEARCH COMPLETE
