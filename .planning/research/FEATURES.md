# Feature Landscape: WhatsApp Chat-Export Parser / Backup Tool

**Domain:** CLI tool that turns a WhatsApp "Export chat" ZIP (`_chat.txt` + media folders) into Markdown + HTML + JSON with media
**Researched:** 2026-08-21
**Research mode:** Ecosystem (features dimension)
**Overall confidence:** MEDIUM (format/structure facts corroborated across many independent tools; some provider tiers LOW — treat tool-specific claims as indicative, not authoritative)

---

## Executive Summary

The WhatsApp chat-export ecosystem is mature and crowded, but it fragments along two axes: **what input it reads** and **what output it produces**.

- **Input axis:** The most capable tools (e.g. `WhatsApp-Chat-Exporter`, Python) parse the *local database* and even *decrypt* Google-Drive-style backups (Crypt12/14/15). That is a completely different and far larger problem than this project's scope. Our project deliberately targets only the **email/export ZIP** (`_chat.txt` + media), which is plain UTF-8 text plus sibling media files. This is the right, lean boundary.
- **Output axis:** There are txt→object parsers (`whatsapp-chat-parser`, npm, ~219★, TypeScript), txt→document converters (`whatsapp-export-md`, Python 2025; `whatsapp-chat-to-pdf`), database tools, analytics tools (`WhatsR`, `whatsapp-chat-analyzer`), and online converters (ChatToPDF, WAExport, ThreadRecap) that emit PDF/Excel/CSV. **No single popular tool cleanly does all three of Markdown + WhatsApp-like HTML + structured JSON in one local, portable, no-server pass** — that combination is our wedge.

The single hardest, non-negotiable feature is **locale-tolerant timestamp parsing**. The `_chat.txt` date format changes by device, OS region, and language (e.g. `14/06/2026, 21:07` in the EU vs `6/14/26, 9:07 PM` in the US; separators `- / .`; optional brackets). A parser that assumes one format breaks on others. The second universal gotcha is **multi-line message continuation** (only the first line carries a timestamp). Solve these two and you solve ~95% of real-world parsing bugs (corroborated by whatsquiz format guide and StackOverflow war-stories).

Media handling is the third differentiator battleground: reconciling `<attached: FILENAME>` / `<Media omitted>` references to actual files in sibling folders, with smart filename resolution (case-insensitive, ignoring `(1)`, dash/space variance) and correct MIME mapping (`.opus`, `.m4a`, `.pdf`). Most naive parsers get this wrong.

---

## Table Stakes

Features users expect from any credible WhatsApp export tool. Missing any of these = product feels broken/incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Locale-tolerant date/time parsing** | Format varies by device/region/language; single-format parsers silently mis-date or drop messages | **HIGH** | Central hard problem. Infer day/month order; support 24h and 12h-AM/PM; handle `- / .` separators and optional `[ ]`. `whatsapp-chat-to-pdf` cites 14 timestamp formats. |
| **Multi-line message continuation** | WhatsApp writes only the first line with a timestamp; the rest are naked continuation lines | **MED** | Line-by-line: a line lacking a timestamp header appends to the previous message. |
| **Three outputs in one pass: Markdown + HTML + JSON** | Users want editing (MD), viewing (HTML), and structured reuse (JSON) | **MED** | `whatsapp-export-md` does MD+HTML+JSON; we match that and add WhatsApp-like HTML. Few tools do all three cleanly. |
| **Media reconciliation (filename → file in sibling folder)** | txt references `IMG-…jpg` / `<Media omitted>`; files live in media folders. Without reconciliation, output is broken | **MED–HIGH** | Map `<attached: FILENAME>` and bare names to files; relative-path reference by default. Smart resolution recommended (see Differentiators). |
| **WhatsApp-like HTML rendering (bubbles, per-sender color, timestamps)** | "Fully viewable backup" goal requires familiar visual fidelity | **MED** | `WhatsApp-Chat-Exporter` and `whatsapp-export-md` both render bubbles/day-grouping. We must match the look. |
| **Preserve `<Media omitted>` & deleted messages as visible placeholders** | Users want the full record, including gaps (privacy/legal/continuity) | **LOW** | Render as a placeholder bubble/line. Localized strings (`Média absent`, `Medien ausgeschlossen`) — match structurally, not by English string. |
| **System-event lines handled (rendered as plain lines in v1)** | Exports contain `X added Y`, renames, and the E2E notice (line 2) | **LOW** | v1: plain lines. Filter the E2E encryption notice (always 2nd line). |
| **Streaming / line-by-line parse (memory-safe on large chats)** | Long histories + videos can be huge; loading all into memory fails | **MED–HIGH** | Project constraint. Core must stream; do not buffer entire transcript. |
| **UTF-8 / encoding robustness** | Exports are UTF-8 but may arrive as UTF-16/Latin-1; emoji/multilingual text | **LOW–MED** | Detect BOM/encoding; preserve emoji and non-Latin scripts. |
| **Output to chat-named folder; `--out` override** | Users expect a self-contained folder; sometimes want a custom path | **LOW** | Default = chat name; flag overrides. |
| **Portable, no-server standalone output** | "Open years later without WhatsApp/phone/account" is the core value | **LOW** | HTML must open via `file://` with no backend. Media referenced relatively. |

---

## Differentiators

Features that set the product apart. Not strictly required, but they are the competitive wedge and align with project intent.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Optional base64 inline → single self-contained HTML** | One file opens anywhere, no folder to keep in sync; ideal for archiving/sharing | **LOW–MED** | `whatsapp-export-md` has `--embed --embed-max-mb`. Cap per-file size (e.g. 8 MB) to avoid bloat. Strong differentiator for "open anywhere". |
| **WhatsApp-like HTML fidelity (bubbles + per-sender color + day dividers)** | Familiar, faithful reconstruction is the emotional core of a "backup you can read" | **MED** | Per-sender color must be stable/deterministic across reloads. |
| **Smart media filename resolution** | Exports get renamed (`file (1).jpg`, case/space/dash variance); naive matching drops media | **MED** | Case-insensitive; ignore `(1)`, spacing, `_`/`-` differences; correct MIME for `.opus`/`.m4a`/`.pdf`. Differentiates from naive parsers. |
| **Clean, isolated parsing core reusable by future web version** | Web v2 imports the same core; protects build investment | **MED** (architectural) | Not a user-facing feature, but a product-line differentiator. Enforce separation now. |
| **Per-day grouping in HTML & Markdown** | Mirrors WhatsApp's date separators; improves readability | **LOW** | `whatsapp-export-md` does it; expected by users who've seen WhatsApp UI. |
| **Linkify URLs in messages** | Plain `http(s)://` become clickable | **LOW** | Common in converters; cheap win. |
| **Privacy-local, no upload, no telemetry** | Many users choose tools specifically to avoid cloud handling of private chats | **LOW** | `whatsapp-export-md` and `WhatsApp-Chat-Exporter` both emphasize "runs locally". State it proudly. |

### Differentiators viable in later versions (not v1, but worth roadmapping)

| Feature | Why valuable later | Complexity |
|---------|-------------------|------------|
| **Search / filter (date range, sender, keyword)** | `WhatsApp-Chat-Exporter` filters by date/phone/include-exclude; high user demand for "find that one message" | MED |
| **Contact / participant aggregation** | Who messaged most, first/last seen, volume — analytics tools do this; natural for a backup browser | MED |
| **Batch processing of multiple zips** | Scale to "all my chats"; project explicitly defers to web v2 | MED–HIGH |
| **Additional export formats (PDF, CSV, TXT, Excel)** | `whatsapp-chat-to-pdf`, ChatToPDF, WAExport show strong demand for PDF/CSV | MED |
| **Output encryption (AES zip / passphrase)** | Rare in tools; strong privacy differentiator for sensitive archives | MED |

---

## Anti-Features

Features to deliberately NOT build (per project scope + lean v1). Building these would dilute the core value or explode scope.

| Anti-Feature | Why Avoid | What To Do Instead |
|--------------|-----------|-------------------|
| **Cloud upload / web UI in v1** | Separate delivery channel; out of v1 scope (web is v2) | Build CLI now; keep core importable for web later |
| **Parsing the Google-Drive encrypted backup / Crypt databases** | Different, far larger problem (DB schema + Crypt12/14/15 decryption); `WhatsApp-Chat-Exporter` owns this niche | Stay on the email/export ZIP only |
| **Sticker / GIF mapping from media folders** | `_chat.txt` has no reference to stickers/GIFs; unrecoverable from txt | Defer; document as known gap |
| **Contact-list / participant aggregation in v1** | Lean v1; analytics is a later differentiator | Ship core backup; add aggregation in v2 |
| **Batch multiple zips in one run (v1)** | Simpler to be one-chat-per-run; web covers scale | One chat per CLI invocation |
| **Output encryption in v1** | Out of core value scope; adds key-management burden | Defer to a later privacy differentiator |
| **NLP / sentiment / emoji analytics in v1** | Goal is backup/viewing, not analysis; many tools already do analytics | Leave structured JSON for downstream analysis |
| **Reconstructing reactions / reply-context / read receipts** | These are NOT in the export file at all — impossible from txt | Don't promise; document the limitation |
| **Assuming a single locale** | The #1 real-world parsing bug; breaks on non-default regions | Always parse locale-tolerantly |
| **Loading entire transcript into memory** | Fails on large chats (project constraint) | Always stream-parse |

---

## Feature Dependencies

```
Locale-tolerant date/time parsing  ──┐
Multi-line continuation handling   ──┤
UTF-8 / encoding robustness        ──┴──► Normalized message model
                                            │
                                            ├──► Markdown output
                                            ├──► JSON output
                                            └──► HTML output (needs per-sender color + day grouping)
                                                     │
Media reconciliation ───────────────────────────────┤ (HTML/MD reference media; JSON records refs)
Smart media filename resolution ─────────────────────┘
Optional base64 inline ──────────────────────────────► single self-contained HTML (depends on Media reconciliation)
Streaming parse ─────────────────────────────────────► enables all outputs on large chats (cross-cutting)
```

**Key dependencies:**
- Everything depends on the **normalized message model**, which depends on the three parsers (date, multi-line, encoding).
- **WhatsApp-like HTML**, **Markdown**, and **JSON** all consume the same model — build the model once, render three ways.
- **Base64 inline** depends on **media reconciliation** (you must have resolved the file before you can inline it).
- **Per-sender color / day grouping** are HTML/MD presentation concerns layered on the model.

---

## MVP Recommendation (v1)

Prioritize (all table stakes, in dependency order):
1. **Locale-tolerant date/time parsing** (foundation — nothing works without it)
2. **Multi-line continuation + UTF-8 robustness** (completes the normalized model)
3. **Streaming parse** (memory-safe on large chats)
4. **JSON output** (cheapest render; validates the model)
5. **Markdown output**
6. **WhatsApp-like HTML** (bubbles, per-sender color, timestamps, day grouping)
7. **Media reconciliation** (folder-referenced by default) + **preserve `<Media omitted>`/deleted as placeholders**
8. **Optional base64 inline single HTML** (differentiator, low cost once media is resolved)

Defer (differentiators for later versions): search/filter, participant aggregation, batch, PDF/CSV, output encryption, web UI.

---

## Sources

- WhatsApp-Chat-Exporter (Python, DB + decryption, HTML/JSON/text, filtering, templates) — github.com/KnugiHK/WhatsApp-Chat-Exporter, wts.knugi.dev
- whatsapp-chat-parser (npm, TypeScript, parse _chat.txt → objects, daysFirst inference, parseAttachments) — github.com/Pustur/whatsapp-chat-parser, npmjs.com/package/whatsapp-chat-parser (v4.0.2)
- whatsapp-export-md (Python 2025, MD/HTML + media link/embed base64, smart filename resolution, JSON dump) — pypi.org/project/whatsapp-export-md
- whatsapp-chat-to-pdf (Python 2026, 14 timestamp formats, PDF/XLSX/CSV) — pypi.org/project/whatsapp-chat-to-pdf
- WhatsR (R, parsing/anonymizing/visualizing), whatsapp-chat-analyzer (Python, auto format detection) — CRAN / PyPI
- Online converters: ChatToPDF (chattopdf.app), WAExport (waexport.wadesk.io), ThreadRecap — PDF/Excel/CSV from TXT/ZIP
- Format structure reference: whatsquiz.com/blog/whatsapp-chat-export-file-format; StackOverflow WhatsApp chat-log regex thread

**Confidence note:** Format/structure facts are corroborated across ≥5 independent tools and a dedicated format guide → treat as reliable. Tool-specific feature lists come from web search (provider tier LOW) → indicative, verify against current docs when implementing. Docs source (whatsapp-chat-parser API) classified MEDIUM.
