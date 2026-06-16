# Loyaltybase — Implementation Plan

This folder turns the [spec](../spec/README.md) into an **executable, sequenced plan of
bite-sized tasks** for an engineer **new to this codebase and domain**.

**⭐ CURRENT PRIORITY: [`BACKEND-SPLIT-PLAN.md`](BACKEND-SPLIT-PLAN.md)** — Phase S, the API-first re-architecture
(dedicated NestJS backend + thin frontend), decided 2026-06-16 and **gating P3+**. Do this before any new feature phase.

**▶ Start here: [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md)** — the phased plan for the **entire
platform** (all 17 bounded contexts + workflows, 9 phases + Phase S, gaps absorbed). Everything else supports it:
- [`00-onboarding.md`](00-onboarding.md) + [`01-how-we-test.md`](01-how-we-test.md) — **required reading**.
- The **Milestone/Epic files** below — *deep, code-level* task breakdowns for the gap-remediation
  slice (the worked-example depth); the master plan's phases point to them.
- [`07-phased-execution-plan.md`](07-phased-execution-plan.md) — a gap-remediation **sub-view**
  (tracker for the 28 gaps only). The master plan supersedes it for whole-project scope.

## How to use this plan

1. **Do the reading first.** [`00-onboarding.md`](00-onboarding.md) (environment + toolset +
   domain) and [`01-how-we-test.md`](01-how-we-test.md) (how we write tests). Do not skip these —
   later tasks assume them.
2. **Work milestones in order.** Each milestone is a file of numbered tasks. Each task is small
   (≈½–1 day), independently committable, and has its own tests.
3. **One task = one branch = one PR = one or more small commits.** Never bundle two tasks.
4. **Tasks within a milestone are ordered by dependency** — later ones often need an earlier one
   *merged* (e.g. B3 uses B2's helper, D2 fixes what D1's audit flags). Do them in sequence; if you
   must parallelize, branch off the dependency and rebase after it lands.

## Global rules (non-negotiable)

- **TDD.** Write the failing test first (RED), make it pass (GREEN), then clean up (REFACTOR).
  No production code without a failing test that demanded it.
- **DRY.** Before writing a function, `grep`/search for an existing one. This codebase already
  has helpers for wallets (`lib/wallet.ts`), auth (`lib/auth.ts`), tenancy (`lib/tenant.ts`),
  uploads (`lib/*-upload.ts`). Reuse them.
- **YAGNI.** Build exactly what the task asks. No "while I'm here" extras, no speculative config,
  no abstractions with one caller.
- **Frequent commits.** Commit at every green test. A commit should be a sentence, not a chapter.
- **Never commit secrets.** `.env`, `*.json` service-account keys, and `push_secrets*` are
  gitignored — keep it that way. Don't hardcode credentials, tokens, or `FIXED_OTP` anywhere.

## Definition of Done (every task)

- [ ] New/changed behavior is covered by a test that fails without the change.
- [ ] `npm test` passes. `npx tsc --noEmit` is clean. `npm run lint` is clean.
- [ ] No secret, key, or credential added. No unrelated files changed.
- [ ] Conventional-commit message(s). Spec/gap-register updated if behavior changed.

## When you're stuck (read this)

If a task contradicts the code, a file isn't where the plan says, or a "verify this" step fails —
**stop and ask**, with what you found. Do **not** guess, invent a value, or force the code to match
the plan. The plan is reverse-engineered and can be wrong; the running code wins. A two-line
question beats an hour down the wrong path.

## PR template

```
## What & why
<task id + one line> — closes gap #<n>
## How I tested
- [ ] RED → GREEN (test names: …)
- [ ] npm test / npx tsc --noEmit / npm run lint all clean
- [ ] manual check done  (or: "pending — needs DB")
## Caveats / follow-ups
<anything skipped, any decision the owner still needs to make>
```

## Milestones (in order)

> 📋 The **whole-project** plan is [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md). The milestones below
> are **deep code-level breakdowns** of the gap-remediation slice; the master plan's phases
> reference them as the depth-template for every task.

| # | File | Theme | Gaps addressed | Why this order |
|---|---|---|---|---|
| A | [`02-milestone-A-warmups.md`](02-milestone-A-warmups.md) | Low-risk cleanups | #1, #21, stale `ROLES`, #5 naming | Learn the workflow safely |
| B | [`03-milestone-B-points-to-wallet.md`](03-milestone-B-points-to-wallet.md) | **Points reach the wallet** | **#16 (High)** | Highest user-visible value; worked exemplar |
| C | [`04-milestone-C-finance-correctness.md`](04-milestone-C-finance-correctness.md) | Payout/invoice correctness | #7, #8, #19 | Protects money flows |
| D | [`05-milestone-D-tenant-isolation.md`](05-milestone-D-tenant-isolation.md) | Tenant-scoping guardrail | #23, #20 (High) | Security backstop |
| E | [`06-epics-roadmap.md`](06-epics-roadmap.md) | Large features (config-as-data, RBAC, KYC routing, enrollment forms) | #2, #6, #9, #18, #22 | Bigger; planned, not yet task-broken |

Start at **Milestone A** only after finishing the two reading docs.
