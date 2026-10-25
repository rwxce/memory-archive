---
description: Full autopilot release - commit, PR to dev, fix CI until green, merge, bump version, release PR dev to main, merge it, watch the release and deploy, leave the worktree on dev.
---
Ship the current task in `rwxce/memory-archive` all the way to a published release, on full
autopilot: do not stop to ask for confirmation between steps. Invoking `/pr-ship` is the user's
explicit authorization for this whole flow: committing and pushing task changes, creating PRs,
pushing CI fixes, squash-merging PRs into `dev`, and **squash-merging the `release: vX.Y.Z` PR
into `main`**. Stop only on a genuine blocker (Step 3.5, a merge conflict you cannot resolve
safely, a rejected push, missing permissions) and report it.

Never publish comments or reviews (the PreToolUse hook blocks them), never force-push, never
bypass branch protection or `--admin`-merge, and never weaken or skip a test just to turn CI
green.

Arguments: `$ARGUMENTS` — optional `patch` | `minor` | `major` (version bump), and/or
`no-release` (stop after merging into `dev`), and/or `no-main` (stop with the release PR open
and green, unmerged).

## Conductor worktree rule

Conductor deletes a workspace when the branch it has checked out is deleted. Before every
`gh pr merge --delete-branch`, switch this worktree **off** the PR's branch first (e.g.
`git switch -c <next-branch> origin/dev`). Never rename the workspace's placeholder branch.

## Step 1: Preflight

- `which gh` (stop with install instructions if missing); `git fetch origin`.
- `git branch --show-current`, `git status --short`. Never commit on `dev` or `main`.
- If the current branch is the workspace placeholder (not a `feat/`, `fix/`, `chore/`,
  `docs/`, `refactor/`, `test/` branch) or already merged, create a task branch from it with a
  conventional prefix derived from the change: `git switch -c feat/<slug>`.

## Step 2: Open the task PR

Follow `/pr-make` (`.rulesync/commands/pr-make.md`) Steps 3-7 exactly, base `dev`: stage only
task files (never `research/`, `data/`, `output/`, `backup/`, `fixtures/`, `*.zip`,
`_chat.txt`, `.env*`), run `node scripts/check-pr-preflight.mjs`, `pnpm check` (and
`pnpm rulesync:check` if `.rulesync/` changed), commit, push, and create the PR with the
template body. If the work mixes clearly unrelated topics, say so; still ship it as one PR only
if the user asked for that.

## Step 3: CI loop (used for every PR in this command)

1. `gh pr checks <n> --repo rwxce/memory-archive --watch --interval 30` (wait for completion;
   if checks have not started yet, wait and retry).
2. All green: continue.
3. A failure: `gh run view <run-id> --repo rwxce/memory-archive --log-failed`, then follow the
   `debugging` skill: reproduce locally when possible, fix the root cause, run `pnpm check`,
   commit `fix(ci): <what>` (or a precise type) to the PR's branch, push, and go back to 1.
4. A failure that also happens on `dev`, or a timing/flaky test: rerun the failed job once
   (`gh run rerun <run-id> --failed`). If it fails again, fix it properly (in this PR if small
   and related; otherwise in a separate `fix/` PR into `dev`, which then goes through this loop
   and gets merged first).
5. At most 3 fix attempts per PR. Then stop and report the failing check, the log excerpt and
   what was tried. Never mark a check as passing that did not pass.

## Step 4: Merge the task PR into dev

Switch off its branch (worktree rule), then
`gh pr merge <n> --repo rwxce/memory-archive --squash --delete-branch`. Confirm it is merged
(`gh pr view <n> --json state,mergeCommit`). If `no-release` was passed, report and stop.

## Step 5: Version bump PR

- `git fetch origin && git switch -c chore/bump-vX.Y.Z origin/dev`.
- Choose the bump: the argument if given; otherwise `minor` if any commit on `origin/dev`
  since the last `vX.Y.Z` tag is a `feat`, else `patch` (`major` only when asked). Still `0.x`.
- Update `version` in `package.json` and `GENERATOR_VERSION` in
  `lib/exporters/legacy/version.ts` (a sync test enforces it). `pnpm check`.
- Commit `chore: bump version to X.Y.Z`, push, PR into `dev` with that title, run the CI loop,
  switch off the branch, squash-merge with `--delete-branch`.

## Step 6: Release PR (dev → main)

- `gh pr create --repo rwxce/memory-archive --base main --head dev --title 'release: vX.Y.Z'`
  with a short body listing the user-visible changes since the last release (from the merged
  PR titles) and the attribution line. `branch-policy-guard.yml` rejects any other head or
  title.
- Run the CI loop on it. Fixes never go to `dev` directly: open a `fix/` PR into `dev`, ship
  it through Steps 3-4; the release PR updates itself.

## Step 7: Check out dev, then merge the release

- `git switch dev && git pull --ff-only origin dev` (if `dev` is checked out in another
  worktree, use a fresh branch from `origin/dev` instead and say so). The release PR's head is
  `dev`, so Conductor shows it here.
- Unless `no-main` was passed: `gh pr merge <n> --repo rwxce/memory-archive --squash` (never
  `--delete-branch`: `dev` is permanent).
- Watch `release.yml` and `pages.yml` for that push to `main` (`gh run list --branch main`,
  `gh run watch <id>`). A failure there is a blocker: read the log, report it, and fix it
  through a `fix/` PR into `dev` plus a new patch release only if the cause is clear.
- Confirm: tag `vX.Y.Z` and the GitHub Release exist (`gh release view vX.Y.Z`), Pages
  deployed, and `origin/dev` contains the back-merge (`git merge-base --is-ancestor
  origin/main origin/dev`). Then `git pull --ff-only origin dev`.

## Step 8: Report

Short summary: PR numbers and URLs, what each CI loop fixed (or that it was green), the
version, the release and deploy result, and the live URL
(`https://rwxce.github.io/memory-archive/`). Note honestly that `dev` is never deleted, so
whether Conductor archives this workspace after the release depends on Conductor, not on this
command. List anything not verified (e.g. the live site not opened).
