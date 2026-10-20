---
title: npm packaging gaps
date: 2026-08-23
context: Surfaced while exploring "make the tool usable for any person" — grounding the CI/npm plan against current package.json.
---

# npm packaging gaps

`package.json` is close to publishable but missing a few fields the CI/npm publish depends on.

## Already good
- `name: "wa-backup"` — clear, available-style name.
- `bin: { "wa-backup": "dist/index.js" }` — correct global CLI entry after `tsup` build.
- `type: "module"` — ESM, matches the reusable-core intent.

## Gaps to close before first publish
- **No `files` field** — npm would publish the whole tree (incl. `.planning/`, `test/`, `lab/`).
  Add `files: ["dist"]` (or a `.npmignore`).
- **No `engines`** — pin the supported Node range (tool requires Node ≥ 22.12 for commander 15).
  Add `engines: { "node": ">=22.12" }`.
- **No `lint` script** — CI's "lint" step has nothing to run. Add a linter (ESLint flat config
  or Biome) and a `lint` script.
- **No `prepublishOnly`** — ensure `build` runs before publish so `dist/` is fresh.
- **No `repository` / `keywords` / `license`** — needed for a trustworthy public package.
- **Version `0.1.0`** — fine for pre-release; first tagged publish should be deliberate.
