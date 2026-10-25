---
name: highlights-research
description: Research a chat for key moments, patterns, messages of interest and candidate profile phrases, either in this session (only when the user explicitly asks) or with an external LLM CLI, producing a findings.json keyed by message fingerprint for the app's Highlights section. Use when the user wants to find highlights, important moments, patterns or messages worth keeping in a conversation, or asks how to prepare or validate a findings file for import into the app.
---
# Highlights research (dev workflow)

Goal: turn a WhatsApp export into a `findings.json` the app can import later. The file holds
fingerprints plus the user's summaries, never the chat itself. Full reference:
`docs/research-workflow.md`; format and validator: `lib/domain/highlights.ts`
(`parseFindings`); commands: `cli/research.ts`.

## Hard rules

- **You read the chat only on an explicit request.** `research/*.jsonl` and `*.meta.json` are
  chat content. Read them only when the user asked for highlights research in this session
  (the project privacy rule's one exception; every read asks). Never read the ZIP,
  `_chat.txt`, `data/` or `output/`. Never copy chat text anywhere but `research/findings.json`:
  not into commits, PRs, docs, tests, memory or chat replies beyond a short title per finding.
- Tell the user, before step 1, that whoever analyses the chat (you, or their external LLM) sends
  its text to the model provider and it leaves their device. Proceed only once they have
  acknowledged it.
- Tests, demos and examples use synthetic fixtures only (`scripts/generate-fixtures.mjs`).
- Never commit research files. Delete `research/` once the user has imported the findings.
- Fingerprints are copied verbatim, never invented or edited.

## Steps

1. **Export** (local, offline): `pnpm cli export-for-research "<chat>.zip"` →
   `research/<chat>.jsonl` + `<chat>.meta.json`. The user gives the ZIP path; never open the ZIP
   yourself. Report only the printed counts/paths.
2. **Analyse**, one of:
   - **In this session** (the user asked you to): read the JSONL in chunks (it can be long) and
     write `research/findings.json` per the contract below. Ask the user first what to focus on
     (a period, a theme, the summaries' language) if they have not said.
   - **External LLM CLI**: hand over the sample prompt from `docs/research-workflow.md`, run in
     a folder outside the repo.

   Contract either way: version 1, `conversation` copied from `<chat>.meta.json`, categories
   `moment` | `pattern` | `interest`, 1-200 fingerprints per highlight copied verbatim, stable
   unique ids. Also propose up to 3 **candidate phrases** for the person's profile: each an
   `interest` highlight titled `Frase candidata: …` (in the chat's language) with exactly one
   message, a short and characteristic message the person wrote. The user can then set it as the
   person's phrase from that message in the app.
3. **Validate**: `pnpm cli check-findings research/findings.json`. It prints
   `path: message` lines and no chat content, so you may read its output. Fix by telling the
   user which paths to correct or re-run the LLM on those (or fix them yourself if you wrote it).
4. **Import** into the app (user, in the PWA): open the person, then the **Destacats /
   Highlights** card on their page, then the import card, and pick `findings.json`. The file is read locally; an invalid file lists only JSON
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
