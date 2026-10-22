---
name: pr-review
description: >-
  Professional, private PR review based on the real diff, prioritizing security
  and regressions, without touching local code
---
# PR Review (read-only)

Reply in the user's language; write any artifacts in English. Be direct. If something is serious,
say so plainly without softening it.

## Hard rules

- Do not modify code or files.
- Do not run `git pull`.
- Do not run `git merge` / `git rebase`.
- Do not do a destructive checkout if there are local changes.
- Work against remote refs: `origin/<baseRef>` and `origin/<headRef>`.
- Do not comment on files outside the PR diff.
- Never post comments, inline findings or reviews to GitHub. The review is private and ends up
  in the conversation or the session scratchpad. A human publishes any review in their own words.
- Read-only `gh` commands are always allowed.
- Do not report nits, style preferences, adjacent refactors or speculative asks.
- Do not invent problems: separate **facts**, **risks**, **hypotheses** and **opinions**.
- Priorities: security, regressions, architecture, maintainability.
- If critical information is missing, stop and ask for it.
- **Detect the review lane** (demonstrable / flow-sensitive) from the changed files, as defined in
  §2 of `references/pr-review.md`. Any sensitive file makes the whole PR flow-sensitive; if
  ambiguous, treat it as flow-sensitive.

## Minimum input

- PR URL

## Recommended flow (high level)

1) Repo preflight (confirm you are in the right repo) + `git status --short`
2) PR metadata via `gh pr view ... --json ...`, get `head.sha` and detect the lane
3) `git fetch origin <baseRefName> <headRefName>`
4) Review commits, changed files and stats (`git log`, `git diff --name-status`, `git diff --stat`)
5) Review by block (tooling/app/core/storage/tests/docs/AI), depth according to lane
6) Executive summary + findings by severity + final recommendation

## Output format

Use the private final format defined in `references/pr-review.md`.

## Full reference

- Read and follow: `references/pr-review.md`
- Project checklist: `.rulesync/checks/memory-archive-review.md`
