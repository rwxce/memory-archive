---
name: pr-scope
description: Freeze the scope of a PR and route review findings that fall outside it to follow-up PRs, instead of growing the PR to cover them
---
# PR Scope (freeze the scope, route the rest)

Reply in the user's language; write all artifacts (PR titles, finding blocks, registers) in
English. Be direct: if the scope has blown up, say so plainly.

## Why this exists

Large PRs tend to grow through reactive review commits. Most of their commits arrive **after**
the first review comment, and the number of files touched for the first time never drops to
zero: every round opens new files, until the PR is closed unmerged or merged as something
nobody can review anymore.

The cause is neither bad faith nor carelessness. Reviewers find things that are true, but that
do not say "this is wrong" — they say **"this is inconsistent with something you did not
touch"**. Each one is irrefutable and each one is new work. Since rejecting them one by one is
impossible, they all get in and the PR diverges.

This skill is not about resisting findings. It is about **routing** them: saying "not here"
must leave a written record with acceptance criteria, so it never means leaving it unfixed.

## Mandatory principles

- Never expand a PR's scope to cover a finding outside the baseline.
- Never mark a finding as resolved without evidence in the diff.
- Never delete a finding: it is either resolved, deferred with its own block in the register,
  or discarded with a written reason.
- The register is **private**: it is returned to the conversation or the session scratchpad,
  never as a repo file nor as a comment/review posted by an agent on GitHub (§3).
- Severity does **not** override the scope rule. A P1 outside the baseline is deferred, not
  fixed here.
- Do not invent findings or severities: if the reviewer gave no badge, mark it as assigned by you.
- Read-only `gh` (`view`/`list`/`checks`/`diff`/`status`, `gh api` GET) is always allowed
  without asking. Writes (`pr create`, `push`, `merge`, `edit`, etc.) require explicit
  permission every time.
- Never post comments or reviews on GitHub, even if the user asks (a hook blocks it anyway); the
  human reviewer must understand the analysis and write any feedback in their own words.
- Do not write any file without first showing the proposal and waiting for approval.
- Privacy: never open, quote, or commit real WhatsApp exports or personal media while
  analysing a PR. Use only the synthetic fixtures.

## The three modes

| Mode | When | Command |
|---|---|---|
| **Pre-code** | Before creating the branch: split the feature into single-topic PRs | `/pr-plan <feature>` |
| **Pre-PR** | Before opening the PR, on your own diff | `/pr-precheck` |
| **Triage** | On an already-open PR with comments | `/pr-triage <PR>` |

Pre-code is the cheapest mode: a PR born with a single topic never needs splitting later.
Pre-PR is next: if review arrives after 5 commits, the loops cost hours; after 40, they cost
days. Split by **demonstrable outcome**, not by layer — a stack split into "domain / db / UI"
still mixes several topics in each part.

## The hard rule, in one sentence

A finding is fixed inside the PR **only if** the defect is in a file that was already in the
baseline **and** the fix creates no new surface (file, table, column, migration, route,
dependency, network host, backup-format field). Everything else is deferred.

## The exception that unblocks you

If the finding means the PR **as it stands** introduces an exploitable vulnerability, leaks
private data, adds an undeclared network call, or can corrupt or lose a user's archive, it is
not deferrable. But the correct response is to **remove the offending piece from the PR**, not
to grow the PR to defend it.

"I can't merge with a hole in it" is solved by removing the piece, not by adding 2,000 lines.

## Full reference

- Read and follow: `references/pr-scope.md`
