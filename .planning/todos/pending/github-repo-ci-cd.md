---
title: GitHub repo + CI/CD workflow
date: 2026-08-23
priority: high
---

# GitHub repo + CI/CD workflow

Make `wa-backup` installable and trustworthy for any terminal developer.

## Outcome
- A public GitHub repository for the project (currently local only — no remote exists).
- `.github/workflows/ci.yml` that runs, on every push/PR:
  1. **test** — `node --import tsx --test "test/*.test.ts"`
  2. **lint** — currently MISSING; a linter must be added first (no eslint/prettier in devDeps)
  3. **build** — `tsup` (produces `dist/`)
- A separate **publish** job triggered by a **Git tag / GitHub Release** that publishes to npm with **provenance** (`--provenance`, `id-token: write`).

## Notes / risks
- No linter is configured today — decide between ESLint (flat config) or Biome before wiring the lint step.
- No git remote yet; repo must be created and pushed.
- npm publish needs `NPM_TOKEN` (or `npm publish` via `id-token` OIDC provenance) stored as a GitHub secret.
- `package.json` already has `bin: { "wa-backup": "dist/index.js" }` — correct for a global CLI.
