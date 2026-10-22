# File Formats (condensed for this repo, rulesync 33.0.0)

The upstream reference covers 50+ tools and is ~800 KB. This page keeps only what matters
for this repo's targets (`claudecode`, `codexcli`, `cursor`, `opencode`). For anything else,
read the full, version-matched text:

```bash
pnpm exec rulesync docs reference/file-formats
```

## Source paths (v33)

| Feature | Source | Notes |
|---|---|---|
| rules | `.rulesync/rules/*.md` | One `root: true` rule becomes `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/*.mdc` |
| commands | `.rulesync/commands/*.md` | Codex CLI commands are global-only (`~/.codex/prompts`), so this repo doesn't generate them for codexcli |
| subagents | `.rulesync/subagents/**/*.md` | Subdirectories are loaded too; Markdown without valid frontmatter is skipped with a warning |
| skills | `.rulesync/skills/<name>/SKILL.md` + supporting files | Copied to `.claude/skills/`, `.cursor/skills/`, `.agents/skills/` (Codex), `.opencode/skills/` |
| hooks | `.rulesync/hooks.jsonc` (recommended) or legacy `hooks.json` | JSONC wins when both exist |
| mcp | `.rulesync/mcp.jsonc` (recommended) or legacy `mcp.json` | JSONC wins when both exist |
| permissions | `.rulesync/permissions.jsonc` (recommended) or legacy `permissions.json` | |
| ignore | `.rulesync/.aiignore` | **Deprecated** in favor of `permissions` `read` denies |
| checks | `.rulesync/checks/*.md` | Cursor collapses every check into `.cursor/BUGBOT.md` |

## Rules frontmatter

```md
---
root: true            # exactly one root rule
targets: ['*']
description: "..."
globs: ['**/*']
cursor:               # optional
  alwaysApply: true
  globs: []           # [] next to alwaysApply avoids Cursor's glob conflict
---
```

## Commands frontmatter

```md
---
description: "Short description"
targets: ['*']
---
Body using Claude Code syntax: $ARGUMENTS, !`cmd`. Rulesync translates per tool.
```

## Subagents frontmatter

```md
---
name: core-architect
targets: ['*']
description: >-
  When to use this agent.
claudecode:
  model: sonnet        # opus | sonnet | haiku | fable | full id | inherit
  color: blue
  memory: project      # user | project | local
  # also: tools, disallowedTools, permissionMode, maxTurns, skills, effort, isolation, ...
opencode:
  mode: subagent       # default
---
```

## Skills frontmatter

```md
---
name: my-skill
description: >-
  What it does and when to use it.
targets: ['*']
# optional: disable-model-invocation, user-invocable, license, compatibility, metadata,
# plus per-tool sections (claudecode:, codexcli:, ...)
---
```

## hooks.jsonc

```jsonc
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "type": "command", "matcher": "Bash", "command": "...", "timeout": 10, "failClosed": true }],
    "stop": [{ "type": "command", "command": "..." }],
    "sessionEnd": [{ "type": "command", "command": "..." }]
  },
  "claudecode": { "hooks": { /* Claude-only events */ } }
}
```

- Events are canonical camelCase; Claude Code / Codex get PascalCase, Cursor uses them as-is,
  OpenCode gets a generated JS plugin (`.opencode/plugins/rulesync-hooks.js`).
- `failClosed` is only emitted where the tool supports it (Cursor here). Claude Code and
  Codex block only on exit code 2 — so a guard script must exit 2 to block.
- OpenCode does not support `sessionEnd` (skipped with a warning). OpenCode's plugin runs the
  command without piping the tool payload on stdin, so stdin-reading guards are inert there;
  rely on `permissions` denies for OpenCode.
- Commands starting with `./` are anchored to `$CLAUDE_PROJECT_DIR` for Claude Code. This
  repo uses `$(git rev-parse --show-toplevel)` instead, which works in every tool.
- `preserveUnownedHooks: true` in `rulesync.jsonc` keeps hand-added handlers (not used here).

## permissions.jsonc

```jsonc
{
  "$schema": "https://github.com/dyoshikawa/rulesync/releases/latest/download/permissions-schema.json",
  "permission": {
    "bash": { "gh pr view *": "allow", "gh pr comment *": "deny" },
    "read": { ".env": "deny", "data/": "deny" }
  },
  // Tool-scoped override: replaces whole categories for one tool.
  "codexcli": { "permission": { "bash": { "gh pr view *": "allow" } } }
}
```

- Actions: `allow` | `ask` | `deny`. Categories: `bash`, `read`, `edit`, `write`, `webfetch`,
  `websearch`, `grep`, `glob`, `notebookedit`, `agent`, `*`, MCP tool names.
- Codex CLI translates `bash` into `.codex/rules/rulesync.rules` `prefix_rule`s matching
  literal words; only a trailing standalone `*` works. Mid-pattern globs (`gh api * -f *`,
  `cat .env*`) are **dropped** for Codex with a warning — hence the `codexcli` block here.
  `read` becomes the Codex filesystem permission profile in `.codex/config.toml`.
- Claude Code: the `ignore` feature and `permissions` both write `Read(...)` denies into
  `.claude/settings.json` and overwrite each other, so `generate --check` never settles.
  This repo enables only `permissions` for claudecode.

## mcp.jsonc

```jsonc
{
  "$schema": "https://github.com/dyoshikawa/rulesync/releases/latest/download/mcp-schema.json",
  "mcpServers": {
    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@0.0.83"] }
  }
}
```

Written to `.mcp.json` (Claude Code), `.cursor/mcp.json`, `.codex/config.toml`,
`opencode.jsonc`.

## checks

```md
---
targets: ['*']
description: Short summary
severity: high        # low | medium | high | critical
---
Review instructions.
```
