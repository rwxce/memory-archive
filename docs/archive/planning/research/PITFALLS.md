# Domain Pitfalls: WhatsApp Chat-Export Parser / CLI

**Domain:** Parser + renderer for WhatsApp "Export chat" ZIP (`_chat.txt` + media)
**Researched:** 2026-08-21
**Overall confidence:** MEDIUM–HIGH (parsing facts corroborated across 3+ independent open-source parsers and vendor blogs; security facts from published CVE advisories)

> Scope note: This file focuses on the *Pitfalls* dimension only. The companion
> STACK / FEATURES / ARCHITECTURE research is separate. Phase names below are
> proposed — the actual ROADMAP phases should map onto them. The project's own
> `PROJECT.md` already flags several of these (locale dates, media reconciliation,
> streaming, `<Media omitted>`/deleted placeholders).

---

## Critical Pitfalls

### Pitfall C1: Locale-dependent date/time formats break parsing

**What goes wrong:** The timestamp on every message line is formatted by the
*exporting device's* locale/region, not by WhatsApp canonically. Observed variants:

- Day/month order: `DD/MM/YYYY` (EU) vs `MM/DD/YYYY` (US).
- Separators: `/` (most), `.` (German/Turkish/Android), `-`.
- Clock: 24h (`14:30`) vs 12h with **localized** AM/PM markers — `AM/PM`, `p. m.`,
  `م`/`ص` (Arabic), `上午`/`下午`, `오전`/`오후`.
- Year: 4-digit (`2024`) vs 2-digit (`24`).
- Numerals: ASCII **and** Eastern Arabic-Indic (`٠١٢٣`) for Arabic/Persian phones.
- iOS brackets `[…]`, Android often bare `… - Name:`.

**Why it happens:** No schema; the format is a side effect of phone settings. A parser
hard-coded to one format silently mis-orders days/months or fails to match entirely.

**Consequences:** Wrong timestamps (or all messages dropped as "no match"), which
corrupts ordering, day-grouping, and any time-based analysis. This is the single
most common parser failure mode.

**Warning signs:**
- Parser only detects messages on one known locale; test files from a US phone and
  a German phone both parse.
- Dates where `day > 12` parse fine but `day ≤ 12` look plausible-yet-wrong.
- Zero messages parsed on a real export despite visible content.

**Prevention:**
- Detect format **per-file**, not per-line: scan a sample of header lines, build a
  candidate set of formats, and pick the one that matches the most lines (e.g.
  `whatsapp-export-parser`'s `detectDayFirst` whole-file heuristic).
- Support day-first **and** month-first; when ambiguous (all days ≤ 12) fall back to
  the detected heuristic and expose an override flag (`--day-first`/`--month-first`).
- Normalize numerics before parsing: map Eastern Arabic-Indic and other non-Western
  digits to ASCII.
- Strip leading BOM and iOS bidi marks (`U+200E`/`U+200F`, LRM/RLM/FSI/PDI) **before**
  timestamp matching.
- Never assume a UTC offset — the export carries **no timezone**. Preserve the local
  wall-clock time in output (e.g. ISO 8601 *without* offset, or clearly label it local).
  Do not invent `+00:00`.

**Suggested phase:** Parser core / normalization (must be solved before any other
feature is trustworthy).

---

### Pitfall C2: Multi-line messages are split into fake messages

**What goes wrong:** A message body containing line breaks is written as a timestamped
first line followed by continuation lines with **no timestamp**. A naive
"one line = one message" reader splits a single message into many, corrupting text
and inflating the message count.

**Why it happens:** WhatsApp writes continuation lines verbatim; nothing marks them.

**Consequences:** Broken message text, wrong counts, wrong per-sender stats, broken
quotes/replies that span lines.

**Warning signs:** Message bodies that start mid-sentence with no sender; message
count far exceeds expectation; replies/quotes truncated at the first newline.

**Prevention:**
- Stateful line reader: a line that does **not** match the timestamp-header regex is
  appended to the *current* in-progress message (with `\n`), not started fresh.
- Use lookahead/accumulator: only commit a message boundary when the *next* line is a
  valid header.

**Suggested phase:** Parser core (same phase as C1; they are inseparable).

---

### Pitfall C3: False-positive message-line detection

**What goes wrong:** Lines that *look* like timestamps but are not message headers get
misparsed — and, separately, the **macOS `._chat.txt` AppleDouble file** gets picked up
by `*.txt` globs and parsed as chat content.

**Why it happens:**
- System/event lines (joins, encryption notice) *do* start with a timestamp but have
  no `Name: ` sender — easy to mis-handle as a message.
- A user's message text can itself contain a timestamp-like substring (e.g. pasted log).
- When exporting from a Mac, the ZIP also contains `._chat.txt` (resource fork); a
  glob of `*.txt` may match it and feed garbage to the parser.

**Consequences:** Phantom messages, duplicated/garbled first entry, or total parse
failure on Mac-sourced exports.

**Warning signs:** First parsed line is binary/garbage; a message with empty sender and
body that is clearly an OS artifact; "messages" whose content is an AppleDouble header.

**Prevention:**
- Require the header pattern to include the sender delimiter (` - ` for Android,
  `] ` for iOS bracketed) — not just a date-looking token.
- When opening a ZIP, explicitly **ignore `._*` files** and any file not named
  `_chat.txt` / `WhatsApp Chat with *.txt`.
- Treat timestamp-without-sender lines as **system messages**, not user messages.

**Suggested phase:** Parser core (file-selection + classification step).

---

### Pitfall C4: Media filename mismatches & missing files

**What goes wrong:** The txt references media by filename (`IMG-20240101-WA0001.jpg`,
`PTT-…opus`, `VID-…mp4`, or documents with their *original* name), but the actual file
in the media folder may differ: case differences, duplicates suffixed `(1)`, spacing/
underscore/dash variants, or the file is simply absent (exported "Without media", or
media failed to include). iOS wraps the name in `<…>`, Android appends ` (file attached)`.

**Why it happens:** WhatsApp renames on collision, and the txt↔folder link is implicit.

**Consequences:** Media rendered as broken/empty even when the file exists; or the
wrong file shown for a message.

**Warning signs:** Output references `IMG-…WA0002.jpg` but file is `IMG-…WA0002 (1).jpg`;
high rate of unresolved media tokens; "media omitted" lines where the user expected a file.

**Prevention:**
- Resolve by **basename, case-insensitive**, with normalization that collapses
  spaces/underscores/dashes and strips `(1)`-style suffixes (mirror `whatsapp-export-md`'s
  resolver).
- Tolerate both iOS `<name>` and Android `name (file attached)` wrappers.
- Emit a clear **unresolved-media report** (count + list) so missing files are visible,
  not silently dropped.
- Distinguish *intentional* omission (`<Media omitted>` placeholder with no file in ZIP)
  from *missing-but-expected* (reference present, file absent).

**Suggested phase:** Media reconciliation.

---

### Pitfall C5: HTML injection / XSS from chat content

**What goes wrong:** Rendering user-controlled chat content into the HTML output with
raw interpolation lets an attacker execute JavaScript in the viewer's browser. The
attack surface is **every** field: message body, **sender name** (e.g. a contact saved
as `<img src=x onerror=...>`), media **filename** used in `alt`/`src`/`href`, and link
URLs (including `javascript:` URIs).

**Why it happens:** Documented repeatedly in CVEs: open-webui (GHSA-9f4f-jv96,
GHSA-pwxh-7358, GHSA-hcwp-82g6), Orbis chat-widget stored XSS via `sender_name`, and
Discourse CVE-2024-52794 via malicious **image filename**. The pattern is always the
same: one field escaped, another forgotten.

**Consequences:** Stored XSS — opening the backup HTML runs attacker script: cookie/
token theft, account takeover on any future web viewer, or (if a `javascript:` link is
clicked) navigation hijack. Because the output is a file a person opens years later, the
payload persists indefinitely.

**Warning signs:** Any code path that builds an HTML string via template literal +
`innerHTML`/`{@html}` with a chat field not passed through an escaper; media `src`/`href`
built from the raw filename; links linkified from message text without URL scheme checks.

**Prevention:**
- Escape **all** user-controlled fields at render time (sender, body, media filename,
  `alt`, `title`). Never partially escape.
- Prefer DOM `textContent`/`setAttribute` over `innerHTML`; if HTML output is generated
  as a string, run the whole message fragment through a sanitizer (DOMPurify) or a strict
  escape function.
- For linkified URLs, allowlist schemes (`http`/`https`/`mailto`); reject `javascript:`,
  `data:`, etc.
- For the Markdown output, also escape — Markdown can embed raw HTML, so escaping or a
  sanitizing renderer is required (don't assume `.md` is safe).

**Suggested phase:** Rendering (HTML/MD) — treat as a security gate, not a nice-to-have.

---

### Pitfall C6: Path traversal / unsafe media filename write

**What goes wrong:** When the tool *writes* media files (or inlines/renames them) using a
name derived from the export's media filename, a crafted name like
`../../.ssh/authorized_keys` escapes the media directory. Real CVE: nanobot
GHSA-3f63-vcp3-hvqr — `path.join(mediaDir, prefix + fileName)` resolves `..` and writes
attacker-controlled bytes anywhere.

**Why it happens:** `path.join` normalizes `..`; concatenating a raw filename (even with a
prefix) before the join lets the traversal consume the prefix.

**Consequences:** Arbitrary file write/overwrite on the user's machine at the tool's
permission level.

**Warning signs:** Anywhere a media filename from the export is used to *construct a write
path*; use of `path.join(dir, userFileName)` without basename extraction.

**Prevention:**
- Reduce every media filename to a **safe basename** (`path.basename`, also strip `\`),
  then allowlist characters (`[a-zA-Z0-9._-]`), falling back to a generated name.
- After joining, **assert** the resolved path stays inside the media dir:
  `path.resolve(out).startsWith(path.resolve(mediaDir) + sep)` else throw.
- Never trust the document's original filename for the on-disk path.

**Suggested phase:** Media reconciliation (write/path-handling step).

---

## Moderate Pitfalls

### Pitfall M1: Sender names containing a colon

**What goes wrong:** A contact saved as `Dr. A. Smith: Legal` shifts the `Name: body`
split point; naive "first colon" splitting puts part of the name into the body (worse on
unbracketed Android lines).

**Prevention:** Anchor the split on the header's *sender delimiter* (`] ` or ` - `), not
the first `:`. After the delimiter, the first `: ` separates sender from body; everything
before the delimiter is metadata.

**Warning signs:** Bodies that start with what looks like a name fragment; sender field
truncated mid-name.

**Suggested phase:** Parser core.

---

### Pitfall M2: `<Media omitted>` vs deleted messages conflated

**What goes wrong:** Two different things look similar but mean different things:
- `<Media omitted>` / `image omitted` / `sticker omitted` / localized (`الوسائط غير
  مضمنة`) → a media message whose file wasn't included (timestamp + sender present,
  content absent).
- `This message was deleted` / `You deleted this message` / localized → a deleted text
  message (timestamp + sender present, content absent).

The project requires **both preserved as visible placeholders** — but they must be
classified differently (media-vs-deleted) so rendering and stats treat them correctly.

**Prevention:** Maintain a locale-aware list of omitted-media markers **and** a separate
list of deleted-message markers; classify each empty-content line accordingly.

**Warning signs:** "Deleted" counter includes media-only entries, or media placeholder
counted as a deleted message.

**Suggested phase:** Parser core + Rendering (placeholder styling).

---

### Pitfall M3: System messages misclassified as chat

**What goes wrong:** Encryption notice (top of every chat), group joins/leaves, subject/
icon changes, security-code changes, ephemeral-message notices, and call logs are
timestamped lines **with no sender**. Treating them as user messages pollutes senders,
counts, and per-person stats. Conversely, an export that is *entirely* system messages
would yield zero real messages.

**Prevention:** Detect system lines (no `Name: ` delimiter, plus known phrase patterns
and localized variants) and tag `messageType: system` / `call`. Surface them as plain
lines per the project's v1 decision (no special styling), but keep them out of sender stats.

**Warning signs:** A "sender" that is actually a sentence; call-duration text appearing
as a message body.

**Suggested phase:** Parser core (classification).

---

### Pitfall M4: Memory blowup on large / media-heavy exports

**What goes wrong:** Loading the whole `_chat.txt` (tens of thousands of lines) or an
entire media folder into memory, or inlining huge videos as base64, exhausts RAM. Also:
iPhone "Export Chat" **silently truncates around ~40,000 messages**, and media-rich
exports can fail to complete.

**Prevention:**
- **Stream** the txt line-by-line (Node `readline` / async iterator); never `readFile`
  + `split('\n')` the whole thing for parsing.
- Honor the project's streaming requirement; cap/limit base64 inlining per file
  (`--embed-max-mb`) and skip inlining videos by default.
- Warn the user if the export looks truncated (sudden end, or known ~40k ceiling) and
  recommend "Without media" for very long chats.

**Warning signs:** RSS grows with file size; crash/OOM on a 100k-line export; output stops
mid-conversation.

**Suggested phase:** Performance / streaming.

---

### Pitfall M5: UTF-8 / BOM / CRLF / RTL corruption

**What goes wrong:** A leading UTF-8 BOM (`0xEF 0xBB 0xBF`) breaks first-line timestamp
matching; iOS injects invisible bidi marks (`U+200E`/`U+200F`) that corrupt regex and
rendering; Windows CRLF vs Unix LF mismatches can merge/split lines in naive readers;
RTL/Arabic content needs correct direction handling in HTML.

**Prevention:** Strip BOM on read; strip bidi marks before parsing (re-apply direction
via `dir="auto"` at render, not by leaving control chars in data); normalize line endings
before splitting; set `dir="auto"` on message containers.

**Warning signs:** First message missing/garbled; stray invisible chars; RTL text renders
left-to-right incorrectly.

**Suggested phase:** Parser core (input hygiene) + Rendering (RTL).

---

## Minor Pitfalls

### Pitfall N1: Sticker / GIF files not referenced in txt

**What goes wrong:** Stickers and GIFs produce a placeholder in txt but the actual file in
the media folder often lacks a reliable 1:1 reference, so auto-linking them is
unreliable.

**Prevention:** Per `PROJECT.md` this is **out of scope for v1**. Explicitly document it
as unsupported so users don't expect sticker rendering; revisit only with a dedicated
mapping heuristic later.

**Suggested phase:** Explicitly deferred (v2).

---

### Pitfall N2: Ambiguous all-≤12 dates

**What goes wrong:** When every day in the file is ≤ 12, day-first vs month-first is
undeterminable from the data alone.

**Prevention:** Fall back to the whole-file heuristic (C1) and expose an explicit
`--day-first`/`--month-first` override; log which assumption was used.

**Suggested phase:** Parser core.

---

### Pitfall N3: Edited-message markers kept in body

**What goes wrong:** Some WhatsApp versions leave an "edited" marker inside the body;
naive parsers keep it as text.

**Prevention:** Recognize and optionally strip the edited marker; if kept, tag it rather
than leaving it as ordinary body text.

**Suggested phase:** Parser core.

---

### Pitfall N4: Phone-number / unsaved senders

**What goes wrong:** Messages from unsaved contacts show the international number
(`+44…`), with format variations; "You" vs the other party differ between 1:1 and group.

**Prevention:** Accept sender = name **or** `+number`; don't assume alphabetical names.
For 1:1, map "You" consistently; for groups, keep every distinct sender.

**Suggested phase:** Parser core.

---

## Phase-Specific Warnings (roadmap mapping)

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Parser core / normalization | C1, C2, C3, M1, M2, M3, M5, N2, N3, N4 | Build a stateful, format-auto-detecting, whole-file-heuristic reader; unit-test with US/DE/TR/AR sample lines. |
| Media reconciliation | C4, C6 | Case-insensitive basename resolver + `(1)` normalization; safe-write with basename + post-join boundary assertion; unresolved-media report. |
| Rendering (HTML/MD/JSON) | C5, M2, M5 | Escape **all** fields; sanitize HTML; allowlist URL schemes; `dir="auto"`; distinct placeholder styling for omitted-media vs deleted. |
| Performance / streaming | M4 | `readline`/async-iterator parser; cap base64 inlining; truncation warning. |
| i18n / locale hardening (stretch) | C1, M5 | Non-Western digits, localized AM/PM, RTL; treat as a hardening pass after the core works. |

---

## Sources

- `whatsapp-export-parser` (NeverFar-app) — format reference, known failure modes,
  non-Western digits, bidi/BOM stripping, system-message handling. (GitHub, MEDIUM/HIGH)
- `whatsapp-chat-to-pdf` / `whatsapp-export-viewer` — 14 timestamp formats, macOS
  `._chat.txt` trap, iPhone ~40k truncation, multi-line stitching. (GitHub/blogs, MEDIUM)
- WaChat to PDF / ThreadRecap blogs — locale date variations, `<Media omitted>` and
  deleted-message phrasing, BOM/CRLF, no-timezone caveat, media filename conventions. (Vendor blogs, MEDIUM)
- `whatsapp-export-md` (mshammas) — smart filename resolution, base64 embed cap,
  relative-path media. (GitHub, MEDIUM)
- whatstk docs — header format codes per device/OS/language. (Docs, MEDIUM)
- CVE advisories: open-webui GHSA-9f4f-jv96 / GHSA-pwxh-7358 / GHSA-hcwp-82g6;
  Orbis chat-widget stored XSS via `sender_name`; Discourse CVE-2024-52794 (image
  filename); nanobot GHSA-3f63-vcp3-hvqr (WhatsApp doc filename path traversal). (HIGH)
