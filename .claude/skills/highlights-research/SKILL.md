---
name: highlights-research
description: >-
  Guide the user through researching a chat for key moments, patterns and
  messages of interest with an external LLM CLI (Claude Code, Codex CLI),
  producing a findings.json keyed by message fingerprint. Use when the user
  wants to find highlights, important moments, patterns or messages worth
  keeping in a conversation, or asks how to prepare or validate a findings file
  for import into the app.
---
# Highlights research (dev workflow)

Goal: turn a WhatsApp export into a `findings.json` the app can import later. The file holds
fingerprints plus the user's summaries, never the chat itself. Full reference:
`docs/research-workflow.md`; format and validator: `lib/domain/highlights.ts`
(`parseFindings`); commands: `cli/research.ts`.

## Hard rules

- **You never read the chat.** Real exports, `output/research/*.jsonl` and `*.meta.json`
  are chat content: do not open, cat, grep or paste them (project privacy rule; `output/` is
  read-denied). The LLM that analyses the chat is a separate session the user starts
  themselves, outside this repo.
- Tell the user, before step 1, that the analysing LLM sees their chat text and it leaves
  their device. Proceed only once they have acknowledged it.
- Tests, demos and examples use synthetic fixtures only (`scripts/generate-fixtures.mjs`).
- Never commit research files; remind the user to delete `output/research/` when done.
- Fingerprints are copied verbatim, never invented or edited.

## Steps

1. **Export** (local, offline): `pnpm cli export-for-research "<chat>.zip"` →
   `output/research/<chat>.jsonl` + `<chat>.meta.json`. Running it is fine; just do not read
   what it wrote. Report only the printed counts/paths.
2. **Analyse** (user, external LLM CLI): hand over the sample prompt from
   `docs/research-workflow.md`. Offer to tailor the prompt (focus on a period, a person, a
   theme; language of the summaries) but keep the output contract: version 1, categories
   `moment` | `pattern` | `interest`, 1-200 fingerprints per highlight, stable unique ids.
3. **Validate**: `pnpm cli check-findings output/research/findings.json`. It prints
   `path: message` lines and no chat content, so you may read its output. Fix by telling the
   user which paths to correct or re-run the LLM on those; do not open the file to edit it.
4. **Import** into the app (user, in the PWA): open the person, then Highlights, then the import
   card, and pick `findings.json`. The file is read locally; an invalid file lists only JSON
   paths and fixed messages. The target conversation is preselected when it is named like the
   file, otherwise the user chooses. The result shows added, updated, unchanged and skipped
   counts plus warnings (message count differs, first message not found). Skipped
   fingerprints are ones not in the archive (the chat was not imported, or is a different
   export). Re-importing the same file is safe: highlights are matched by `id`, so an edited
   file updates them and an unchanged one changes nothing. A highlight the user deleted comes
   back on re-import. Highlights travel in full backups and restores.
   - To update a finding, keep its `id` and change the text; to remove one for good, delete it
     in the app and drop it from the file before importing again.
   - Opening a highlight lands on the day of its first message, not the exact message.

## Good highlights (advice for the prompt)

- `moment`: a dated event or turning point; `pattern`: something recurring (rituals, topics,
  tone shifts); `interest`: a single message worth keeping.
- Few, meaningful and well-anchored beats many shallow ones. Titles short, summaries in the
  user's own voice and the chat's language, no long quotes.
- Stable ids (`moment-first-trip`) so re-importing an updated file does not duplicate.
