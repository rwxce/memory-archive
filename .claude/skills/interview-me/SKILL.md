---
name: interview-me
description: >-
  Extract what the user actually wants before any plan exists, one question at a
  time with a guess attached, until you can predict their next three answers.
  Use when an ask is underspecified (missing who, why, success, or the binding
  constraint), when you catch yourself silently filling in requirements before
  the mandatory plan, or when the user says "interview me", "grill me", "are we
  sure?".
---
<!-- Adapted from addyosmani/agent-skills (skills/interview-me), MIT License © 2025 Addy Osmani. -->

# Interview me

What people ask for and what they want are different things. The cheapest moment to find
the gap is before the plan CLAUDE.md requires — once files are listed and an approach is
chosen, the user rationalizes the wrong thing into "good enough".

This skill sits **before** the plan. Its output is a confirmed statement of intent; the plan
(and `/pr-plan`, if the work spans several PRs) consumes it.

## When to use

- The ask is missing at least one of: **who** benefits, **why** now, what **success** looks
  like, what the binding **constraint** is.
- The ask is conventional ("add a dashboard", "make it faster") and you can't unpack it
  without guessing.
- Two reasonable values are in tension and the user hasn't picked one (simplicity vs.
  flexibility, cost vs. speed, ship now vs. do it right).
- The user invokes it explicitly.

**Don't use** for unambiguous asks (rename, typo, a known prop), pure questions ("how does X
work?"), when the user asked for speed over verification, or in non-interactive runs (`/loop`,
scheduled agents, CI) — there, flag the ambiguity as a blocker instead of guessing.

## Process

Ask in the language of the user's last message.

### 1. Hypothesize, with a confidence number

One sentence of what you think they want, plus an honest confidence (0–100%). Below ~70%,
say on the same line what's missing.

```
HYPOTHESIS: You want to find an old photo quickly across all archived chats, and "search"
was the convention that came to mind.
CONFIDENCE: ~35% — missing: whether you search by text, date or sender, and on which device
```

### 2. One question at a time, each with your guess

```
Q: <one focused question>
GUESS: <your answer hypothesis, and the reasoning behind it>
```

Wait for the reaction before the next question. People react to a wrong guess faster than
they generate an answer from scratch. Batched questions get skimmed, and question three
usually depends on the answer to question one. Be visibly willing to be wrong — occasionally
guess in a direction you expect pushback on, so agreement isn't just politeness.

### 3. Listen for "want vs. should want"

Watch for answers that sound like best practice instead of a choice: "scalable", "clean",
"the standard way", "I should probably…". Then ask:

> If you didn't have to justify this to anyone, what would you actually want?

Repo-specific probes, only when they apply:
- **Anything that stores, transforms or exports archive data** → must it survive a
  re-import, a backup/restore round-trip, and a sync ZIP from another device? (feeds
  `core-architect`'s data-contract check)
- **Any network access** (link previews, update checks, fonts, a CDN) → is the user willing
  to make it an explicit opt-in, off by default? The app is offline and local-only.
- **A new screen or user-facing copy** → which device first (phone or desktop), and can it
  ship in ca, es and en at once?
- **A new dependency** → can it be done without one? New deps need a justification and must
  be at least 7 days old.

### 4. Restate in their words

```
Here's what I now think you want:

- Outcome:      <one line>
- User:         <who benefits>
- Why now:      <what changed>
- Success:      <how we know it worked>
- Constraint:   <the binding limit>
- Out of scope: <what we're explicitly not doing>

Yes / no / refine?
```

"Out of scope" is mandatory — half of misalignment is silent disagreement about non-goals.

### 5. Confirm with an explicit yes

Not a yes: "whatever you think" (delegation — re-ask as a choice between two concrete
options), "sounds good" (ask "anything you'd refine?"), "ok let's start" after silence (they
gave up; ask what you missed). Fold corrections in and restate until you get a yes.

### 6. Stop

After the yes: deliver the confirmed intent, offer the next step (the written plan, or
`/pr-plan` if it spans several PRs), and **end the turn**. Don't start the plan or call tools
in the same turn.

**Stop condition:** you can predict the user's reaction to the next three questions you'd
ask. If several rounds pass and confidence isn't rising, say so: "I've asked N questions and
still can't predict your answers — something foundational is missing. Step back?"

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "The ask is clear enough" | If you can't write the outcome in one sentence now, it isn't. Do step 1 first. |
| "Questions waste their time" | Four targeted questions are cheap; a plan built on the wrong intent is not. |
| "I'll figure it out in the plan" | The plan locks in files and approach — that's exactly where a wrong guess gets expensive. |
| "They said 'whatever you think'" | That's delegation, not a decision. Offer two concrete options. |
| "Attaching my guess leads them" | Leading is the point; the risk is sycophancy. Be visibly willing to be wrong. |

## Red flags

- Two or more questions in one message.
- A question without your guess attached.
- A confidence below ~70% with no reason given.
- Writing the plan before the restate got an explicit yes.
- A restate without an "Out of scope" line.
- Three rounds without confidence visibly rising.
