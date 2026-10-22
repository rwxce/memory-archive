# Technology Stack

**Project:** WhatsApp Chat Backup (wa-backup)
**Researched:** 2026-08-21
**Mode:** Greenfield — TypeScript/Node CLI, parsing core reusable in a future web frontend
**Overall confidence:** HIGH for structural choices; MEDIUM for date/locale parsing (hardest problem, needs phase-level research)

---

## Executive Recommendation

Build a **TypeScript ESM Node CLI**. Use **Commander** for argument parsing, **fflate** for streaming
ZIP extraction (chosen over yauzl specifically because it runs unchanged in the browser — directly
serving the "reusable parsing core" requirement), **`node:readline`** (built-in) for memory-safe
line streaming, **eta** for WhatsApp-like static HTML, a **hand-rolled Markdown writer** (no
dependency), and **date-fns + a custom multi-locale timestamp registry** for the central hard problem
(locale-dependent `_chat.txt` dates). Tooling: **tsx** to run, **tsup** to build the distributable bin.

The single most important architectural rule: **isolate every I/O boundary behind a small interface**
(`ChatArchiveReader` for the zip, an async line iterator for the transcript). The parser core must
depend only on plain strings/streams so the web version imports it directly.

---

## Recommended Stack

### Core Framework / Runtime
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| TypeScript | 5.x (latest) | Language | Type safety for the message model; required for web reuse | HIGH |
| Node.js (ESM) | ≥ 22.12 (dev: 26.5) | Runtime | Commander 15 requires ≥ 22.12; ESM for clean tree-shaking | HIGH |
| `package.json` `type: module` | — | Module system | ESM so the same core loads in Node and browser bundlers | HIGH |

### CLI
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| commander | 15.0.0 | Arg parsing | Zero-dependency, TypeScript-native, ~25KB, fastest startup (~25ms). Chainable API fits a transform CLI with a handful of options (`<zip>`, `--out`, `--inline-media`). ~500M weekly downloads = battle-tested. | HIGH |

### Archive (ZIP) extraction
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| fflate | 0.8.3 | Streaming unzip | **Tiny (8KB), actively maintained (2026), ESM, runs in Node AND browser** — the only option that satisfies "core reusable in web" without a second code path. Its streaming `Unzip` API emits per-entry streams we pipe straight to disk → memory-safe even with large videos. | HIGH (with a usage caveat — see below) |

### Streaming line parsing
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `node:readline` (built-in) | Node core | Line-by-line read | Built into Node, emits one line at a time over a `Readable` → constant memory regardless of chat size. No dependency, no version drift. The parser accumulates continuation lines that don't match the timestamp regex. | HIGH |

### HTML templating
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| eta | 4.6.0 | Static HTML render | Embedded-JS syntax, ~3KB, TypeScript-native, runs in Node AND browser (reuse win). Precompiles templates → fast repeat renders. `<%= %>` escapes by default (XSS-safe for untrusted chat content). Partials cover the message-bubble + page-layout split. | HIGH |
| @kitajs/html | 4.2.13 | (alternative) JSX→string | Even faster, type-safe JSX components that compile to escaped HTML strings. Choose this instead of eta if you want component ergonomics for bubbles; adds tsx/JSX build config. | MEDIUM-HIGH |

### Markdown generation
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Custom `MarkdownWriter` (no dep) | — | Emit `.md` | A chat log is a linear sequence (`**Sender** _time_\n\nbody`). Hand-rolled writer with one escape helper is simpler, dependency-free, and gives full control over output. Avoid heavy AST libs for v1. | HIGH |

### Date / locale parsing (the hard problem)
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| date-fns | 4.4.0 | Date construction + output formatting | Tree-shakeable, TS-native, current. Use `parse` (with `date-fns/locale` for localized month/AM-PM tokens) once a format is resolved. Also use it (and `Intl.DateTimeFormat`) for *rendering* timestamps in output. | MEDIUM |
| Custom `formats.ts` registry | — | Locale detection | **No library auto-detects WhatsApp's locale format.** Proven parsers (whatsapp-chat-to-pdf, NeverFar whatsapp-export-parser, whatsapp-wrapped) all ship a regex pattern set tested against the first lines, then parse with a known tokenizer. This is the real work and must be built, not imported. | MEDIUM |

### Build / dev tooling
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| tsx | 4.23.12 | Run TS directly | Zero-config `node` replacement for `dev`/`start`; no emit step needed during development. | HIGH |
| tsup | 8.5.1 | Build distributable bin | esbuild-based: bundles to ESM, injects shebang, emits `.d.ts` and a `bin` entry for `npm i -g`. Far simpler than `tsc`+packaging or webpack. | HIGH |
| @types/node | 26.2.0 | Types | Matches the Node 26 dev runtime; pin to your engine major. | HIGH |
| picocolors | 1.1.1 | Terminal styling | 1KB, dependency-free color for CLI feedback. Optional but standard. | HIGH |

---

## Alternatives Considered (and why rejected)

| Concern | Recommended | Alternative | Why Not |
|---------|-------------|-------------|---------|
| CLI | commander 15 | yargs 18 | yargs pulls ~7 deps and adds ~20ms startup; its strength (built-in validation, middleware, typo suggestions) is unnecessary for a fixed-option transform CLI. Commander is zero-dep and native-TS. |
| CLI | commander 15 | @oclif/core 4 | oclif is a full framework (~30 deps, class-per-command scaffolding, ~100ms cold start). Overkill for a single-binary tool; wrong for a lean personal CLI. |
| CLI | commander 15 | @clack/prompts 1.7 | clack is **prompts only**, not an argument parser. Useful later for an interactive wizard, but cannot replace Commander for flag/arg handling. |
| ZIP | fflate 0.8 | yauzl 3.4 | yauzl is correct/spec-compliant and Node-only (fd random access). But it is effectively unmaintained (last real release ~2017) and **browser-incompatible**, breaking the reuse requirement. Keep as a fallback if fd-based random access is ever needed. |
| ZIP | fflate 0.8 | jszip 3.10 | jszip loads the whole archive into memory to read it — fatal for large WhatsApp zips with videos. Reject for memory-safety. |
| ZIP | fflate 0.8 | unzipper 0.12 | unzipper streams but is Node-only; offers no browser-reuse advantage over fflate and is heavier. |
| Line parse | node:readline | byline 5.0 | byline is an unmaintained micro-wrapper around newline splitting; readline is core-maintained, async-iterator friendly, and does the same with no dep. |
| Line parse | node:readline | line-reader | line-reader buffers lines into an array (not truly streaming) → defeats the memory-safety requirement. |
| HTML | eta 4.6 | handlebars 4.7 | Logic-less templates add friction for nested bubble conditionals; ~180KB and Node-biased. eta is 3KB and browser-capable. |
| HTML | eta 4.6 | lit 3.3 | lit is a client-side component runtime needing a DOM — wrong for generating a standalone static `.html` file that opens with no server. |
| HTML | eta 4.6 | mustache 4.2 | Too limited (no real control flow/partials ergonomics) for a bubble layout. |
| Markdown | custom writer | remark-stringify / mdast-util-to-markdown | AST→MD is correct but pulls the whole unified ecosystem for a linear log we can emit with template strings + one escaper. Reserve for a future if structured AST editing is needed. |
| Dates | date-fns + registry | luxon 3.7 | Luxon is heavier (~70KB), in maintenance-only mode, and does **not** solve format detection either. date-fns is smaller and tree-shakeable. |
| Dates | date-fns + registry | chrono-node 2.10 | NLP natural-language date parser ("next Monday"). Wrong domain — WhatsApp stamps are strict structured patterns, not prose. |
| Dates | date-fns + registry | dayjs 1.11 | Parsing needs the `customParseFormat` plugin; locale coverage is weaker and plugin fragmentation hurts a reusable core. |

---

## Per-Concern Detail & Confidence

### ZIP — critical usage caveat (memory safety)
fflate has TWO unzip paths. **Use the streaming `Unzip` API**, not the buffer-based `unzip`/`unzipSync`
(the buffer API reads the entire archive into RAM — exactly what we must avoid with video-heavy
exports). Feed `createReadStream(zipPath)` into `new Unzip(...)`, match entries by name, and `pipe()`
each media entry's `ondata` chunks to a `createWriteStream` in the output folder. `_chat.txt` is
collected from its entry stream and handed to the line iterator. Wrap fflate behind a
`ChatArchiveReader` interface so the web build swaps in `DecompressionStream`/`fflate` in-browser later.

### Dates — phase-level research flag
This is the one area rated MEDIUM confidence because the difficulty is **detection**, not parsing.
Recommended approach (validated by existing open-source parsers):
1. A `formats.ts` registry of `{ id, regex, dateTokens, locale? }` patterns covering iOS bracketed,
   Android dashed/dotted, year-first (ISO/Asian), 12h vs 24h, 2- vs 4-digit years, dot-time separators,
   and localized AM/PM markers (`AM`/`p.m.`/Arabic `ص`/CJK `午前`).
2. On load, test patterns against the first ~20 lines; pick the best match (highest hit rate).
3. Extract `{datePart, timePart, sender, body}` via the matched regex; construct a `Date` with
   date-fns `parse` (or a normalized `Intl`-free tokenizer for exotic digits).
4. Ambiguous all-numeric dates (every component ≤ 12) → fall back to a `dayFirst` heuristic; expose
   a `--day-first`/`--month-first` override flag.
This deserves a dedicated research/design phase before coding (flag for the parser phase).

### Reuse boundary (drives the whole stack)
Every pick above was filtered through "does it also run in a browser?" fflate, eta, date-fns, and
node:readline's *pattern* (replaced by an async line iterator over a `File` stream in web) all pass.
Keep `fs`/zip/terminal I/O in thin adapter modules; the `parseChat(lines)` core stays pure.

---

## Installation

```bash
# Runtime dependencies (production)
npm install commander@15 fflate@0.8 eta@4.6 date-fns@4 picocolors@1

# Dev / build tooling
npm install -D typescript tsx@4 tsup@8 @types/node@26
```

`package.json` essentials:
```json
{
  "type": "module",
  "bin": { "wa-backup": "./dist/cli.js" },
  "engines": { "node": ">=22.12" },
  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsup src/cli.ts --format esm --target node22 --dts --clean",
    "start": "tsx src/cli.ts"
  }
}
```
tsup config injects the shebang (`#! /usr/bin/env node`) via `--banner` or a `tsup.config.ts`.

---

## Sources (with confidence)

- Commander vs Yargs vs Oclif 2026 comparisons (PkgPulse, Grizzly Peak Software, Nazar Boyko) — web, HIGH corroboration, versions verified via `npm view`.
- yauzl / fflate / jszip npm READMEs + fflate discussion #190 — web, HIGH (fflate streaming caveat confirmed by maintainer).
- WhatsApp `_chat.txt` format references (wachattopdf.com blog, NeverFar whatsapp-export-parser, whatsapp-wrapped SUPPORTED_FORMATS, whatsapp-chat-export-viewer) — web, HIGH; confirm locale detection is the real problem and is solved by pattern registries, not a library.
- eta vs handlebars vs ejs 2026 (PkgPulse) + @kitajs/html benchmarks — web, HIGH.
- mdast-util-to-markdown / remark-stringify READMEs — web, HIGH (confirms AST→MD is heavier than needed for v1).
- `npm view <pkg> version` for every package listed — authoritative current versions, 2026-08-21.

### Confidence summary
| Area | Level | Note |
|------|-------|------|
| CLI (commander) | HIGH | Unanimous, version-verified |
| ZIP (fflate) | HIGH | Maintained + browser-reusable; only caveat is using the streaming API |
| Line parsing (readline) | HIGH | Built-in, standard pattern |
| HTML (eta) | HIGH | Light, safe, reusable |
| Markdown (custom) | HIGH | Simplest correct approach |
| Dates (date-fns + registry) | MEDIUM | Detection logic is custom; needs a dedicated parser-phase deep-dive |
| Tooling (tsx/tsup) | HIGH | Standard 2025 TS-CLI toolchain |

