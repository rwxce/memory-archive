# wa-backup

[![CI](https://github.com/guionardo/wa-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/guionardo/wa-backup/actions/workflows/ci.yml)

Turn a WhatsApp **"Export chat"** ZIP into a self-contained, no-server backup of a single
conversation. It emits three synchronized outputs — **Markdown**, a **WhatsApp-like HTML**
viewer, and structured **JSON** — plus a `messages.csv` source-of-truth, with media
reconciled and optionally inlined.

Everything runs **locally on your machine**. Your chat never leaves your computer (see
[FAQ](#faq)).

## Why

I keep chats and groups that are no longer active, but I don't want to lose them — and my
phone needs the space back. WhatsApp's "Export chat" gives you a ZIP, but the raw `_chat.txt`
is clumsy to read later and still assumes you have WhatsApp installed. **wa-backup** turns that
export into a portable, easily-viewed backup (Markdown, HTML, JSON) you can open in any browser
years from now — no phone, no account, no WhatsApp required.

## Features

- Parses the official WhatsApp `_chat.txt` export (locale-tolerant: auto-detects day/month
  order and 12h/24h format for `pt-BR`, `en-US`, and more).
- Streams line-by-line, so memory stays flat even on huge chats with video.
- Renders the full conversation as Markdown, HTML (WhatsApp-style bubbles), and JSON.
- Reconciles and copies media (`IMG-*.jpg`, `VID-*.mp4`, documents, stickers) into the
  output folder, with relative paths — or inlines them as base64 for a single portable file.
- Resolves shared webpage links to readable **titles** (YouTube, Reddit, Medium, Stack
  Overflow, LinkedIn, X, and generic `<title>`), with favicons in the HTML view.
- XSS-safe output: all chat content is escaped before rendering.

## Requirements

- **Node.js ≥ 22.12** (commander 15 requires it). Check with `node --version`.
- No account, no server, no database.

## Installation

Install globally with your preferred package manager:

```bash
npm install -g wa-backup       # npm
pnpm add -g wa-backup          # pnpm
bun install -g wa-backup       # bun
```

Then run it from anywhere:

```bash
wa-backup "WhatsApp Chat - X.zip"
```

Or run it on demand without installing, via your package manager's runner:

```bash
npx wa-backup "WhatsApp Chat - X.zip"        # npm
pnpm dlx wa-backup "WhatsApp Chat - X.zip"   # pnpm
bunx wa-backup "WhatsApp Chat - X.zip"       # bun
```

## Quick start

1. In WhatsApp, open a conversation → **⋮ Menu → More → Export chat → Without media**
   (or **With media** to include photos/videos).
2. You get a ZIP containing `_chat.txt` and media folders. Save it somewhere.
3. Run:

```bash
wa-backup "WhatsApp Chat - X.zip"
```

This writes, by default, to `output/<chat-name>/`:

```
output/<chat-name>/
├── messages.csv     # source-of-truth, one row per message
├── messages.json    # structured envelope (messages + metadata + urlTitles)
├── messages.md      # human-readable Markdown log
├── messages.html    # standalone WhatsApp-like viewer (open with no server)
└── media/           # reconciled media files (when exported with media)
```

Open `messages.html` directly in a browser (double-click) — no server needed.

## Usage

```
wa-backup [zip] [options]
```

### Options

| Option | Description |
|--------|-------------|
| `[zip]` | Path to the WhatsApp "Export chat" ZIP (positional). |
| `--zip <path>` | Path to the export ZIP (alternative to the positional argument). |
| `--out <dir>` | Output directory. Default: `output/<chat-name>/` under the current directory. |
| `--day-first` | Force day/month date order (e.g. `31/12/2026`). |
| `--month-first` | Force month/day date order (e.g. `12/31/2026`). |
| `--verbose` | Print detected format, locale guess, and any overrides while parsing. |
| `--inline` | Embed resolved media as base64 into a single self-contained HTML file. |
| `--no-fetch-titles` | Skip fetching webpage titles (fully offline; links keep their raw URLs). |
| `-h, --help` | Show full help and examples. |

If format detection guesses wrong on your export, pass `--day-first` or `--month-first`.

## Examples

Render a chat with media, into a specific folder, with verbose parsing info:

```bash
wa-backup "WhatsApp Chat - Família.zip" --out ./backup --verbose
```

Equivalent using the `--zip` flag:

```bash
wa-backup --zip "WhatsApp Chat - Família.zip" --out ./backup
```

Produce a single portable HTML file (media embedded, opens anywhere with no folder):

```bash
wa-backup "WhatsApp Chat - X.zip" --inline
```

Run fully offline (no network calls for link titles):

```bash
wa-backup "WhatsApp Chat - X.zip" --no-fetch-titles
```

### Developing locally

```bash
npm install
npm run dev -- "WhatsApp Chat - X.zip" --verbose
```

> The `--` after `npm run dev` matters: without it, npm swallows flags like `--verbose`.

## Output reference

- **`messages.csv`** — the authoritative model: `timestamp,type,sender,text,media`. Safe to
  re-run; new messages are merged and de-duplicated.
- **`messages.json`** — an envelope with `metadata`, `messages`, and a `urlTitles` map
  (link URL → resolved title) for downstream tooling.
- **`messages.md`** — a linear Markdown transcript, one block per message.
- **`messages.html`** — a standalone viewer with per-sender colors, day dividers, media
  thumbnails, and a click-to-zoom lightbox (works from `file://`).
- **`media/`** — copied media, referenced by relative path. Unresolved references are skipped
  (never crash the run); intentional `<Media omitted>` placeholders stay visible.

## FAQ

**Where do I get the ZIP?**
Inside WhatsApp: open a chat → menu → *More* → *Export chat*. Choose *Without media* for a
small backup or *With media* to include photos/videos.

**Why are some media missing?**
The export only contains media that was on the device at export time. `wa-backup` copies
whatever the ZIP references; if a file isn't in the ZIP, it can't be recovered from the text
export alone.

**Is my data sent anywhere?**
Your chat content stays on your machine. The only network activity is **optional title
fetching** for shared web links (to show "YouTube — Video Title" instead of a raw URL). Pass
`--no-fetch-titles` to disable all network access.

**Can I open the backup years later?**
Yes — that's the point. The HTML/MD/JSON open in any browser with no server, account, or
WhatsApp. Media is either in the local `media/` folder or inlined via `--inline`.

**Does it modify my phone or WhatsApp?**
No. It only reads the ZIP you provide.

## Development

```bash
git clone <your-repo-url>
cd wa-backup
npm install

npm run dev       # run the CLI via tsx
npm test          # run the test suite (node:test)
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run build     # bundle to dist/ via tsup
```

CI (`.github/workflows/ci.yml`) runs **test → lint → build** on every push/PR and publishes to
npm on version tags.

## Publishing

This package uses [semantic versioning](https://semver.org). To publish:

1. Bump the version: `npm version patch` (or `minor`/`major`).
2. Push the tag: `git push --follow-tags`.
3. The CI `publish` job builds and runs `npm publish --provenance` automatically.

You need an `NPM_TOKEN` secret configured in the GitHub repository settings, and a
[provenance](https://docs.npmjs.com/generating-provenance-statements)-capable publish.

## License

[MIT](./LICENSE)
