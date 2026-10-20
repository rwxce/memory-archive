---
description: Adversarially review your own diff before opening a PR, fixing what belongs and deferring the rest
---
Review your **own diff before opening the PR** in an adversarial loop, applying the fixes that
belong and freezing the scope for the rest — so the PR arrives with nothing to comment on and
later review does not make it grow.

Use it right before `/pr-make`.

**Input**: none (optionally the base branch; defaults to `dev`).

**Instructions**:

- Use the `pr-scope` skill, pre-PR mode.
- Follow the loop in the canonical document: `.rulesync/skills/pr-scope/references/pr-scope.md` §6.1.
- Round B of the loop checks against the empirical catalog:
  `.rulesync/skills/pr-scope/references/adversarial-review.md`.
- Round A reuses the existing checklists, **do not duplicate them**:
  - `.rulesync/skills/pr-review/references/pr-review.md`
  - `.rulesync/checks/memory-archive-review.md`
- Round C is a one-level coherence check: for each modified exported symbol, run
  `git grep -n "<symbol>"` to find its direct callers/importers and check they still match the
  change. Do not follow re-export barrels transitively.
- Reply in the user's language; finding blocks and follow-ups in English.

**The loop, summarized** (full detail in §6.1):

```
Pass 0 (mechanical): node scripts/check-pr-preflight.mjs, then pnpm check — stop if it blocks.
Round N (3 parallel subagents, at most 3 rounds):
  A. generic checklist · B. empirical catalog · C. coherence via git grep (one level)
  → classify with §2.0 (completion/extension) and §2 (in scope/deferred)
  → APPLY now the completion and in-scope fixes
  → DO NOT apply extensions: record them as deferred findings
Stop when a round adds nothing new, or after 3 rounds.
```

**Expected output**:

1. The baseline (`git diff --name-only origin/dev...HEAD`) and its metrics.
2. An explicit warning if the PR is already born too big (~15 files or ~800 lines).
3. For each round: what was found, what was classified as completion/in scope (and applied),
   and what as extension (and deferred).
4. The register (baseline + finding blocks for the deferred extensions), returned to the
   conversation or private scratchpad — never committed or posted as a comment/review. Only
   concise follow-ups go into the approved PR body of `/pr-make` (§3).
5. A final proposal of what stays in the initial PR and what is born as a follow-up PR.

**Hard rules (reminder)**:

- Only completions and in-scope findings are fixed in code. Extensions are **never** applied
  automatically: they are written as finding blocks in the register.
- Show each round's proposal before applying any fix; the user can stop the loop at any time.
- Do not run `git pull`, `merge`, or `rebase`.
- Read-only `gh` is always allowed without asking; writes require explicit permission every time.
- Do not post comments, inline findings, or reviews on GitHub.
- Do not commit or push.
- Never read or commit real WhatsApp exports or personal media; use synthetic fixtures only.
