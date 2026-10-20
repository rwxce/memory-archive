---
title: Non-technical drag-drop web frontend
planted_date: 2026-08-23
trigger_condition: When the project broadens its audience beyond terminal developers, or when a non-technical user (family/friends) needs to produce a backup without running a CLI.
---

# Non-technical drag-drop web frontend

## Idea
A browser-based UI where a non-technical user uploads the WhatsApp "Export chat" ZIP and
receives the backup (Markdown/HTML/JSON + media) built **client-side**, with nothing to
install. The existing core (`src/`) is already designed to be reusable in the browser
(fflate, eta, date-fns are all browser-compatible), so this reuses the parsing/rendering
core behind a file-picker + progress UI.

## Why deferred
Exploration on 2026-08-23 scoped v1 distribution to **terminal developers only** via npm.
The non-technical path was explicitly moved to a future feature.

## Open questions for when triggered
- Deploy target: GitHub Pages (static, client-side only) vs a small backend.
- How to surface media/favicon fetching that today uses `fetch` (CORS considerations).
- Whether to keep the CLI and web frontend in the same repo or split.
