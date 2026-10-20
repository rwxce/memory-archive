# Requirements: WhatsApp Chat Backup

**Defined:** 2026-08-21
**Core Value:** A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.

## v1 Requirements

Requirements for the initial CLI release. Each maps to a roadmap phase.

### Parsing

- [x] **PARSE-01**: CLI accepts a path to a WhatsApp "Export chat" ZIP as its input argument
- [x] **PARSE-02**: CLI extracts `_chat.txt` and media from the ZIP using streaming extraction (no full-archive buffering in memory)
- [x] **PARSE-03**: Parser detects the timestamp format per-file (day/month order, 12h/24h, `- / .` separators, optional brackets) and parses dates locale-tolerantly
- [x] **PARSE-04**: Parser handles multi-line message continuation (lines without a timestamp header append to the preceding message)
- [x] **PARSE-05**: Parser preserves UTF-8 content including emoji, non-Latin scripts, and handles BOM / encoding variants
- [x] **PARSE-06**: Parser distinguishes genuine message lines from non-message lines (avoids false-positive timestamp detection, e.g. macOS `._chat.txt` AppleDouble files)
- [x] **PARSE-07**: Parser builds a normalized message model (sender, timestamp, body, media reference, message type)

### Output

- [ ] **OUT-01**: CLI emits a structured JSON file of the parsed chat (messages + media references)
- [ ] **OUT-02**: CLI emits a Markdown file (chronological, sender-labeled, media linked by relative path)
- [ ] **OUT-03**: CLI emits a WhatsApp-like HTML file (message bubbles, deterministic per-sender color, timestamps, per-day dividers)
- [ ] **OUT-04**: All three outputs (JSON + Markdown + HTML) are produced in a single run
- [ ] **OUT-05**: HTML rendering escapes all chat content (sender, body, URLs, filenames) to prevent XSS injection

### Media

- [ ] **MEDIA-01**: CLI reconciles media filename references in `_chat.txt` to actual files in media folders (case-insensitive, ignoring `(1)`, dash/space variance)
- [ ] **MEDIA-02**: Resolved media files are copied into the output folder and referenced by relative path by default
- [ ] **MEDIA-03**: A `--inline` flag embeds resolved media as base64 into a single self-contained HTML file (with a per-file size cap)
- [ ] **MEDIA-04**: `<Media omitted>` and deleted-message lines are preserved as visible placeholders in all outputs

### CLI

- [ ] **CLI-01**: Output defaults to a folder named after the chat inside the current/output directory
- [ ] **CLI-02**: A `--out` flag overrides the output path
- [ ] **CLI-03**: Generated output is portable and opens via `file://` with no server or backend required

## v2 Requirements

Deferred to a future release (web version and later differentiators). Tracked but not in the current roadmap.

### Web Delivery

- **WEB-01**: Web page where any user uploads a WhatsApp export ZIP and receives processed data
- **WEB-02**: Backend reuses the isolated parsing core (port swap, no rewrite)
- **WEB-03**: Scales to large file uploads

### Later Differentiators

- **DIFF-01**: Search / filter by date range, sender, or keyword
- **DIFF-02**: Contact / participant aggregation (volume, first/last seen)
- **DIFF-03**: Batch processing of multiple zips in one run
- **DIFF-04**: Additional export formats (PDF, CSV, TXT)
- **DIFF-05**: Output encryption (passphrase / AES)

## Out of Scope

Explicitly excluded from v1 (and, where noted, from the product). Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Web UI in v1 | Separate delivery channel; web is v2 (reuses core) |
| System-event styling | v1 renders joined/left/encryption lines as plain lines (lean) |
| Sticker / GIF mapping | `_chat.txt` has no reference to them; unrecoverable from txt |
| Contact-list / participant aggregation | Lean v1; analytics is a later differentiator |
| Batch multiple zips in one run | Simpler one-chat-per-run; web covers scale |
| Output encryption | Out of core-value scope; adds key management |
| Parsing Google-Drive encrypted backup / Crypt DB | Different, far larger problem; out of scope entirely |
| Reactions / reply-context / read-receipts reconstruction | Not present in the export file at all; impossible |
| Loading entire transcript into memory | Fails on large chats; streaming is a hard constraint |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PARSE-01 | Phase 1 | Complete |
| PARSE-02 | Phase 1 | Complete |
| PARSE-03 | Phase 1 | Complete |
| PARSE-04 | Phase 1 | Complete |
| PARSE-05 | Phase 1 | Complete |
| PARSE-06 | Phase 1 | Complete |
| PARSE-07 | Phase 1 | Complete |
| OUT-01 | Phase 2 | Pending |
| OUT-02 | Phase 2 | Pending |
| OUT-03 | Phase 2 | Pending |
| OUT-04 | Phase 2 | Pending |
| OUT-05 | Phase 2 | Pending |
| MEDIA-01 | Phase 3 | Pending |
| MEDIA-02 | Phase 3 | Pending |
| MEDIA-03 | Phase 3 | Pending |
| MEDIA-04 | Phase 3 | Pending |
| CLI-01 | — | Implemented (no phase) |
| CLI-02 | — | Implemented (no phase) |
| CLI-03 | — | Implemented (no phase) |

**Coverage:**

- v1 requirements: 19 total
- Mapped to phases: 16
- Unmapped: 3 (CLI-01, CLI-02, CLI-03 — implemented, no owning phase)

---
*Requirements defined: 2026-08-21*
*Last updated: 2026-08-21 after initial definition*
