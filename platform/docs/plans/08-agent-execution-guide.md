# Agent Execution Guide (orchestrator + Sonnet-4.6 executor)

How to run [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md) with an **orchestrator** (assigns + reviews)
driving a **Sonnet-4.6 executor** (writes code + tests per task). The orchestrator never lets a
task advance until it passes that task's Definition of Done.

## Roles & responsibilities

**Orchestrator (the reviewing agent):**
- Owns the plan: picks the next task in sequence, assembles its context bundle, dispatches it.
- **Critically reviews every completed task — assumes nothing is done until proven.** Re-runs
  `npm test` / `npx tsc --noEmit` / `npm run lint` itself (does not trust "tests pass"); confirms a
  test **fails without** the change and **passes with** it; checks DRY (was an existing helper
  reused?), YAGNI (scope creep / unrelated files?), `clientId` scoping, no secrets, conventional
  commit. For DB-affecting work, requires **evidence from a real-DB run**, not just unit tests.
- **Rejects with specific, quoted feedback** and re-reviews. Never rubber-stamps; never advances on
  a red, sloppy, or unverified task.
- **Escalates human gates** (the 9 decisions, migrations, UI sign-off, the #20 proxy) instead of
  letting the executor guess.
- Keeps the spec/gap-register honest: if the code contradicts the spec, the **code wins** and the
  spec is corrected.

**Executor (Sonnet-4.6):**
- Implements exactly the assigned task via TDD (RED→GREEN→REFACTOR), using only its context bundle.
- Runs tests/typecheck/lint; reports what it changed, what it tested, and any assumption it made.
- **Stops and asks — does not guess** — when the code contradicts the task or a "verify this" step fails.

**The contract:** the executor *produces*, the orchestrator *verifies*. A task is "done" only when
the orchestrator's review gate passes — **not** when the executor says it's done.

## The loop (per task, strictly sequential)

1. **Pick the next task** — tasks execute **top-to-bottom**; phases are dependency-ordered
   (P0→P8), and within a phase `X.0 Reconcile` runs first. Don't start a task whose dependency
   isn't merged.
2. **Assemble the context bundle** (below) and dispatch it to the executor with the task's *What*,
   *Key files*, *Test approach*, and *Definition of Done*.
3. **Executor does TDD**: failing test → implement → refactor → `npm test`/`tsc`/`lint`.
4. **Orchestrator reviews** against the checklist below. Accept, or return with **specific** fixes
   (quote the line). Re-review.
5. **Commit** (conventional message) and update the master-plan Status. Next task.

## Context bundle — what the executor must receive each task

**Always (every task):**
- [`../../AGENTS.md`](../../AGENTS.md) — the Next.js-15 warning.
- [`00-onboarding.md`](00-onboarding.md) + [`01-how-we-test.md`](01-how-we-test.md) — conventions + test design.
- The **task row + its phase's exit criteria** from the master plan.
- [`03-milestone-B-points-to-wallet.md`](03-milestone-B-points-to-wallet.md) — the **depth template**
  (shows the expected RED→GREEN→verify→commit shape).
- The **named code files** in the task's "Key files".

**Per phase — add the relevant spec sections + gap rows:**

| Phase | Spec to include | Gap rows |
|---|---|---|
| P0 | `04-architecture` | #1, #21 |
| P1 | `01` ctx 1–2 · `04` §3–4 | #2, #3, #20, #22, #23 |
| P2 | `01` ctx 3,4,6 · `03` B1 | #4, #11 |
| P3 | `00` glossary · `02` WF1 · `01` ctx 5 · `05` §5 | #9, #12, #13, #14, #15 |
| P4 | `02` WF5 · `01` ctx 7,8 | #6, #10 |
| P5 | `02` WF4 · `01` ctx 9,10 · `03` B2 | #28 |
| P6 | `00` financial-relationships · `02` WF2+WF3 · `01` ctx 11–12c · `03` B3 · Milestones B & C | #5, #7, #8, #16, #17, #19, #25 |
| P7 | `02` WF6 · `01` ctx 13,15 | — |
| P8 | `07-nfr-compliance` · `01` ctx 14 | #24, #26, #27 |

> Give the executor **only** its task's bundle, not the whole spec — narrow context = better output.

## Orchestrator review checklist (gate before "done")

- [ ] A test **fails without** the change and **passes with** it (not just "tests exist").
- [ ] Happy path **and** one edge/error case covered; tests assert behavior, not internals.
- [ ] `npm test` + `npx tsc --noEmit` + `npm run lint` all clean.
- [ ] **DRY** — reused existing helpers (e.g. `lib/wallet.ts`, `lib/auth.ts`) rather than re-writing.
- [ ] **YAGNI** — only the task's scope; no speculative extras; no unrelated files touched.
- [ ] **Every DB query scoped by `clientId`.**
- [ ] No secret/key committed; conventional-commit message; spec/gap-register updated if behavior changed.
- [ ] For DB-affecting tasks: a **manual check on a real DB** confirms it (not just unit tests).

## Human gates (executor CANNOT finish these alone — escalate)

These pace the whole job more than model speed does:
- **The 9 decisions** in [`07-phased-execution-plan.md`](07-phased-execution-plan.md#decision-register)
  (e.g. wallet-less-outlet handling #16, RLS vs Prisma extension #23, penny-drop automation #12).
- **External proxy** for token↔tenant binding (#20) — not in the repo.
- **Migrations / risky data changes** (P5 config-as-data) — need human sign-off + staging dry-run.
- **UI tasks** — need visual verification by a human (the executor can build + unit-test, not
  judge UX).
- Anything where the **code contradicts the spec** — human decides; spec is corrected.

## Throughput note

The limiter is **not** the executor's coding speed — pure-logic/backend tasks are fast. It's the
review/rework loop, the human gates above, real-infra verification, and UI judgment. Plan capacity
around those, and keep tasks small so each review is cheap.
