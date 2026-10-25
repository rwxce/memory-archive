# Research workflow: highlights from a chat (dev tool)

Find key moments, patterns and messages of interest in a conversation with an LLM CLI
(Claude Code, Codex CLI), then keep the result as a `findings.json` that points at messages by
fingerprint. The file never contains the chat itself, only fingerprints and your own summaries,
so it can be imported into the app later without duplicating anything.

> **Privacy warning.** Step 2 hands your chat text to an LLM. That content leaves your device and
> is processed by a third party under its terms. Do it only with chats you are willing to share
> that way. This is a developer-side workflow: nothing in the app or its bundle calls an LLM, and
> the repo's tests use synthetic fixtures only. Never commit the research files; delete them when
> you are done.

## Steps

1. Export the chat for research (offline, local):

   ```bash
   pnpm cli export-for-research "WhatsApp Chat - X.zip"
   # writes output/research/<chat>.jsonl and output/research/<chat>.meta.json
   ```

   `output/` is gitignored. Each JSONL line is `{ "fingerprint", "ts", "author", "text" }`;
   fingerprints are computed exactly as the app's import computes them, so they match the
   messages stored in the app. `<chat>.meta.json` is the `conversation` block of the findings
   file (`name`, `messageCount`, `firstFingerprint`).

2. Run your LLM CLI **outside this repo's tracked files**, with the prompt below, pointing it at the
   JSONL. Ask it to write `findings.json` next to it.

3. Validate the result (prints no chat content):

   ```bash
   pnpm cli check-findings output/research/findings.json
   ```

   Exit code 1 and a list of `path: message` lines when something is wrong. Fix it or ask the LLM
   to fix those paths, then validate again.

4. Import the file into the conversation it was made from. The import is idempotent by highlight
   `id`: importing the same file twice changes nothing, and importing an edited file updates the
   highlights whose content changed. Fingerprints that are not in that conversation are skipped
   and counted, and a highlight left with no known message is skipped and reported. If the file's
   `conversation` block (message count, first fingerprint) does not match the conversation you are
   importing into, you get a warning, but the import still runs. Imported highlights are stored in
   the local archive and travel with backups. Deleting a highlight in the app does not remember
   it: importing its file again brings it back.

## findings.json (version 1)

```json
{
  "version": 1,
  "conversation": { "name": "Example Org", "messageCount": 1234, "firstFingerprint": "<64 hex>" },
  "highlights": [
    {
      "id": "moment-first-trip",
      "category": "moment",
      "title": "Planning the first trip",
      "summary": "Short description in your own words.",
      "messages": ["<64 hex fingerprint>", "<64 hex fingerprint>"],
      "createdBy": "claude",
      "createdAt": "2026-01-31T10:00:00Z"
    }
  ]
}
```

- `category`: `moment` (a key event), `pattern` (something that repeats), `interest` (a message
  worth keeping).
- `messages`: 1 to 200 fingerprints copied verbatim from the JSONL (64 lowercase hex). Never invent
  or edit them.
- `id`: 1 to 100 characters of letters, digits and `. _ : -`; unique in the file; keep it stable so
  re-importing an updated file does not duplicate.
- Limits: at most 1000 highlights; title 200 characters, summary 4000, `createdBy` 100. The
  validator is `lib/domain/highlights.ts` (`parseFindings`).

## Sample prompt

```text
Read output/research/<chat>.jsonl (one JSON message per line: fingerprint, ts, author, text)
and output/research/<chat>.meta.json.

Find (a) key moments in the relationship or story told, (b) recurring patterns, (c) individual
messages worth keeping. Write output/research/findings.json with this shape:
{ "version": 1, "conversation": <contents of the meta file>, "highlights": [
  { "id", "category": "moment"|"pattern"|"interest", "title", "summary",
    "messages": [<fingerprints>], "createdBy": "<your tool name>", "createdAt": "<UTC ISO, Z>" } ] }

Rules:
- Copy fingerprints exactly from the file; every highlight needs at least one and at most 200.
- Titles under 200 characters, summaries under 4000, in the language of the chat, in your own words.
- Do not quote long passages; the fingerprints point at the messages.
- Stable, unique, lowercase ids such as "moment-first-trip".
- Output only the JSON file, no commentary.
```

Then run `pnpm cli check-findings output/research/findings.json`.
