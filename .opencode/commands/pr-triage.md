---
description: >-
  Triage an open PR's review comments against a frozen baseline and route
  out-of-scope findings to follow-ups
---
Triage an open PR: classify every review comment as **in scope** or **deferred** against a
frozen baseline, and route the deferred ones to follow-up PRs instead of growing the current PR.

**Minimum input**: PR number or URL. If `$ARGUMENTS` is empty, do not ask right away: first
check whether the current branch has an associated PR with `gh pr view --json number,url`
(read-only, always allowed). If it finds one, use it. If not (branch without an open PR, or
`gh` cannot resolve it), ask the user for the PR number or URL.

**Instructions**:

- Use the `pr-scope` skill, triage mode.
- Follow the process in the canonical document: `.rulesync/skills/pr-scope/references/pr-scope.md` (§1.2, §2, §6.2).
- Apply the hard rule **before** looking at severity: severity decides the urgency of the
  follow-up, never whether it goes into this PR.
- Once the completion/in-scope fixes are applied, verify them with the shared adversarial loop
  (§6.1, step 5 of §6.2) before closing the triage.
- Reply in the user's language; the register and follow-up titles in English.

**Expected output**:

1. Derived baseline and the boundary of the first review event.
2. Scope metrics: % reactive commits, review rounds, new files per round, scope growth.
3. A table of all findings with their verdict.
4. Split plan: deferred findings grouped into follow-up PRs by **technical dependency**, each
   group with a proposed title, grouping reason, and whether it blocks the merge.
5. Confirmation that the applied fixes were verified with the adversarial loop (§6.1), or
   "unverified" if the user stopped it before it finished.
6. Final recommendation: continue, or partial-merge-and-split if more than 3 rounds have passed.

**Hard rules (reminder)**:

- `gh api` always with `--paginate`. Without it the API truncates at 30 and the count is wrong.
- Read-only `gh` is always allowed without asking; writes require explicit permission every time.
- The register is returned to the conversation or private scratchpad, never as a repo file nor
  as a comment/review posted by an agent (§3). In code, only fixes classified as completion
  (§2.0) or in scope (§2).
- Do not post any comment, inline finding, or review on GitHub. The human reviewer must verify
  the analysis and write any feedback in their own words.
- Do not run `git pull`, `merge`, or `rebase`. Work with remote refs.
- Do not commit or push.
