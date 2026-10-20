# PR Scope — canonical document

Full procedure to freeze a PR's scope and route the findings that fall outside it.
This file is the source of truth; `SKILL.md` is only its summary.

The catalog of concrete findings that the §6.1 loop searches for in round B lives in
`adversarial-review.md` — do not duplicate it here.

Branch model: feature branches target `dev`. `main` only receives `release: vX.Y.Z` PRs opened
from `dev`. There is no other long-lived branch.

---

## 1. The baseline

The **baseline** is the set of files the PR touched before anyone reviewed it. It is the
objective fact that turns "this is out of scope" into a check instead of an argument you will
lose every time.

### 1.1 Pre-PR mode (the PR does not exist yet)

```bash
git fetch origin <base>:refs/remotes/origin/<base>
git diff --name-only origin/<base>...HEAD
```

`<base>` is the real base of this branch — `dev` in the normal case, or the branch of the topic
this one truly depends on (§6.0). For a `release: vX.Y.Z` PR the base is `main`. The explicit
`origin/<base>:refs/remotes/origin/<base>` form is the robust one: with the default
`remote.origin.fetch` of a normal clone, `git fetch origin <base>` already updates
`refs/remotes/origin/<base>` as well as `FETCH_HEAD`, but that depends on the default
configuration — in a partial/shallow clone or with a custom `remote.origin.fetch` there is no
guarantee. Writing the destination ref explicitly removes the ambiguity at no cost.

This set is the baseline. Record it in the `baseline` block (§4.1) before opening the PR.

### 1.2 Triage mode (PR already open) — retroactive derivation

No saved state is needed: the boundary is derived from the API. It works on old PRs too.

```bash
# metadata
gh pr view <N> --json number,title,state,createdAt,baseRefName,headRefName,additions,deletions

# commits (for ordering reference, not for freezing the boundary by date)
gh api repos/<owner>/<repo>/pulls/<N>/commits --paginate \
  --jq '.[]|[.sha,.commit.committer.date,(.commit.message|split("\n")[0])]|@tsv'

# all feedback events — with the commit_id that was HEAD when they arrived
gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate \
  --jq '.[]|[.created_at,.user.login,.path,.id,(.commit_id // .original_commit_id)]|@tsv'
gh api repos/<owner>/<repo>/pulls/<N>/reviews --paginate \
  --jq '.[]|[.submitted_at,.user.login,.state,.commit_id]|@tsv'
gh api repos/<owner>/<repo>/issues/<N>/comments --paginate \
  --jq '.[]|[.created_at,.user.login]|@tsv'
```

**The boundary** is the oldest feedback event (by `created_at` / `submitted_at`) across all
three lists. But the baseline is **not** frozen by dates: a commit made before the first
comment but pushed *after* it keeps a `committer.date` earlier than the boundary, and a rebase
can invert the order. What does not lie is **which SHA was HEAD when that first feedback
arrived** — the `commit_id` (or `original_commit_id`) carried by the oldest comment/review.
That SHA is the boundary tip.

The **baseline** is the set of files touched between the PR base and that boundary SHA:

```bash
git fetch origin <headRefName>
# <boundary-sha> = commit_id of the first comment/review (not the commit with the oldest date)
git diff --name-only <pr-base-sha> <boundary-sha>
```

> Events from `issues/<N>/comments` (general, non-inline comments) carry no `commit_id`. If the
> very first feedback is one of those, take the `commit_id` of the first later *inline* event,
> or the last commit in the timeline before that general comment's `created_at` — the criterion
> is still "which SHA was the reviewer looking at", not the commit date.

> **`--paginate` is mandatory.** Without it the GitHub API truncates at 30 results and you get a
> wrong count, which silently corrupts every metric below.

### 1.3 Metrics to always compute

| Metric | How | What it means |
|---|---|---|
| % reactive | commits after the boundary / total commits | >70% = the review is driving the PR |
| New files per round | files commented on for the first time, grouped by day | if it does not trend to 0, the PR is **diverging** |
| Review rounds | feedback events separated by gaps > 4 h | >3 = the PR is too big to stabilize |
| Scope growth | current files / baseline files | >2x = it is no longer the same PR |

---

## 2.0 Completion vs extension

A distinction applied **before** §2, because the hard rule alone would misclassify a missing
piece of wiring that lives outside the baseline but is not optional (for example a new parser
format that is never registered in the format registry, or a new migration that is not added to
the migration list).

- **Completion** — without it, the code **already in the diff** does not work.
  → **Always in scope**, wherever the fix lives. It is not doing more; it is making what you
  already did work. Typical cases: a new importer or format not registered where it is looked
  up; a new DB migration not wired into the migration runner; a new field written by an
  exporter but not read by the matching importer (backup round-trip broken); a test mock or
  fixture out of sync with the current contract; a new synthetic fixture needed by the tests
  in the diff but not produced by `scripts/generate-fixtures.mjs`.
  → This is a **deliberate exception** to condition 2 of §2 (no new surface), limited to
  completions: required wiring can live outside the baseline and still be applied now. It is
  not a general loophole nor a contradiction of the hard rule — it only applies if the test
  below says "it breaks".
- **Extension** — the diff works, but something adjacent is left inconsistent.
  → **Deferrable**, follow §2. Typical cases: a UI label not yet translated into all three
  locales (ca/es/en) for an adjacent screen, a CLI flag that would be nice to mirror in the PWA,
  an exporter that could also emit the new field in Markdown, a related doc page now outdated.

**Test:** *"if I merge this alone, does it break or does it just look ugly?"* Breaks →
completion, fix it now even outside the baseline. Ugly → extension, apply §2.

Some completions can be detected mechanically without human judgment — see §2.5.

## 2. The hard classification rule

Apply it **before** looking at severity, and **after** checking §2.0 (a completion goes straight
to in scope). Severity only decides how urgent the follow-up is, never whether it goes into
this PR.

A finding is **IN SCOPE** (fixed now) only if **all three** hold:

1. The defect is in a file that is already in the baseline, **and**
2. the fix does **not** create any of: a new file, a new table / column / migration, a new route
   or page, a new dependency, a new network host or outbound call, a new field in the backup /
   export format, **and**
3. the fix does **not** force a change to user-facing privacy promises (what the app stores,
   where, and what leaves the device) beyond recording a fact that already exists.

If **any** of them fails — and it is not a completion per §2.0 — the finding is **DEFERRED**.

### 2.1 `blocker`

A deferred finding is marked `blocker: true` when merging this PR without resolving it would
leave `dev` in a worse state than now (for example an archive that can no longer be restored).
`blocker: true` does **not** mean "fix it here": it means **the follow-up PR must be opened and
merged before this one**.

This is what lets you say no to a P1 without leaving it unattended.

### 2.2 The exception: real holes

If the finding means the PR **as it stands** introduces an exploitable vulnerability, leaks
private data, adds an undeclared network call, or can corrupt or lose user data, it is not
deferrable with `blocker`. The correct action is to **remove the affected functionality from
the PR** (`verdict: descoped`), not to grow the PR.

Example: "the new import path can overwrite existing messages on re-import" is solved by
removing the overwrite path (or the new importer) from the PR, not by building a full merge
and conflict-resolution layer inside the same PR.

### 2.3 Round limit

If P1s inside the baseline are still appearing at **round 3**, the problem is not the code but
the size. Action: merge what is green, new branch for the rest. Say so explicitly in the summary.

### 2.4 Quick decision table

| The reviewer asks for… | Verdict |
|---|---|
| Fixing logic in a baseline file | **in-scope** |
| Adding a test for baseline code | **in-scope** |
| A new column / table / migration | **deferred** |
| A page or route that does not exist | **deferred** |
| Migrating to a different library | **deferred** |
| Translating a new surface into ca/es/en | **deferred** |
| A new dependency or network host | **deferred** (and flag as privacy-sensitive) |
| A new field in the backup / export format | **deferred** |
| Refactoring a file outside the baseline | **deferred** |
| Removing a false promise from the product | **in-scope** (remove, don't build) |
| Defending a feature with a hole by adding code | **descoped** — remove the feature |
| Unregistered importer/format, unwired migration, broken export/import round-trip, stale mock | **in-scope (completion, §2.0)** |

### 2.5 Mechanical completion detection (no human judgment needed)

Some frequent problems are caught mechanically before the loop:

- **Branch/base, `.gitignore`/`.env` safety, diff size** → `node scripts/check-pr-preflight.mjs`.
- **Type-level wiring gaps** (a new variant not handled in an exhaustive `switch`, a changed
  signature not propagated) → `pnpm check` (lint → typecheck → test → build).
- **Broken round-trips and parser regressions** → the `node:test` suite under `test/`, run
  against the synthetic fixtures.

The adversarial loop (§6.1) still finds these in round B, but mechanical detection is cheaper
and arrives earlier (in the editor, or in Pass 0 of the loop).

---

## 3. Output structure

**The register is private: conversation or session scratchpad, never GitHub nor repo files.**

Committing the register inside the PR (for example a `reviews/` folder) is explicitly rejected:
the scope register of a PR would pollute the very diff it analyses. A skill that exists to stop
scope growth cannot be a source of it.

The private output keeps this structure:

```
# Scope and review register — PR #<N>

## Index           internal links to each block
## Triage          boundary, metrics (§1.3), verdict table, split plan
## Baseline        frozen file list
## Findings        one block per deferred, discarded, or descoped finding
```

Format rules:

- Each finding keeps an id `fNN-slug` and the frontmatter from §4.2.
- The full register is returned to the user, but not written as ready-to-paste GitHub text:
  the human reviewer must understand, verify, and rephrase it.
- **Findings resolved inside the PR get no block of their own** — they only appear in the
  verdict table. One block per comment would bury what matters, which is the plan.

In **pre-PR mode**, concise follow-ups may go into the `## Follow-ups` section of the PR body
that `/pr-make` shows and the user approves before creating it. The detailed register stays in
the conversation or scratchpad and is never committed or published automatically.

**Updates.** A later round returns a new private version with the verdict history. It never
creates or edits GitHub comments.

---

## 4. Block format

The names `baseline` / `fNN-<slug>` are **logical block names** inside the private output, not
files.

### 4.1 "Baseline" block

```markdown
# Baseline — PR #<N>

- Base: `dev` · Head: `feat/whatsapp-ios-date-formats`
- Boundary (first review event): `<ISO timestamp>`
- Commits before the boundary: 3 (`abc1234`…`def5678`)

## Baseline files
- src/parse/formats.ts
- src/parse/index.ts
- test/parse.test.ts

## Metrics
| Metric | Value |
|---|---|
| % reactive commits | 60% |
| Review rounds | 2 |
| Scope growth | 3 → 5 files (1.7x) |
```

### 4.2 "Finding" block — `fNN-<slug>`

```markdown
---
id: f01
severity: P1                 # reviewer badge; if human without badge, "P?-assigned"
risk: data-integrity         # privacy | security | data-integrity | product | docs
verdict: deferred            # deferred | discarded | descoped
blocker: true                # the follow-up PR goes before this PR's merge
source: https://github.com/rwxce/memory-archive/pull/<N>#discussion_r...
reviewer: <login>
files:
  - src/parse/formats.ts
followup: FU-1               # group in the split plan, or "—"
---

## Finding
Literal quote from the reviewer, not reinterpreted.

## Why it is out of scope
Which of the three hard-rule conditions fails, with concrete evidence
(`file:line`, or "this file is not in the baseline").

## Acceptance criteria
What must be true for it to count as resolved. Verifiable, not an intention.

## Verification
A concrete test or command that proves it.
```

For `verdict: discarded`, replace "Why it is out of scope" with **"Why it is discarded"** and
the technical reason. Discarding without a written reason is not an option.

### 4.3 "Triage" block — the split plan

```markdown
# Review scope — PR #<N> · feat: import WhatsApp exports into SQLite

## Status
Baseline 8 files → 22 current (2.75x) · 4 rounds (limit 3 exceeded) · 75% reactive commits.
**Recommendation: merge what is green and split the rest.**

## Findings
| id | severity | risk | verdict | goes to |
|---|---|---|---|---|
| — | P2 | product | resolved in the PR | commit abc1234 |
| f01 | P1 | data-integrity | deferred (blocker) | FU-1 |
| f02 | P2 | privacy | deferred | FU-2 |
| f03 | P2 | docs | discarded | — |

## Split plan

### FU-1 — `fix: make re-import idempotent by message hash` · blocks the merge
Findings: f01, f04, f07
Grouping reason: all touch the `messages` table schema and the same migration; splitting them
would require two migrations on the same table.
Estimated size: 1 schema file + 1 migration + 2 tests.

### FU-2 — `feat: strip EXIF location from imported media` · does not block
Findings: f02, f05
Reason: depends on FU-1 (needs the stable media ids). Open it after FU-1 is merged.

## Discarded
- **f03** — the reviewer asked to document a field that is already documented in the
  backup-format reference.
```

---

## 5. Sensitive areas

Findings with `risk: privacy`, `risk: security`, or `risk: data-integrity` deserve explicit
attention in the summary, because this app holds people's private conversations and runs
fully offline. The sensitive areas are:

- **Data model and migrations** (`lib/domain/`, `lib/db/`) — schema changes, backfills,
  migrations that must run on archives created by older versions.
- **Import idempotency** (`lib/importers/`, today `src/parse/`, `src/extract.ts`,
  `src/media.ts`) — re-importing the same export must not duplicate or overwrite data.
- **Backup / restore format** (`lib/exporters/`, sync ZIPs, today `src/render/`, `src/csv.ts`)
  — every field written must be readable back; format changes need versioning.
- **Storage** (OPFS, SQLite WASM in `lib/storage/`) — quota, partial writes, persistence.
- **Privacy / network** — no telemetry, no network calls except explicit opt-in, no real
  personal data in fixtures, logs, or commits.

Rules:

- A product decision in one of these areas (backup format versioning, what is stored, any
  network access) is decided by the user, not by you. If a deferred finding requires such a
  decision, mark it `blocker: true` and say so in the summary.
- The private block is the record. If the user wants persistent tracking, they open a GitHub
  issue themselves; agents do not post it. Never cite an invented permalink or a `reviews/…`
  path: those artifacts do not exist.

---

## 6. Execution flow

### 6.0 `/pr-plan <feature>` — before writing code, map the PRs

Goal: no PR is born with more than one topic. §6.1 detects a large PR once the diff exists;
here the diff is prevented from mixing anything. Read-only (`git log`, `git grep`, `grep`,
reading files); it writes no repo files, creates no branches, runs no `gh`.

```
1. Topics — decompose by demonstrable OUTCOME, not by layer.
   "Domain", "db", "UI" are not topics. "Re-importing the same export adds no duplicates" is.
   For each topic: PR title (conventional commit, without "and"), one-sentence outcome
   ("after the merge, X happens / stops happening"), expected files, estimated size,
   new surface (table, column, migration, route, dependency, network host, backup-format
   field → flag `sensitive` if it touches §5), lane:
     - demonstrable   = isolated UI / copy / docs with no shared contract change
     - flow-sensitive = data model, migrations, importers, backup/restore, storage,
                        privacy/network, CI / supply chain

2. Dependencies — for each pair of topics:
   REAL   → without the other it does not compile or does not work. Justifies a stack.
   ORDER  → convenience or chronology only. Goes against dev, in parallel.
   If in doubt, it is ORDER. Stack only when the dependency is real.

3. Waves — what ships now against dev, what waits for which merge.

4. Hard rules:
   - topic > ~15 files or > ~800 lines → split it (same threshold as step 0 of §6.1)
   - title with "and" → split it
   - topic that depends on an open product decision → `parked`; no code on top until it is
     resolved (a product disagreement is not closed with a commit)
   - data layer without UI is valid if the PR body says where the UI will live; UI without
     the use case it calls is not

5. Ask which topic to start with and propose the branch from the right base
   (dev, or the branch of the topic it truly depends on). Stop here: the code is written in a
   new session scoped to that topic, and that session ends with /pr-precheck.
```

Output: topic table, graph + waves, parked topics with the decision that unblocks them, and the
final question. In the conversation or scratchpad; never in the repo.

Signs that the map was skipped (and that you should stop and draw it retroactively): titles like
"Part N of #X", "Merge risk — please read" sections in the body, `fix: pr-precheck round N`
commits touching more than 5 files, a `feat` and its `revert` in the same PR, or a body that
spends more lines on "deliberately not in scope" than on what is in it.

### 6.1 `/pr-precheck` — before opening the PR, adversarial loop

Goal: the PR arrives with nothing left to comment on. A single pass does not get there —
round 1 fixes often create round 2 findings (the same loop that grows PRs under review,
applied here deliberately and with a limit). That is why it is a loop, not a checklist.

This loop (Round N) is used both by `/pr-precheck` (from scratch, with Pass 0 first) and by
step 5 of `/pr-triage` (§6.2, restricted to the files of an already-applied fix).

```
0. git status --short and git fetch origin dev.
   Compute the baseline (§1.1). If it already exceeds ~15 files or ~800 lines, warn before
   continuing: the PR is born too big and is better split now.

Pass 0 — mechanical (cheap, first, stops if it blocks):
   node scripts/check-pr-preflight.mjs
   pnpm check   (lint → typecheck → test → build)

Round N (3 parallel subagents; at most 3 rounds):
   A. Generic checklist → .rulesync/skills/pr-review/references/pr-review.md
                          + .rulesync/checks/memory-archive-review.md
   B. Empirical catalog → adversarial-review.md, every class against the diff
   C. Coherence         → for each exported symbol modified in this round:
         git grep -n "<symbol>" -- src lib app components hooks viewer cli test
      Keep only direct callers/importers (one level; do not follow re-export barrels
      transitively). Check that each caller still matches the new signature, return shape,
      error behaviour, and semantics.

   Route subagents by area when useful: core-architect for the data layer (domain, db,
   storage, importers, exporters, usecases; today src/parse, src/csv.ts, src/media.ts,
   src/extract.ts), testing-expert for test gaps, responsive-ui-designer for UI.

   Consolidate the three → classify each finding with §2.0 and §2:
     - completion            → apply the fix now, even if the file is not in the baseline
     - in scope (§2)         → apply the fix now
     - deferrable extension  → do NOT apply. Write its finding block (§4.2), do not touch code.

   Repeat if this round applied any fix. Stop when a round adds nothing new, or after 3
   rounds (if something in scope still appears in round 3, say so: the problem is the PR's
   size, not a missing round — see §2.3).

Final:
   Write the register (§3) to a temporary file OUTSIDE the repo — the session scratchpad.
   Propose: what stays in the initial PR and what is born as a follow-up PR.
   Stop. The user decides. Pass only concise follow-ups into the approved PR body of
   /pr-make. Do not post comments or reviews on GitHub.
```

Loop rules:
- Round C is a one-level `git grep`. An empty result means "no textual callers found", not
  "verified": dynamic access, string-based registries, and re-exports can hide callers. If in
  doubt, read the registry or barrel file explicitly.
- Subagents receive **the concrete files of the diff**, never the whole repo.
- Fixes that turn out to be **extensions** are never applied automatically: they are written as
  finding blocks for the user to decide, following §3 and §4.

### 6.2 `/pr-triage <PR>` — on an open PR

1. Preflight: correct repo, clean `git status --short`.
2. Derive the baseline and the boundary (§1.2). Compute the metrics (§1.3).
3. Read **all** comments with `--paginate`, and keep the unresolved ones. Resolved threads are
   queried via GraphQL `reviewThreads { isResolved }`.
4. Classify each one with the hard rule (§2). Apply only completions (§2.0) and in-scope fixes.
   Group the deferred ones into follow-up PRs by **technical dependency**, not by severity: the
   criterion is "what would force touching the same file or the same migration twice".
5. Verify the fixes step 4 just applied with the same §6.1 loop (Round N: subagents A/B/C,
   classify with §2.0/§2, apply completions and in-scope fixes, defer extensions), restricted
   to the files those fixes touched. Pass 0 is not repeated (it is a new-PR preflight). Stop
   when a round adds nothing new or after 3 rounds (§2.3).
6. Return the full proposal to the conversation or private scratchpad. Do not publish it on
   GitHub.
7. If there are privacy, security, or data-integrity risks, call them out per §5.
8. Final summary with the recommendation: continue, or partial-merge-and-split if the round
   limit was exceeded.

## 7. Hard execution rules

- Do not modify product code from these commands, except fixes classified as completion (§2.0)
  or in scope (§2), which is precisely their job.
- **No register file inside the repo.** If you need it on disk while drafting, it goes to the
  session scratchpad, never to a versioned path.
- Do not post comments, inline findings, or reviews on GitHub. The `gh` commands in this flow
  are read-only.
- Do not run `git pull`, `merge`, or `rebase`.
- Read-only `gh` is always allowed without asking; writes require explicit permission every time.
- Do not commit or push automatically.
- Never read, quote, or commit real WhatsApp exports or personal media; use synthetic fixtures.
- If critical information is missing (the real base, which threads are resolved), stop and ask.
