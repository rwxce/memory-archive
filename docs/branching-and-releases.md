# Branching and releases

## Branches

| Branch | Purpose | Accepts |
| ------ | ------- | ------- |
| `main` | Released versions only. Every commit is `release: vX.Y.Z` and has a matching tag. | PRs from `dev` titled `release: vX.Y.Z` (enforced by `branch-policy-guard.yml`). |
| `dev` | Integration branch and repository default. Full history lives here. | Squash-merged PRs from any feature branch. |
| feature branches | One topic per PR (`feat/…`, `fix/…`, `chore/…`, `docs/…`, or Conductor's `<user>/…`). | — |

## Day to day

1. Branch from `dev`.
2. Open a PR into `dev`; CI runs `pnpm check`.
3. Squash-merge when green and reviewed.

## Releasing

1. Bump `version` in `package.json` on `dev` (semver; still `0.x` until the Memory Archive app
   reaches its first complete release).
2. Open a PR `dev` → `main` titled exactly `release: vX.Y.Z`.
3. **Squash-merge** it. `main` gets one commit: `release: vX.Y.Z (#N)`.
4. `release.yml` runs on the push to `main`:
   - reads the version from the commit subject (fails if it does not match);
   - strips the `Co-authored-by:` trailers GitHub's merge button adds: it recreates the commit
     with the PR title and body only (same tree, parent and author) and force-pushes `main` with
     a lease (`scripts/clean-release-message.mjs`). A release PR lists all of `dev`'s older
     commits (see History), so the web button would otherwise credit every author found there;
   - creates the tag `vX.Y.Z` and a GitHub Release with generated notes;
   - back-merges `main` into `dev` with `git merge -s ours`, so `dev` keeps `main` as an
     ancestor.

5. `pages.yml` also runs on the push to `main` and publishes the build to GitHub Pages at
   `https://rwxce.github.io/memory-archive/` (built with `NEXT_PUBLIC_BASE_PATH=/memory-archive`).
   `dev` is never deployed.

No release bot is needed. A GitHub App would only be required if `dev` became a protected
branch that rejects the workflow's push, or if CI had to run on automatically created PRs.

## History

On 2026-10-20 `main` was reset to a single commit, `release: v0.1.0` (tag `v0.1.0`), with the
same content as the last wa-backup-era commit. The full previous history (upstream
guionardo/wa-backup + this fork) is on `dev`, and the old `main` tip is preserved as the tag
`pre-cleanup-main`. Because main was rewritten, `dev`'s commits from before the reset are not
reachable from `main`, and every `dev` → `main` PR lists them (GitHub shows up to 100). That is
harmless for the squash (the content diff is right) and the release workflow cleans the trailers.
