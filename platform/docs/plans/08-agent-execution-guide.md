# Agent Execution Guide (orchestrator + executors + auditors)

How to run [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md) fast **and** safely with a multi-agent model:
an **orchestrator** (Opus) plans + gates, **executor** agents (Sonnet) build via TDD, and an
**independent auditor** (fresh agent) adversarially validates **every** task. A task is done only when
the orchestrator's gate passes **and** an independent audit has validated it — never on an agent's word.

## Operating model (user-agreed 2026-06-15)

- **Parallel waves.** Dispatch 2–4 executors at once on **disjoint file sets** (never overlapping files).
- **Pipeline the audits.** While wave A is being audited, wave B is already executing — never block the
  next task on the previous audit.
- **Batch the gate.** Run the consolidated `tsc` + differential test + lint **once per wave**, not per task.
- **AUDIT EVERYTHING — do NOT risk-tier.** Every task (including pure-function and doc tasks) gets an
  independent audit. (Owner directive: thoroughness over speed; no skipping audits.)
- **Documentation is owned by the best agent.** Doc/spec/gap-register/memory consistency is maintained by
  the orchestrator (Opus) or a dedicated **Opus** documentation agent — swept after every wave so docs
  never drift. Do not delegate doc accuracy to a cheaper model.
- **Branches:** work on **`develop`** (see [`GIT-WORKFLOW.md`](GIT-WORKFLOW.md)); `main` = releases only.

### Model assignment
| Role | Model | Why |
|---|---|---|
| Orchestrate, plan, **the gate**, high-risk audits (auth/money/wide), **documentation maintenance** | **Opus** | judgment, design, owner-in-the-loop, deepest reasoning, doc consistency |
| Execute (TDD build) | **Sonnet** | fast + reliable for bounded tasks — the workhorse |
| Independent audit (every task) | **Sonnet** (Opus for high-risk) | sharp, adversarial, fresh context; catches what the executor + gate miss |
| Trivial mechanical sweeps (find-replace, formatting) | **Haiku** | only when risk ≈ 0 and it's pure mechanics |

## Roles & responsibilities

**Orchestrator (Opus) — plans, gates, owns docs:**
- Picks tasks, assembles each context bundle, dispatches executors in disjoint parallel waves.
- **Gates every task — assumes nothing is done until proven.** Re-runs `npx tsc --noEmit` + `npm test`
  (the **differential** gate — see below) + `npm run lint` itself; confirms a test **fails-without /
  passes-with**; checks DRY (reused helpers?), YAGNI (scope creep / unrelated files?), `clientId`
  scoping, no secrets, conventional commit. DB work needs **real-DB evidence**.
- **Commissions an independent audit of every task** and folds its findings back in (re-dispatch the
  executor on a FAIL/PWN with a real bug).
- **Maintains documentation** (or dispatches an Opus doc agent): after each wave, sweep spec/gap-register/
  reconcile/RESUME/memory for any fact that changed; fix all of them in the same pass.
- **Escalates human gates** (decisions, migrations, prod/main, UI sign-off, the proxy) — never guesses.

**Executor (Sonnet) — produces:**
- Implements exactly the assigned task via TDD (RED→GREEN→REFACTOR) using only its context bundle.
- Runs its own scoped test (not the full suite/tsc — the orchestrator runs the consolidated gate to
  avoid cross-wave contention). **Does NOT commit** — the orchestrator commits after the gate.
- **Stops and asks — does not guess** — when the code contradicts the task or a "verify this" step fails.

**Independent auditor (fresh agent, every task) — adversarially validates:**
- Gets ONLY the task's claimed intent + acceptance criteria + the diff (no build context — re-derives
  correctness cold). Probes for bypasses, missed cases, sibling holes, security/tenant/secret issues.
- Returns **PASS / PASS-WITH-NOTES / FAIL** with file:line evidence. A FAIL with a real bug goes back to
  the executor before the task is accepted.

**The contract:** executor *produces* → orchestrator *gates* → independent auditor *validates*. All three
for every task.

## The gate is DIFFERENTIAL
The TDD suite is **red throughout the build** (incomplete features for later phases). Never gate on
"zero reds." Gate on **"no NEW reds vs `reconcile/baseline-red-snapshot.txt`"** — extract the failing
test files, diff against the snapshot; the new set must equal (or be a subset of) the snapshot. tsc and
lint, however, must be **0 new errors** (lint is red project-wide; check only that the wave's files add none).

## The loop (per wave)

1. **Pick the next disjoint tasks** (dependency-ordered; `X.0 Reconcile` first in a phase). Confirm the
   files don't overlap across the wave.
2. **Dispatch executors in parallel** (background), each with its context bundle (below). They build +
   run their own scoped test; they do not commit.
3. **Consolidated gate (once):** `tsc` 0, full **differential** test (no new reds), lint (no new on the
   wave's files). Review each diff (DRY/YAGNI/clientId/secrets).
4. **Commit** each task (conventional message). **Commission the independent audit** of each (pipeline:
   while auditing, start the next wave). Fold audit findings back in.
5. **Doc sweep** (Opus): update every doc/spec/memory a changed fact touches. Then next wave.

## Context bundle — what each executor must receive

**Always:** [`../../AGENTS.md`](../../AGENTS.md) (the "this is NOT the Next.js you know" warning) ·
[`01-how-we-test.md`](01-how-we-test.md) (deterministic tests; two styles) · the **task row + phase exit
criteria** · the **named code files** · the relevant source-of-truth reconcile/design doc.

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
| P9 | `GIT-WORKFLOW.md` · `RBAC-ENABLEMENT.md` · `terraform/`, `.github/workflows/` | #23, #27 |

> Give each executor **only** its task's bundle, not the whole spec — narrow context = better output.

## Orchestrator gate checklist (before "done")

- [ ] A test **fails-without / passes-with** the change (not just "tests exist"); happy path + ≥1 edge.
- [ ] `tsc` 0 · **differential** test (no new reds vs snapshot) · lint adds no new errors on the wave's files.
- [ ] **DRY** (reused helpers) · **YAGNI** (only the task's scope; no unrelated files) · **every DB query
      scoped by `clientId`** · no secret committed · conventional commit.
- [ ] DB-affecting tasks: **real-DB evidence** (run it; show row counts), applied per `DEV-DB.md`
      (diff-SQL/`db push`, `gifsy_dev`-guarded — never `prisma migrate dev`).
- [ ] **Independent audit ran and is PASS / PASS-WITH-NOTES** (FAIL with a real bug → back to executor).
- [ ] **Docs swept** for every changed fact (spec, gap-register, reconcile, RESUME, memory).

## Human gates (escalate — never guess)
- Design decisions / the spec-vs-code conflicts (code wins; spec corrected) — owner decides.
- **Migrations + any prod/`main`/deploy action** — owner sign-off; prod is private-IP, additive, guarded.
- **UI tasks** — owner visual sign-off (executor builds + unit-tests, can't judge UX).
- The proxy / token↔tenant boundary changes.

## Throughput note
The limiter is **the orchestrator's gate** (serial) + the human gates + real-infra verification + the
mandatory audit-everything pass — **not** executor coding speed. Go faster by running wider disjoint
waves and pipelining audits, NOT by skipping the audit (owner directive: audit everything). Keep tasks
small so each gate + audit is cheap.
