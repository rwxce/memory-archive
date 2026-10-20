# Reversa

> Framework de Engenharia Reversa instalado neste projeto.

## Como usar

Digite `reversa` para ativar o Reversa e iniciar ou retomar a análise do projeto.

## Comportamento ao ativar

Quando o usuário digitar `reversa` sozinho em uma mensagem:

1. Ative o skill `reversa` disponível em `.agents/skills/reversa/SKILL.md`
2. Leia o SKILL.md na íntegra e siga exatamente as instruções do Reversa

## Regra não-negociável

Nunca apague, modifique ou sobrescreva arquivos pré-existentes do projeto legado.
O Reversa escreve **apenas** em `.reversa/` e `_reversa_sdd/`.

---

<!-- GSD:project-start source:PROJECT.md -->

## Project

**WhatsApp Chat Backup**

A TypeScript/Node command-line tool that reads the official WhatsApp chat-export ZIP (a `_chat.txt` transcript plus media folders) and produces a self-contained, fully-viewable backup of a single conversation. It emits three synchronized outputs — Markdown, HTML (WhatsApp-like), and structured JSON — with media referenced in a local folder by default and optionally inlined.

**Core Value:** A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.

### Constraints

- **Tech stack**: TypeScript / Node (CLI run via node or npx) — chosen so the core is reusable in the future web frontend.
- **Performance**: Must stream-parse to stay memory-safe on large chats (videos, long histories).
- **Portability**: Output folder must open standalone in any browser with no server.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Executive Recommendation

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

## Per-Concern Detail & Confidence

### ZIP — critical usage caveat (memory safety)

### Dates — phase-level research flag

### Reuse boundary (drives the whole stack)

## Installation

# Runtime dependencies (production)

# Dev / build tooling

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
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
