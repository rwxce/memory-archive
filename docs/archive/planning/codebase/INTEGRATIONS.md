# External Integrations

**Analysis Date:** 2026-08-23

## APIs & External Services

The only outbound network activity in the entire codebase is **optional webpage-title fetching** for shared links, implemented in `src/title.ts`. It is off by default? No — it is **ON by default** and disabled with `--no-fetch-titles` (`src/index.ts:22`, `src/model.ts:114-120`). When disabled, `enrichTitles` sets every message's `urlTitles = {}` and never calls `fetch` (`src/title.ts:269-273`).

All calls use the **Node built-in global `fetch`** (no HTTP client dependency). Timeouts are enforced via `AbortController` + `setTimeout` (`src/title.ts:187-188`, `timeoutMs` default `5000`).

Per-platform dispatch (`src/title.ts:181` `fetchTitle`):

| Platform (detected) | Integration | Endpoint / Method | Code |
|---------------------|-------------|-------------------|------|
| `youtube` | YouTube **oEmbed** (JSON) | `GET https://www.youtube.com/oembed?url=<enc>&format=json` | `youTubeOembedUrl` `src/title.ts:78`, `parseYouTubeOembed` `src/title.ts:82` |
| `reddit` | Reddit **`.json` listing** | `GET <url>.json` (append `.json`, follow redirect) | `redditJsonUrl` `src/title.ts:89`, `parseRedditJson` `src/title.ts:93` |
| `medium` | HTML scrape (browser UA) | `GET <url>` with `User-Agent: <browser>` | `fetchMediumTitle` `src/title.ts:120` |
| `stackoverflow` | **Stack Exchange API** | `GET https://api.stackexchange.com/2.3/questions/<id>?site=stackoverflow` | `stackExchangeApiUrl` `src/title.ts:133`, `parseStackOverflowJson` `src/title.ts:139` |
| `generic` | HTML `<title>` fetch | `GET <url>` (og:title / twitter:title / `<title>`) | `fetchHtmlTitle` `src/title.ts:161`, `extractTitle` `src/title.ts:43` |
| `linkedin` | **Offline** — derive from URL slug | no network | `deriveLinkedInTitle` `src/title.ts:104` |
| `x` (twitter) | **Offline** — derive from URL slug | no network | `deriveXTitle` `src/title.ts:146` |

**Platform classification:** `platformOf(url)` (`src/title.ts:61`) matches hostname (strips `www.`). Hosts: `youtube.com`/`youtu.be`, `reddit.com`, `linkedin.com`, `medium.com`, `stackoverflow.com`, `x.com`/`twitter.com`; anything else → `generic`.

**URL unwrapping:** LinkedIn redirect wrappers (`/safety/go/?url=`) are resolved to the real destination by `unwrapUrl` (`src/render/js/linkify.js:53`) before any fetch.

**Concurrency:** unique URLs are fetched by `concurrency: 8` parallel promise workers (`src/title.ts:282-302`, `enrichTitles`). Each worker pulls the next URL from a shared cursor.

**Fallback chain:** any platform-specific failure falls through to `fetchHtmlTitle`, then to an offline `deriveTitle` (`src/title.ts:246`, `src/title.ts:248`). Callers always get a usable label.

**User agent:** a Chrome UA string (`src/title.ts:7-9`) is sent to reduce bot-blocking on Medium etc.; Reddit gets its own `wa-backup/1.0 (+title-extractor)` UA (`src/title.ts:211`).

## Data Storage

**Databases:**
- **None.** No SQL, NoSQL, or ORM. The "source-of-truth" is a local CSV file.

**File formats consumed (input):**

1. **WhatsApp "Export chat" ZIP** — a standard ZIP containing `_chat.txt` (the transcript) and optional media folders. Read two ways:
   - Transcript: streamed via fflate `Unzip`/`AsyncUnzipInflate`, inflating **only** the `_chat.txt` entry (`src/extract.ts:16` `extractChatTxt`). AppleDouble (`._*`, `__MACOSX`) entries are skipped, never inflated (`src/extract.ts:25-27`).
   - Media: central-directory scan with raw `node:fs` + `node:zlib.createInflateRaw` (`src/media.ts:76` `readCentralDirectory`, `src/media.ts:123` `extractEntry`). This avoids buffering the whole archive and works around fflate's data-descriptor bug.
   - Chat name derived from ZIP entry names / filename (`src/extract.ts:118` `slugifyChatName`, `src/extract.ts:151` `chatNameFromZip`).

2. **Existing `messages.csv`** — re-read for incremental merge and re-render (`src/csv.ts:104` `readCsv`).

**File formats produced (output):** all written under `<out>/<slug>/` (default `output/<slug>/`, `src/model.ts:88-90`):

| File | Format | Producer | Notes |
|------|--------|----------|-------|
| `messages.csv` | CSV (RFC-4180-ish, custom escaping) | `src/csv.ts` (`writeCsv` `:124`, `mergeCsv` `:144`) | Authoritative model. Columns: `timestamp_iso,type,author,text,media,url_titles`. Stable ascending sort, dedup by `(timestamp_iso,author,text,media)` (`src/csv.ts:59` `dedupeKey`). |
| `messages.json` | JSON envelope | `src/render/json.ts` (`buildEnvelope`) | `{ metadata, messages, urlTitles }`. Written to disk in `renderHtml`/`renderJson`. |
| `messages.md` | Markdown | `src/render/md.ts` (`renderMarkdown`) | Linear transcript, one block per message, links via `linkifyMarkdown`. |
| `messages.html` | Standalone HTML | `src/render/html.ts` (`renderHtml`) | Self-contained viewer: inlined CSS (`src/render/html.ts:215`), embedded `src/render/js/transcript.js`, JSON data island (`src/render/html.ts:293`). Opens from `file://` with no server. |
| `media/` | Copied media files | `src/media.ts` (`reconcileMedia` `:171`, `buildMediaMap` `:236`) | Matched by tolerant name normalization (`normalizeMediaName` `src/media.ts:24`). Unresolved refs rendered as placeholders, never crash. |
| `media/` (inline) | `data:` URIs (base64) | `src/render/html.ts` (`readFileAsDataUri` `:64`) | When `--inline`: files ≤ `INLINE_MAX_BYTES` (8 MiB, `src/media.ts:13`) and non-video inlined as `data:<mime>;base64,…`. |

**Caching:**
- None at the application layer. Per-run in-memory `Map` of URL→title (`src/title.ts:281` `map`) and media `Map` (`src/media.ts:236`).

## Authentication & Identity

**Auth Provider:** None. No accounts, no tokens, no OAuth. The tool reads a local ZIP the user already possesses.

**Secrets:** None required. No API keys are read (YouTube oEmbed, Reddit `.json`, Stack Exchange API are all **unauthenticated** public endpoints). No `.env` file exists in the repo.

## Monitoring & Observability

**Error Tracking:** None (no Sentry/Telemetry).

**Logs:** Human-facing only, via `picocolors` on `stderr`/`stdout`:
- Success/failure banners (`src/index.ts:58-71`).
- Verbose format-detection report (`src/model.ts:27` `verboseReport`).
- Per-URL title fetch in verbose mode (`src/title.ts:294`).
- Media resolved/unresolved counts (`src/model.ts:143-154`).

## CI/CD & Deployment

**Hosting:** npm registry (`npm install -g wa-backup` / `npx wa-backup`). No application hosting.

**CI Pipeline:** `.github/workflows/ci.yml`:
- `verify` job (Node `22.x`, `24.x` matrix): `npm ci` → `npm run lint` → `npm test` → `npm run build`.
- `publish` job: on `v*` tags only, `npm publish --provenance` using `NPM_TOKEN` secret (OIDC `id-token: write`).

**No Docker, no Kubernetes, no cloud deploy.** Pure npm package.

## Environment Configuration

**Required env vars:** None.

**Optional runtime flags (not env vars):** `--zip`, `--out`, `--day-first`, `--month-first`, `--verbose`, `--inline`, `--no-fetch-titles` (all in `src/index.ts:16-22`).

**Secrets location:** N/A — the only secret in the project is `NPM_TOKEN`, used solely by CI publish (`.github/workflows/ci.yml:50`), never by the CLI code.

## Webhooks & Callbacks

**Incoming:** None.

**Outgoing:** None, except the **stateless outbound `fetch` calls** for title enrichment described above (YouTube oEmbed, Reddit, Medium, Stack Exchange API, generic `<title>`). No webhooks, no callbacks, no long-polling.

## Security / Privacy Posture

- **Local-first:** chat content never leaves the machine. The only network egress is the user's own shared links being resolved to readable titles (`README.md:148-151`).
- **XSS-safe output:** all chat text is HTML-escaped before rendering (`escapeHtml` `src/render/html.ts:11`; `linkifyHtml` `src/render/js/linkify.js:71`). The JSON data island is escaped against `</script>` breakout (`src/render/html.ts:262` `.replace(/<\//g, '<\\/')`).
- **Trusted data URIs:** base64 `data:` URIs are built only from local media bytes, never from chat text (`src/render/html.ts:70`).
- **Opt-out:** `--no-fetch-titles` guarantees zero network calls (`src/title.ts:269-273`).

---

*Integration audit: 2026-08-23*
