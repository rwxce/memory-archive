---
description: Split a feature into single-topic PRs before writing any code
---
Decompose a feature into **single-topic PRs before writing a single line of code** — a map of
topics, real dependencies, and merge waves, so that no PR is born large or ends up as a stack.

Use it **before** creating the branch. It is the pre-code mode of the `pr-scope` skill;
`/pr-precheck` is the pre-PR mode and `/pr-triage` the open-PR mode.

**Input**: `$ARGUMENTS` — the feature description (a sentence or a paragraph). If empty, ask
for it and stop.

**Instructions**:

- Use the `pr-scope` skill, pre-code mode (`.rulesync/skills/pr-scope/references/pr-scope.md` §6.0).
- Read-only: read files, `git grep`/`grep` to locate the affected files, `git log` if needed.
  Do **not** write any repo file, create branches, or run `gh`.
- Reply in the user's language; PR titles and the plan in English. If the feature is too big
  for one PR, say so in the first line.

**The procedure, summarized** (full detail in §6.0):

```
1. Topics. Decompose the feature into demonstrable outcomes, not layers (domain / db / UI are
   not topics; "re-importing the same export adds no duplicates" is). For each topic:
     - PR title in conventional-commit format, WITHOUT "and" — if you need it, it is two topics
     - one-sentence outcome: "after the merge, X happens / stops happening"
     - expected files and estimated size (files + lines, including tests)
     - new surface: table, column, migration, route, dependency, network host, backup-format
       field → flag `sensitive` if it touches the sensitive areas in §5 (data model and
       migrations, import idempotency, backup/restore format, OPFS storage, privacy/network)
     - lane: demonstrable (isolated UI/copy/docs, no shared contract change) or
       flow-sensitive (data model, migrations, importers, backup/restore, storage,
       privacy/network, CI/supply chain)
     - flow diagram: if the topic has flow logic (data layer, import/sync pipeline, or UI with
       state/interaction — wizard, form with validation, toggle with effects), add a short
       Mermaid `flowchart TD` block (3-8 nodes: input → decisions/steps → result). If the topic
       is purely visual (style, copy, static layout with no new state), add NONE — not even an
       empty one or a placeholder.
2. Dependencies. For each pair: REAL (without the other it does not compile or does not work)
   or ORDER (convenience only). Only a real dependency justifies a stack; the rest go against dev.
3. Waves. What can ship now against dev in parallel, what waits for what.
4. Hard rules:
     - topic > ~15 files or > ~800 lines → split it
     - title with "and" → split it
     - topic that depends on an open product decision → mark it `parked`; plan no code on top
     - data layer without UI is valid if the PR body says where the UI will live (the reverse is
       not: the UI cannot ship before the use case it calls)
5. Ask the user which topic to start with and propose the command to create the branch from the
   correct base (dev, or the branch of the topic it truly depends on). Stop here.
```

**Expected output** (in the conversation or session scratchpad, never in the repo):

1. A table: `# | PR title | outcome | key files | size | dep (real/order) | lane | sensitive`.
2. The dependency graph and the waves.
3. The `parked` topics and which decision unblocks them.
4. The final question: which one to start with.

**Hard rules (reminder)**:

- Do not write code or repo files. Code is written in a new session scoped to a single topic.
- Read-only `gh` is always allowed without asking; writes require explicit permission every
  time. Do not commit, push, or create branches.
- Do not invent real dependencies to justify a stack: if in doubt, it is ORDER and goes
  against dev.
