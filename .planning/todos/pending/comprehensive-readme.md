---
title: Comprehensive README
date: 2026-08-23
priority: high
---

# Comprehensive README

A single thorough README that makes the tool usable for any terminal developer.

## Must cover
- **Install**: `npm i -g wa-backup` and `npx wa-backup <chat.zip>`; Node engine requirement.
- **Quick start**: one real example turning a WhatsApp "Export chat" ZIP into Markdown + HTML + JSON.
- **All CLI flags**: `<zip>`, `--out`, `--inline-media`, `--no-fetch-titles`, `--verbose`, locale overrides (`--day-first`/`--month-first`), `--help`.
- **Output explanation**: the three synchronized outputs, the `messages.csv` source-of-truth, media folder, favicons/URL titles.
- **Worked examples**: pt-BR sample, inline self-contained HTML, omitting network title fetch.
- **FAQ**: "where do I get the ZIP?", "why is media missing?", "is my data sent anywhere?" (no — local only).
- **Troubleshooting**: encoding, large chats, unresolved media.

## Notes
- Keep it accurate against the actual flags in `src/index.ts`; do not document flags that don't exist.
- No README exists today.
