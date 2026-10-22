# Phase 1: Parsing & Model Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-21
**Phase:** 1-Parsing & Model Core
**Areas discussed:** Locale & timestamp detection, CSV as source of truth

---

## Locale & Timestamp Detection

| Option | Description | Selected |
|--------|-------------|----------|
| Best-effort + override | Trust heuristic, --day-first/--month-first override, pick majority-consistent order | ✓ |
| Fail loudly | Abort on ambiguous date with flag instruction | |
| Override mandatory | Always require explicit hint | |

**User's choice:** Best-effort + override
**Notes:** Day/month ambiguity resolved by majority of dates in file.

| Option | Description | Selected |
|--------|-------------|----------|
| Detect per-file | 12h if any AM/PM token, else 24h | ✓ |
| Detect per-line | Independent per line | |
| Require flag | Mandatory --12h/--24h | |

**User's choice:** Detect per-file

| Option | Description | Selected |
|--------|-------------|----------|
| Both, auto-detect | iOS bracketed + Android unbracketed, per-line, any separator, optional seconds | ✓ |
| Single variant | One detected variant, reject others | |
| Android only v1 | Unbracketed only | |

**User's choice:** Both, auto-detect

| Option | Description | Selected |
|--------|-------------|----------|
| Treat as continuation | Failed-to-parse stamp → append to previous message | ✓ |
| New msg, null ts | Start new message with empty timestamp | |
| Drop the line | Discard entirely | |

**User's choice:** Treat as continuation

| Option | Description | Selected |
|--------|-------------|----------|
| Sliding window | yy <= currentYear-2000+1 → 2000+yy else 1900+yy | ✓ |
| Always 20xx | Always expand to 20yy | |
| Require flag | --century to disambiguate | |

**User's choice:** Sliding window

| Option | Description | Selected |
|--------|-------------|----------|
| Local, no TZ | Store literal wall-clock, no timezone | ✓ |
| Normalize to UTC | Convert using machine TZ | |
| Optional --tz | Default local, flag to convert | |

**User's choice:** Local, no TZ

| Option | Description | Selected |
|--------|-------------|----------|
| Verbose report | --verbose logs detected format/locale/overrides | ✓ |
| Always summarize | Stderr summary every run | |
| Silent | No reporting | |

**User's choice:** Verbose report

| Option | Description | Selected |
|--------|-------------|----------|
| Sanity-window guard | Out-of-range date → continuation + verbose warn | ✓ |
| Accept anything | Never second-guess | |
| Flag, keep body | Reject as new but keep body for review | |

**User's choice:** Sanity-window guard

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-detect sep | Try ' - ' then space then 'Name:' | ✓ |
| Require ' - ' | iOS style only | |
| Require space | Android style only | |

**User's choice:** Auto-detect sep

| Option | Description | Selected |
|--------|-------------|----------|
| Scan to 1st ts | First timestamped line locks format; earlier = preamble | ✓ |
| Detect from line 1 | Assume first non-empty is a message | |
| Skip N lines | Fixed header skip | |

**User's choice:** Scan to 1st ts

| Option | Description | Selected |
|--------|-------------|----------|
| System event | No 'Name:' → type=system, full line as body | ✓ |
| Absorb as cont. | Fold into previous message | |
| Empty sender | Normal message, empty sender | |

**User's choice:** System event

**Notes:** Real `data/` exports showed `U+200E` prefix before `[` and `<attached: FILENAME>` media lines — captured as D-12 (strip leading zero-width/BOM before detection).

---

## CSV as Source of Truth

| Option | Description | Selected |
|--------|-------------|----------|
| CSV = source of truth | Parse → CSV; JSON/MD/HTML derived from CSV; dedupe + sort on append | ✓ |
| CSV = extra artifact | Model+JSON canonical, CSV optional debug | |
| Both canonical | Dual outputs | |

**User's choice:** CSV is the source. JSON will be generated FROM the CSV. CSV must assure duplicates are NOT added; after append, ordered by timestamp.
**Notes:** This reshapes the pipeline — CSV is the single source of truth.

| Option | Description | Selected |
|--------|-------------|----------|
| timestamp,type,author,text,media | Media in own column | ✓ |
| timestamp,type,author,text | Media embedded in text | |
| + raw line | Add unparsed line column | |

**User's choice:** timestamp,type,author,text,media

| Option | Description | Selected |
|--------|-------------|----------|
| 8 granular types | text,photo,video,sticker,document,system,deleted,omitted | ✓ |
| 5 coarse types | text,media,system,deleted,omitted | |
| 3 minimal types | text,media,system | |

**User's choice:** 8 granular types

| Option | Description | Selected |
|--------|-------------|----------|
| ts+author+text+media | Full-key dedupe, handles same-second collisions | ✓ |
| ts+author+text | Ignores media column | |
| hash id col | Stable id column | |

**User's choice:** ts+author+text+media

| Option | Description | Selected |
|--------|-------------|----------|
| ISO local no-TZ | 2026-07-23T09:47:18 | ✓ |
| ISO w/ space | 2026-07-23 09:47:18 | |
| Unix epoch ms | Numeric canonical | |

**User's choice:** ISO local no-TZ

| Option | Description | Selected |
|--------|-------------|----------|
| UTF-8 no BOM | Clean for browser/JSON pipeline | ✓ |
| UTF-8 + BOM | Excel-friendly | |
| Also .xlsx | Spreadsheet export | |

**User's choice:** UTF-8 no BOM

---

## The agent's Discretion

- In-memory model shape, streaming wiring (fflate `Unzip` → readline), and date library choice left to planner/executor within the locked constraints.

## Deferred Ideas

- Redaction of plaintext secrets found in chats (e.g. passwords) — out of scope for v1.
