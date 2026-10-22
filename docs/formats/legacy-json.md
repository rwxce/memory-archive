# Legacy JSON envelope (`messages.json`)

The JSON written next to every CLI backup as `messages.json`, and embedded
verbatim in `messages.html` as
`<script type="application/json" id="chat-data">…</script>` (with `</` written
as `<\/` so chat text cannot close the script).

- Writer: `lib/exporters/legacy/json.ts` (`buildEnvelope`).
- Reader: `lib/importers/legacy/` (`readLegacyJson`, `readLegacyHtml`).
- Re-import: `memory-archive import-legacy <messages.json|messages.html|messages.csv>`.

## Versions

| `schemaVersion` | Written by | Difference |
| --------------- | ---------- | ---------- |
| absent (= 0) | wa-backup and memory-archive before Phase 1 | no `schemaVersion`, no `generator`; `urlTitles` may be missing |
| `1` | memory-archive ≥ 0.1.0 (Phase 1) | adds `schemaVersion` and `generator` |

Readers accept every version up to their own and **refuse newer ones** with a
clear error instead of guessing. A change that a reader must know about (a
renamed or removed field, a new meaning) bumps the version. Adding an optional
field that old readers can ignore does not.

## Schema 1

```jsonc
{
  "schemaVersion": 1,
  "generator": { "name": "memory-archive", "version": "0.1.0" },
  "metadata": {
    "chatName": "Family 2026",             // display name (no "WhatsApp Chat - " prefix)
    "messageCount": 42,
    "dateRange": ["2026-01-01", "2026-01-31"], // first/last day, ["", ""] when empty
    "exportSource": "whatsapp-export"
  },
  "messages": [
    {
      "timestampIso": "2026-01-01T09:41:00", // local time, no time zone (WhatsApp records none)
      "type": "photo",                        // see "Message types"
      "author": "Ana Lima",                   // raw sender, bidi marks and "~" preserved; "" for system lines
      "text": "Look at this",                 // body or caption; may contain "\n"
      "media": "IMG-20260101-WA0001.jpg",     // file name from _chat.txt, "" when none
      "mediaPath": "media/IMG-20260101-WA0001.jpg", // relative path when the file exists, else null
      "urlTitles": { "https://example.com/a": "Example" }, // link → title, {} when none
      "day": "2026-01-01",                    // derived: timestampIso date
      "time": "09:41:00"                      // derived: timestampIso time
    }
  ]
}
```

Messages are in the canonical order of `messages.csv`: ascending
`timestampIso`, with equal timestamps keeping their order in the export.

### Message types

`text`, `photo`, `video`, `sticker`, `document`, `audio`, `system`, `deleted`,
`omitted`. A reader refuses unknown types.

### What a reader uses

The canonical message is `timestampIso`, `type`, `author`, `text`, `media` and
`urlTitles` (the six `messages.csv` columns). `mediaPath`, `day`, `time` and
`metadata.messageCount` / `dateRange` are derived and ignored on import.
`metadata.chatName` names the output folder.

## Other legacy outputs

- **`messages.html`** — read through its `chat-data` island (same envelope). The
  reader tolerates attribute order, quoting and case, and ignores other
  scripts.
- **`messages.csv`** — `timestamp_iso,type,author,text,media,url_titles`, or the
  older 5-column form without `url_titles`. Newlines in fields are written as
  `\n`, backslashes as `\\`, then RFC 4180 quoting. It does not record the chat
  name (use `--name`, a sibling `messages.json`, or the folder name).
- **`messages.md` is not re-importable.** It is a lossy rendering: times have
  minutes only, system/deleted/omitted lines drop their author, links are
  rewritten as `[title](url)`, text is HTML-escaped and days are localized long
  dates. Re-importing it would change timestamps and text and break duplicate
  detection.
