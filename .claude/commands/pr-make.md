---
description: >-
  Create a pull request for the current branch (base dev by default). Never
  merges, never posts reviews.
---
Create a pull request from the current branch in `rwxce/memory-archive`. The user's request
(including invoking `/pr-make`) authorizes writing the complete title/body, committing and
pushing task changes if needed, and creating the PR. Complete this flow without asking for
another confirmation. Honor an explicit request for a preview only.

**Never merge** (not even with `--auto`), never edit another PR, and never publish comments
or reviews — the PreToolUse hook blocks those anyway.

## Step 1: Preflight — check `gh` CLI

Run `which gh`. If it's not installed, tell the user:

> `gh` CLI is not installed. Install it from https://cli.github.com/ then run `/pr-make` again.

Then **stop** — do not continue.

## Step 2: Parse arguments

Arguments: `$ARGUMENTS`

- If arguments contain `draft`, set the `--draft` flag on the PR.
- If arguments contain a word that is NOT `draft`, use it as the `--base` branch (e.g. the
  branch of a PR this one is stacked on).
- If no explicit base is given, the base is `dev`.
- **Guard (mandatory, before continuing):** `main` only receives `release: vX.Y.Z` PRs whose
  head is `dev`. If the base is `main` and this is not that release PR explicitly requested
  by the user, explain the rule and stop.

## Step 3: Gather context and prepare the branch

Inspect the current branch, worktree, staged changes, commits, and existing PRs:

```sh
git branch --show-current
git status --short
git diff
git diff --cached
git fetch origin <base>
git log origin/<base>..HEAD --oneline
git diff origin/<base>...HEAD
gh pr list --repo rwxce/memory-archive --head <current-branch> --state open --json url,baseRefName,headRefName
```

Read relevant untracked task files as well. A failed fetch or GitHub lookup is a blocker,
not evidence that no changes or PR exist. Never commit or push directly on `dev` or `main`;
if a task branch is missing, report the blocker.

- Identify task changes from the conversation and the actual diff. Include generated files
  belonging to the task (e.g. rulesync outputs after a `.rulesync/` change). Leave unrelated
  work untouched; if task ownership is unclear, ask one focused question.
- Never stage real chat exports, `*.zip`, `_chat.txt`, `.env*`, or anything under
  `fixtures/`, `data/`, `output/`, `backup/`.
- Run `node scripts/check-pr-preflight.mjs` and `pnpm check` (plus `pnpm rulesync:check` if
  `.rulesync/` changed). Resolve task-related failures before publication; report genuine
  blockers. Never invent evidence or test results.
- If task changes are uncommitted, stage only the identified files/hunks, inspect the staged
  diff, and commit with an English conventional commit message. Do not use blanket staging
  or amend commits.
- Re-read the final `origin/<base>...HEAD` diff and commit list. All commits that would be
  published must belong to the task. If there is no task diff and no existing PR, report
  that there is nothing to open and stop.
- If an open PR exists for this branch and the intended base, push any pending task commits
  with a normal push, then return its URL without creating a duplicate or editing its body.
  If its base differs, report the mismatch rather than retargeting or duplicating it.
- Push with `git push -u origin <current-branch>`. Never force-push; report a rejection as a
  blocker.

For a preview-only request, gather context and prepare the proposed title/body without
committing, pushing, or creating the PR.

## Step 4: Generate PR title

From the diff, infer a conventional commit type: `feat`, `fix`, `refactor`, `chore`, `docs`,
`test`, `style`, `perf`, optionally with a scope (`chore(ai): ...`).

Write a concise title: `type(scope): short description` (lowercase, no period, under 70 chars).

## Step 5: Generate PR body

Follow `.github/pull_request_template.md` exactly:

````
## What
2-3 sentences: what changed and why.

## Flow and failure modes
Entry point, data/effects, and failure behavior, grounded in the actual diff. For a
data-layer change (importers, fingerprints, schema/migrations, storage, backup/sync format),
state explicitly what happens on re-import, on failure mid-way, and to existing archives.
For docs/tooling-only changes, say what readers or developers see and any consistency risk.
Add a short Mermaid `flowchart LR` (3-6 plain-language boxes) when the change has a flow.
Write this section yourself; never leave a placeholder.

## Evidence
UI: screenshots (375 and 1440 px). Non-visual: relevant command output.

## Tests
Commands and manual scenarios actually run.

## Follow-ups
Out-of-scope findings, or `None`.
````

End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Step 6: Check the final content

Ensure every section is complete and grounded in the final diff. Report only checks
actually run; explicitly state checks not run. Title, body, and commit messages in English.

## Step 7: Create the PR

Check again for an open PR for the current branch before creating one. Do not blindly retry
a failed creation: look up the branch first so a partial success does not create a duplicate.

Write the body to a temporary Markdown file and pass it with `--body-file`:

```sh
gh pr create --repo rwxce/memory-archive --title '<title>' --body-file <body-file> --base <base> --head <current-branch> [--draft]
```

Output the PR URL. Creating the PR does not authorize merging, editing an existing PR, or
publishing comments/reviews.
