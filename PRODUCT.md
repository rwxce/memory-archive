# Memory Archive — product brief

## Mission

Let anyone preserve, organize, explore, export and restore the memories of the people who
matter to them — parents, partners, friends — **completely offline, on their own devices,
forever**.

> Users must always own their memories and be able to recover their entire archive
> independently of the application.

## Users

- **Primary:** a person who wants to keep the WhatsApp history, photos, videos and voice
  messages of someone important (often a relative, sometimes someone who has passed away)
  without depending on a phone, an account or a cloud service.
- **Secondary:** relatives who receive a read-only export and just want to open it.
- Not technical by default: the app must be usable by opening a link and tapping *Install*.

## What it does

- One **profile per person**, each with conversations, photos, videos, voice messages,
  favorites and notes.
- **Incremental imports** of WhatsApp exports, Google Photos downloads / Takeout albums and
  loose files, with duplicate detection and an import history.
- A **timeline**, conversation view, gallery, audio archive and calendar per person.
- **One-file backup and restore**, and manual **device-to-device sync** with ZIP files.
- **Portable read-only viewer** exports that open with a double-click.

## Principles

1. **Local only** — no backend, no accounts, no telemetry, no third-party APIs.
2. **Never lose data** — originals are immutable, imports are transactional and repeatable,
   nothing is silently discarded.
3. **The file is the archive** — the backup ZIP is self-contained and documented, readable
   without this app.
4. **Plug and play** — no configuration, no keys; works on iPhone, Android, Mac, Windows and
   Linux.
5. **Respectful** — the content is personal and often emotional; the UI is calm, clear and
   never gamified. See [`docs/tone.md`](docs/tone.md).

## Brand personality

Quiet, warm, trustworthy. Closer to a family photo album than to a productivity tool.

## Out of scope (for now)

Automatic cloud sync, sharing between users, social features, AI-generated content, and any
integration that needs a developer console or API keys.

Full requirements: [`docs/prd.md`](docs/prd.md). Plan: [`docs/roadmap.md`](docs/roadmap.md).
