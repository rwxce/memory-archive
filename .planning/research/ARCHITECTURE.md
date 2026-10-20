# Architecture Patterns: WhatsApp Chat-Export Parser / CLI

**Project:** WhatsApp Chat Backup (wa-backup)
**Researched:** 2026-08-21
**Mode:** Greenfield — TypeScript/Node CLI; parsing core must be importable by a future web frontend
**Overall confidence:** HIGH (pattern corroborated by nazarboyko.com 2024 Hexagonal-in-Node.js write-up + Node.js `readline` async-iterator docs; real sample export inspected for format specifics)

---

## Executive Recommendation

Use a **Ports-and-Adapters (Hexagonal) layout** with a **pure, platform-agnostic `core/`** at the center and **thin Node adapters** around it. The single non-negotiable rule, driven directly by `PROJECT.md`'s "parsing core is deliberately isolated so the future web version can import it directly," is:

> **`src/core/**` may not import `node:*`, `fs`, `fflate`, `commander`, or any platform-only package. It depends only on the `ports/` interfaces it owns and on the libraries that already run in browsers (eta, date-fns).**

Everything that touches a file, a ZIP, or the terminal is an **adapter** that implements a core-owned **port**. A single `composition/container.ts` is the only file allowed to see both sides. When v2 arrives, you add `adapters/browser/*` and a second `container` — the core, the parser, the model, and the renderers are imported unchanged.

This gives you the three requested outputs (MD/HTML/JSON) and media reconciliation **without** a second code path, and it makes the central hard problem (locale date detection) an internal concern of the pure parser, not a side effect of I/O.

---

## Component Map (with Boundaries)

### Driving side (calls into the core)
| Component | Layer | Responsibility | Talks to | May import platform I/O? |
|-----------|-------|----------------|----------|--------------------------|
| `cli/cli.ts` | Adapter (driving) | Commander entry; parses `<zip>`, `--out`, `--inline-media`, `--day-first`/`--month-first`; prints progress; calls the use-case. | `composition/container` (gets wired use-case) | YES (commander, process) |
| `use-cases/parse-export.ts` | **Core** | Orchestrates the whole pipeline: open archive → read lines → parse → reconcile media → render → write outputs. Exposes one method (`run(input, opts)`). | `ports/*`, `parser/*`, `render/*` | NO |
| Future web route/handler | Adapter (driving, v2) | An HTTP/upload handler that calls the same use-case with browser adapters. | `composition/container` (browser) | YES (Request/Response) |

### Center (the reusable core — NO platform I/O)
| Component | Responsibility | Talks to |
|-----------|----------------|----------|
| `model/message.ts` | `NormalizedMessage`, `ChatEvent`, `MessageType` (`message | system | call`), `MediaRef`, `OmittedKind` (`media | deleted`), output envelope types. Pure data. | nothing (leaf) |
| `parser/parse-chat.ts` | **The parser core.** Stateful async generator `parseChat(lines: AsyncIterable<string>): AsyncIterable<ChatEvent>`. Stitches continuation lines, classifies headers, normalizes numerics/bidi. Emits `ChatEvent` (raw-parsed, before date construction). | `formats.ts`, `classify.ts`, `media-ref.ts`, `model` |
| `parser/formats.ts` | Locale timestamp **registry** + `detectFormat(sampleLines)`. The hardest sub-problem (see Pitfall C1). | `model` |
| `parser/classify.ts` | Distinguishes user message / system / call / `<Media omitted>` / `Mensagem apagada` (deleted) / document. | `model` |
| `parser/media-ref.ts` | Extracts referenced media filename(s) from a line body. **Key real-world finding:** documents embed their filename in the body (`autorizacao_atividade.pdf • 2 páginas document omitted`), while images/video/audio use `IMG-/VID-/PTT-` WA-prefixed names. | `model` |
| `render/to-json.ts` | Serializes normalized messages → structured JSON (easiest, first). | `model` |
| `render/to-markdown.ts` | Custom `MarkdownWriter` (no dep) — `**Sender** _time_\n\nbody`. | `model`, `escape.ts` |
| `render/to-html.ts` | eta templates (bubble + page layout). | `model`, `escape.ts`, eta |
| `render/escape.ts` | **One** XSS escaper applied to every field (sender, body, filename, alt, URL). Security gate (Pitfall C5). | nothing |

### Driven side (core requires these; adapters implement them)
| Port (interface in `core/ports`) | Implemented by | Responsibility | Platform I/O |
|-----------------------------------|----------------|----------------|-------------|
| `ChatArchiveReader` (driven) | `adapters/node/fflate-archive-reader.ts` (v1); `adapters/browser/decompression-archive-reader.ts` (v2) | Open ZIP; list entries; expose `_chat.txt` as a byte stream + each media entry as a byte stream; ignore `._*` AppleDouble files. | fflate (Node) / `DecompressionStream` (browser) |
| `LineSource` (driven) — an `AsyncIterable<string>` | `adapters/node/readline-line-source.ts` (v1); `adapters/browser/file-line-source.ts` (v2) | Turn the `_chat.txt` byte stream into lines, one at a time, constant memory. | `node:readline` (Node) / `TextDecoderStream` over `File` (browser) |
| `OutputSink` (driven) | `adapters/node/fs-output-sink.ts` (v1); `adapters/browser/download-output-sink.ts` (v2) | Write rendered `.md`/`.html`/`.json` and copy media bytes to the output folder using **safe basenames** (Pitfall C6). | `node:fs` (Node) / Blob/object-URL (browser) |

> **Why `LineSource` is a port and not `node:readline` directly:** the parser core consumes `AsyncIterable<string>`. Node's `readline` over `fs.ReadStream` is one implementation; a browser `File → TextDecoderStream → split-on-newline` is the other. The core never knows which it got — confirmed viable (Node streams implement `Symbol.asyncIterator` since 11.14; isomorphic line-reader packages like `readlineiter`/`fetchline` prove the shape).

---

## Data Flow (direction is explicit)

```
                 DRIVING (Node v1)                         DRIVEN
  ┌──────────────────────────────────────┐      ┌──────────────────────────────────────┐
  │ cli.ts (commander)                    │      │                                      │
  │   │  calls                            │      │  ChatArchiveReader  (port)           │
  │   ▼                                   │      │   └─ fflate-archive-reader.ts        │
  │ use-cases/parse-export.run()  ◄───────┼──────┼── opens ZIP, yields:                │
  │   │                                   │      │      • _chat.txt byte stream ─┐     │
  │   │ open archive  ────────────────────┼──────┼───────────────────────────────┼───  │
  │   │                                   │      │      • media entry byte streams │     │
  │   │ lines = LineSource(_chat.txt) ────┼──────┼───────────────────────────────┼───  │
  │   │   └─ readline-line-source.ts      │      │                              │     │
  │   ▼                                   │      │  LineSource (port)            │     │
  │ parser/parse-chat(lines)              │      │                              │     │
  │   ├─ formats.detectFormat()  (C1)     │      │                              │     │
  │   ├─ classify()  (M2,M3)              │      │                              │     │
  │   ├─ media-ref.extract()  (C4)        │      │                              │     │
  │   └─ async yields ChatEvent[]         │      │                              │     │
  │   ▼                                   │      │                              │     │
  │ normalize → NormalizedMessage[]       │      │                              │     │
  │   │                                   │      │                              │     │
  │   ├─ reconcile media:                 │      │                              │     │
  │   │   match MediaRef → archive entry   │──────┼── reads media entries ───────┘     │
  │   │   (basename, case-insensitive,     │      │                                      │
  │   │    strip (1), safe write C6)       │      │  OutputSink (port)                  │
  │   ▼                                   │      │   └─ fs-output-sink.ts              │
  │ render/to-json | to-markdown |        │      │      • writes .md/.html/.json       │
  │        to-html (escape ALL C5)        │      │      • copies media (safe basename) │
  │   ▼                                   │      │                                      │
  │ OutputSink.write(envelope) ───────────┼──────┼─────────────────────────────────── │
  └──────────────────────────────────────┘      └──────────────────────────────────────┘
```

**Direction rule:** arrows of dependency point **into** `core/`. `core/` imports only `ports/*` (its own interfaces) and browser-safe libs. Adapters import `core/ports` and platform APIs. The CLI imports `composition/container`, never `core` internals directly.

**Streaming note (Pitfall M4):** `parse-chat` is an `async generator`; it yields `ChatEvent`s as lines arrive, so the renderer and `OutputSink` can write incrementally. The whole transcript is never held in memory. HTML inlining of media is the only place a size cap (`--embed-max-mb`, skip video) is needed.

**Real-sample edge cases to design for (observed in `WhatsApp Chat - Notas pessoais.zip`):**
- Format `[17/03/2026, 13:17:58] Guionardo Furlan: …` — iOS bracket, `DD/MM/YYYY`, 24h, pt-BR locale (comma + space between date and time, `]` + space before sender).
- Invisible bidi marks (`U+200E`) prefix some lines (e.g. `‎image omitted`, `‎Mensagem apagada`) — strip before matching (Pitfall M5).
- Documents embed their original filename in the body (`autorizacao_atividade.pdf • 2 páginas document omitted`) and the matching file `96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf` exists in the ZIP — so document reconciliation must match by embedded name, not WA-prefix.
- A **nested ZIP** (`00000068-Conversa do WhatsApp com Notas pessoais.zip`) sits inside the export — the `ChatArchiveReader` should flag/handle nested archives rather than silently skip them (defer to v1.1, but the port must not preclude it).

---

## Recommended Directory Layout

```text
src/
  core/                         # ZERO platform imports — runs in Node AND browser
    model/message.ts            # NormalizedMessage, ChatEvent, MessageType, MediaRef, OmittedKind
    ports/
      archive-reader.ts         # ChatArchiveReader  (driven)
      line-source.ts            # LineSource = AsyncIterable<string>  (driven)
      output-sink.ts            # OutputSink  (driven)
    parser/
      parse-chat.ts             # parseChat(lines): AsyncIterable<ChatEvent>
      formats.ts                # locale registry + detectFormat()
      classify.ts               # message/system/call/omitted/deleted
      media-ref.ts              # extract referenced filename(s) from a line
    render/
      escape.ts                 # single XSS escaper
      to-json.ts
      to-markdown.ts
      to-html.ts                # eta templates
    use-cases/parse-export.ts   # orchestrator (the one core entry point)
  adapters/
    node/
      fflate-archive-reader.ts
      readline-line-source.ts
      fs-output-sink.ts
    browser/                     # v2 — NOT built in v1
      decompression-archive-reader.ts
      file-line-source.ts
      download-output-sink.ts
  cli/
    cli.ts                       # commander (driving adapter)
    options.ts                   # flag definitions
  composition/
    container.ts                 # ONLY file importing core + adapters/node
```

---

## Suggested Build Order (dependencies = roadmap phases)

Order is dictated by what depends on what. **Parser core first** because it is the highest-risk, zero-I/O piece and everything else renders its output.

| # | Component(s) | Depends on | Why this order | Pitfalls owned |
|---|--------------|-----------|----------------|----------------|
| **Phase 1 — Model + Parser core** | `model/*`, `parser/parse-chat.ts`, `parser/classify.ts`, `parser/media-ref.ts`, `ports/line-source.ts`, `adapters/node/readline-line-source.ts` | nothing | Highest-risk, pure, no archive needed (feed it strings in tests). A `parseChat(strings)` unit test over US/DE/TR/AR/pt-BR samples validates the crux before any I/O exists. | C1, C2, C3, M1, M2, M3, M5, N2, N3, N4 |
| **Phase 2 — Locale detection** | `parser/formats.ts` (`detectFormat`) | Phase 1 | The detection sub-problem is separable but blocks *trustworthy* output. Ship format registry + `--day-first`/`--month-first` override + unresolved-format report. | C1, N2 |
| **Phase 3 — Archive extraction** | `ports/archive-reader.ts`, `adapters/node/fflate-archive-reader.ts` | nothing (parallelizable with P1) | Streaming `Unzip` (NOT buffer API) emits `_chat.txt` + media entry streams. Can be built in parallel with P1 since the parser only needs `LineSource`, not the zip. End-to-end wiring needs both. | M4 (memory), C3 (`._*` ignore) |
| **Phase 4 — Media reconciliation + safe write** | `parser/media-ref.ts` (wired), `adapters/node/fs-output-sink.ts` (safe-basename write) | Phase 1, 3 | Match `MediaRef` → archive entry (basename, case-insensitive, strip `(1)`); distinguish intentional omission vs missing-but-expected; emit unresolved-media report; assert write path stays in media dir. **Real sample note:** documents carry their *original* filename in the body — resolver must handle that, not just `IMG-/VID-/PTT-` prefixes. | C4, C6 |
| **Phase 5 — Renderers** | `render/escape.ts`, `to-json.ts`, `to-markdown.ts`, `to-html.ts` | Phase 1 (model) | Render JSON first (trivial, validates model), then MD (custom writer), then HTML (eta + escaping). The `escape.ts` gate is mandatory before HTML ships. | C5, M2 (placeholder styling), M5 (RTL `dir=auto`) |
| **Phase 6 — CLI wiring + flags** | `cli/cli.ts`, `cli/options.ts`, `composition/container.ts` | Phases 1–5 | Commander parses `<zip>`/`--out`/`--inline-media`/`--day-first`; `container.ts` constructs `FflateArchiveReader + ReadlineLineSource + FsOutputSink` and calls `parse-export.run`. | (integration) |
| **Phase 7 — Inline media (HTML)** | builds on Phase 4 + 5 | Phases 4, 5 | `--inline-media` base64-embeds into a single HTML; cap per file (`--embed-max-mb`), skip video by default. | C6 (still safe basename when copying), M4 |
| **Phase 8 (v2) — Web adapters** | `adapters/browser/*` + browser `container` | core (unchanged) | Swap `FflateArchiveReader`→`DecompressionStream` reader, `ReadlineLineSource`→`File`/`TextDecoderStream`, `FsOutputSink`→Blob/download. No core changes. | (reuse win) |

**Build-order implications for the roadmap:**
- Parser core (Phases 1–2) is the **riskiest and most research-heavy** slice — it alone owns Pitfalls C1, C2, C3, M1–M5, N2–N4. Recommend a dedicated deep-dive phase before any I/O code, exactly as STACK.md flags ("date detection needs a dedicated parser-phase deep-dive").
- Archive extraction (Phase 3) is **independently parallelizable** with the parser because the parser's only I/O contract is `AsyncIterable<string>`. Two engineers (or two parallel sub-agents) can build P1 and P3 simultaneously.
- Renderers (Phase 5) are **low-risk once the model is fixed**; JSON proves the model, MD/HTML are mechanical. Do them after P1 stabilizes the `NormalizedMessage` shape.
- CLI (Phase 6) is **pure wiring** — trivial once the use-case and adapters exist.

---

## How the Core Stays Reusable for a Web Frontend

The web version is a **port swap, not a rewrite**:

1. **No `core/` change is ever required.** `core/` already imports zero Node APIs. It is ESM and tree-shakeable; a Vite/Next bundler pulls it in as-is.
2. **Three driven adapters get browser twins:**
   - `ChatArchiveReader`: Node uses `fflate` streaming `Unzip` over `fs.ReadStream`; browser uses the native `DecompressionStream` over the uploaded `File` (or `fflate` in-browser — same lib, so even the adapter can be shared).
   - `LineSource`: Node uses `node:readline`; browser wraps `file.stream().pipeThrough(new TextDecoderStream())` and splits on newlines. Both yield `AsyncIterable<string>`.
   - `OutputSink`: Node writes to `fs`; browser returns `Blob`s / object-URLs for download or streams into a `<viewer>`.
3. **The driving adapter changes:** `cli.ts` (commander) is replaced by an upload route/handler that calls the **same** `parse-export.run(input, opts)`. The use-case signature does not change.
4. **Renderers are shared verbatim** — `to-json`/`to-markdown`/`to-html` return strings; the web layer returns them in a response or renders in-place. `escape.ts` protects the browser viewer from the same XSS surface (Pitfall C5).
5. **`composition/container.ts` is duplicated, not edited:** `container.browser.ts` wires the browser adapters; `container.node.ts` keeps the CLI wiring. This is the *only* duplication, and it is intentional (Hexagonal rule: one file sees both sides).

Net result: the future web service imports `core/use-cases/parse-export`, `core/parser/*`, `core/render/*`, and `core/model/*` with **zero modification**, satisfying `PROJECT.md`'s stated motivation ("CLI first, web later … reuses the parsing core").

---

## Cross-Reference to Companion Research

- **STACK.md** — confirms the browser-safe library picks (fflate, eta, date-fns, commander) that make the `core/`/`adapters` split free of second code paths.
- **PITFALLS.md** — each phase above lists the pitfalls it owns. The architecture turns every pitfall into a *located* responsibility (e.g. C5 → `render/escape.ts`; C6 → `adapters/node/fs-output-sink.ts`; C1 → `parser/formats.ts`), so none is left to cross-cutting luck.
- **Phase naming convention:** the phase numbers above are the recommended ROADMAP phase structure; map PITFALLS' "Phase-Specific Warnings" table onto them 1:1.

---

## Sources (confidence)

- Hexagonal / Ports-and-Adapters in Node.js (nazarboyko.com, 2024-05-21) — web, **HIGH**: ports=core-owned interfaces, adapters implement them, one composition file wires both; dependency arrow points into the hexagon. Directly validates the `core/`/`adapters/`/`composition/` split.
- Node.js `readline` docs (nodejs.org, v26) — official, **HIGH**: `createInterface({input: fsReadStream, crlfDelay: Infinity})` + `for await...of` yields one line at a time, constant memory; `Readable` implements `Symbol.asyncIterator` (stable since 11.14). Basis for the `LineSource` port + browser `TextDecoderStream` twin.
- Isomorphic line-reader packages `readlineiter`/`fetchline` (npm/GitHub) — web, **HIGH**: prove an `AsyncIterable<string>` line source works identically in Node, Deno, and browsers. Confirms the parser-core stays platform-agnostic.
- First-hand inspection of `WhatsApp Chat - Notas pessoais.zip` (real export, 2026-08-21) — **HIGH**: confirmed `[DD/MM/YYYY, HH:MM:SS]` pt-BR bracket format, bidi marks, `Mensagem apagada`/`<* omitted>` markers, document filename embedded in body, and a nested ZIP — all fed into the component responsibilities above.


