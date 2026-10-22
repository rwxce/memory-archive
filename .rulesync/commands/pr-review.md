---
description: Private, security-first review of a pull request based on its real diff
targets:
  - '*'
---
Private review of a pull request with professional, security-first judgment, based **on the real
diff** of the PR and without modifying local code.

**Minimum input**: PR URL. If none is given, do not ask for it right away: first check whether the
current branch has an associated PR with `gh pr view --json number,url` (read-only, always
allowed). If one is found, use it. Otherwise, ask the user which PR to review.

**Instructions**:

- Use the `pr-review` skill.
- Follow the process and checklists in the canonical document:
  - `.rulesync/skills/pr-review/references/pr-review.md`
- Apply the project checklist: `.rulesync/checks/memory-archive-review.md`.

**Hard rules (reminder)**:

- Do not modify code or files.
- Do not run `git pull`, `merge` or `rebase`.
- Work with remote refs (`origin/<baseRef>` and `origin/<headRef>`).
- Do not comment on anything outside the PR diff.
- Never post comments, inline findings or reviews to GitHub (a hook blocks `gh pr comment`,
  `gh pr review` and mutating `gh api` calls). Return the full analysis to the conversation or a
  private scratchpad so a human can verify it and write their own review.
- Do not report nits, style preferences, adjacent refactors or speculative asks.
- Reply in the user's language; write any artifacts in English.
- **Detect the PR review lane** (demonstrable / flow-sensitive) before deciding review depth; see
  §2 of `references/pr-review.md`.
