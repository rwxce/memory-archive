# WhatsApp Chat Backup

## What This Is

A TypeScript/Node command-line tool that reads the official WhatsApp chat-export ZIP (a `_chat.txt` transcript plus media folders) and produces a self-contained, fully-viewable backup of a single conversation. It emits three synchronized outputs — Markdown, HTML (WhatsApp-like), and structured JSON — with media referenced in a local folder by default and optionally inlined.

## Core Value

A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.

## Motivation

Some chats and groups are no longer active, but their history is still worth keeping — or the
phone needs the storage space back. Exporting and deleting them from the device is easy; the
hard part is that the raw WhatsApp export is awkward to read later and stays tied to having
WhatsApp installed. This tool exists to turn that export into a portable, easily-viewed backup
(Markdown, HTML, JSON) you can open in any browser — freeing the phone without losing the
conversation.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] CLI parses a WhatsApp export ZIP into a normalized message model
- [ ] CLI emits Markdown, HTML, and JSON representations of the chat
- [ ] HTML output renders messages in a WhatsApp-like layout (bubbles, per-sender color, timestamps)
- [ ] Media files are placed in a local folder and referenced by relative path
- [ ] A flag inlines media as base64 into a single HTML file
- [ ] `<Media omitted>` and deleted-message lines are preserved as visible placeholders
- [ ] Parser handles large files without loading the whole transcript into memory
- [ ] Output defaults to a chat-named folder; an optional `--out` path overrides it

### Out of Scope

- Web upload UI — future v2, reuses the parsing core (why: separate delivery channel)
- System-event styling (joined/left/encryption) — v1 renders them as plain lines (why: lean v1)
- Sticker/GIF mapping from media folders — not in v1 (why: txt has no reference; later work)
- Contact-list / participant aggregation — not in v1 (why: lean v1)
- Batch processing of multiple zips in one run — v1 is one chat per run (why: simpler, web covers scale)
- Encryption of the backup output — not in v1 (why: out of core value scope)

## Context

- Input is the **email/export ZIP** from WhatsApp's "Export chat" feature (includes media), not the Google Drive cloud backup (which is encrypted and excluded).
- `_chat.txt` uses a **locale-dependent** date/time format (e.g. `12/31/24, 11:59 PM - Name: message` on EN, different separators/order on other locales). Robust, locale-tolerant parsing is the central hard problem.
- Media files are named in the txt (e.g. `IMG-20240101-WA0001.jpg`) but stored in sibling folders; the parser must reconcile references to files.
- The parsing core is deliberately isolated so the future web version can import it directly.

## Constraints

- **Tech stack**: TypeScript / Node (CLI run via node or npx) — chosen so the core is reusable in the future web frontend.
- **Performance**: Must stream-parse to stay memory-safe on large chats (videos, long histories).
- **Portability**: Output folder must open standalone in any browser with no server.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript/Node for v1 | Reuse same core in future web version | — Pending |
| Three outputs (MD+HTML+JSON) | Covers viewing, editing, and structured reuse | — Pending |
| Media folder-referenced by default | Portable, avoids huge single files | — Pending |
| WhatsApp-like HTML | Familiar, "fully visualizable" goal | — Pending |
| CLI first, web later | CLI solves personal need now; web scales to others | — Pending |

---
*Last updated: 2026-08-21 after initialization*
