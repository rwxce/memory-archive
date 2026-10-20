---
name: rulesync
description: >-
  Generates and syncs AI agent configuration (CLAUDE.md, AGENTS.md, .claude/,
  .cursor/, .codex/, .opencode/) from the single source in .rulesync/. Use when
  editing rules, skills, commands, subagents, hooks, permissions or MCP config,
  when running rulesync commands, or when `pnpm rulesync:check` fails.
---
# Rulesync

This repo pins **rulesync 33.0.0** (exact devDependency). `.rulesync/` is the single source
of truth; everything rulesync writes (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.cursor/`,
`.codex/`, `.opencode/`, `.agents/`, `opencode.jsonc`, ...) is generated and must never be
hand-edited. CI fails if they drift (`pnpm rulesync:check`).

## Everyday workflow

```bash
# 1. Edit files under .rulesync/ (or rulesync.jsonc)
# 2. Regenerate every target
pnpm rulesync               # = rulesync generate
# 3. Verify nothing is out of sync (what CI runs)
pnpm rulesync:check         # = rulesync generate --check
# 4. Commit the .rulesync/ change and the generated files together
```

Preview without writing: `pnpm exec rulesync generate --dry-run`.
Diagnose config problems: `pnpm exec rulesync doctor`.

## This repo's configuration

- `rulesync.jsonc` — targets `claudecode`, `codexcli`, `cursor`, `opencode`; `delete: false`.
- `.rulesync/rules/CLAUDE.md` — the root rule (`root: true`, `targets: ['*']`).
- `.rulesync/skills/<name>/SKILL.md` (+ supporting files) — skills.
- `.rulesync/commands/*.md` — slash commands (`/pr-plan`, `/pr-precheck`, `/pr-make`, ...).
- `.rulesync/subagents/*.md` — subagents, with `claudecode:` frontmatter (model, color, memory).
- `.rulesync/hooks.jsonc` — hooks with canonical camelCase events (`preToolUse`, `stop`, `sessionEnd`).
- `.rulesync/permissions.jsonc` — allow/ask/deny rules per tool category (`bash`, `read`, ...).
- `.rulesync/mcp.jsonc` — MCP servers.
- `.rulesync/.aiignore` — legacy ignore list (deprecated upstream; kept for Cursor's `.cursorignore`).
- `.rulesync/checks/*.md` — code-review checks (Cursor Bugbot, `.cursor/BUGBOT.md`).

## Authoritative documentation

The bundled docs always match the installed version — prefer them over memory:

```bash
pnpm exec rulesync docs                              # list documents
pnpm exec rulesync docs reference/file-formats       # full frontmatter / JSON formats
pnpm exec rulesync docs --search "<term>"
```

## Reference (vendored from rulesync 33.0.0 `rulesync docs`)

- [Installation](./installation.md), [Quick Start](./quick-start.md)
- [Why Rulesync?](./why-rulesync.md), [Configuration](./configuration.md), [Global Mode](./global-mode.md), [Separate Input Root](./separate-input-root.md), [Simulated Features](./simulated-features.md), [Declarative Sources](./declarative-sources.md), [Official Skills](./official-skills.md), [Dry Run](./dry-run.md), [Case Studies](./case-studies.md)
- [Supported Tools](./supported-tools.md), [CLI Commands](./cli-commands.md), [File Formats (condensed for this repo)](./file-formats.md), [Command Syntax](./command-syntax.md), [MCP Server](./mcp-server.md)
- [Programmatic API](./programmatic-api.md)
- [FAQ](./faq.md)
