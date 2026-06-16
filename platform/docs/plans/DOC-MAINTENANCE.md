# Doc Maintenance Protocol — keep the docs from drifting

**Why this exists:** docs went stale twice (catalog, then the whole partner-class/tier/compute model) because
doc-updates were *discretionary* and the same fact lived in many files. This makes doc-consistency a **checkable
gate**, not a memory exercise.

## The rule (definition of done)
> **A model-level, scope-level, or owner-decision change is NOT "done" until the doc sweep passes.**
> Treat it with the same weight as `tsc`/tests. The machine check is `scripts/check-doc-consistency.mjs`
> (also wired to a Stop hook). Run it; if it exits non-zero, the work isn't finished.
>
> **Two checks, not one — the machine check is necessary but NOT sufficient:**
> 1. **Coverage audit (own it; don't make the owner catch misses):** before declaring docs done, enumerate
>    *every* decision/fact from the discussion and grep-verify each is written in its source-of-truth doc. The
>    consistency script only catches *retired-term drift* — it does NOT catch a decision that was simply never
>    written down (e.g. the multi-tenancy model, the NestJS rationale — both initially missed in the 2026-06-16
>    Phase-S pass and only caught on owner prompting). Run the enumerate-and-grep sweep yourself.
> 2. **Consistency gate:** `check-doc-consistency.mjs` exits 0.

## Trigger events (when to sweep ALL docs, not just the one in your path)
- The owner corrects/changes the **model** (e.g. "sales is parameter-based", "segmentation is program").
- A concept is **dropped/retired/reverted** (catalog, tiers, partner-class, the compute engine).
- A **phase/task** completes or is re-scoped, or a **gap** is resolved.
- Any decision that a future reader could otherwise act on from a now-wrong doc.

## The machine check — `scripts/check-doc-consistency.mjs`
Greps all `docs/**/*.md` for **retired terms** (partnerClass, TierConfig, pointsMultiplier, SKU catalog,
invoice-line, …) and **fails** if any appears WITHOUT a nearby annotation
(`retired`/`legacy`/`DROPPED`/`~~strikethrough~~`/`MODEL-ALIGNMENT`/`P4.0`/…). Exit 0 = clean, 1 = drift.
Zero-dependency; run anywhere: `node scripts/check-doc-consistency.mjs`.

**It is enforced three ways (in priority order):**
1. **CI gate — `.github/workflows/doc-consistency.yml`** (always-on, no local setup): runs on every push to
   `develop` + every PR to `main`/`develop`. **A stale doc turns the check RED.** This is independent of the
   red-by-design test suite, so it can be green on its own. ← the primary, owner-setup-independent enforcement.
2. **Orchestrator gate task (mandatory, below):** the build agent runs the scan as part of every wave's gate
   and before declaring ANY doc/model change done — same status as `tsc`/tests.
3. **Local Stop hook** (`.claude/settings.json`, bonus): auto-runs the scan each turn — BUT only loads when
   Claude is launched with the **`platform/` folder as its project root**. If you launch from elsewhere (e.g.
   your home folder), this hook does NOT fire — rely on #1 (CI) and #2 (gate task). `--hook` mode no-ops outside the repo.

**Extend it** when the model evolves: edit `RETIRED_TERMS` / `ANNOTATION_MARKERS` / `ALLOWLIST` at the top of
the script. **Adding a newly-retired concept to `RETIRED_TERMS` is part of retiring it.**

## Gate task (the explicit step — run it, every wave)
> **TASK — Doc-consistency gate.** Before declaring a wave (or any model/scope/decision change) done:
> 1. `node platform/scripts/check-doc-consistency.mjs` → must print `✓ docs consistent` (exit 0).
> 2. If it fails: fix the doc(s) or annotate the term, then re-run until green.
> 3. If you just RETIRED a new concept: add it to the script's `RETIRED_TERMS` first, then run.
>
> This task is part of the standard wave gate (alongside `tsc --noEmit`, the differential test gate, and lint).
> It also runs in CI, so a missed sweep fails the `Doc consistency` check on push.

## Ownership map — the SINGLE SOURCE OF TRUTH per fact-domain
Update the owner doc; everyone else **references** it (don't restate). This is what keeps the edit-count low.

| Fact-domain | Source of truth | Others should… |
|---|---|---|
| **Target architecture** (API-first: NestJS backend + thin FE; the decision + C4/arc42) | **`spec/04-architecture.md`** | link to it |
| **The backend split — Phase S** (execution: steps S0–S8, reused-vs-reworked, principles) | **`BACKEND-SPLIT-PLAN.md`** | link to it |
| **Multi-tenancy & per-client customization model** (config-not-code-branches, customization spectrum, isolation, multi-consumer auth, now-vs-later effort) | **`spec/06-configurability.md` §0** | link to it |
| The **real operating model** (parameter-based, program-segmented, no-compute, the 3 layers, de-scaffold scope) | **`MODEL-ALIGNMENT.md`** | link to it, not re-explain it |
| **Phase plan + live build status** | **`00-MASTER-PLAN.md`** (per-phase status blocks) | the milestone/epic/phased docs are SUPERSEDED — banner only |
| **Gaps + resolutions** | **`spec/gap-register.md`** | reference gap #s |
| **Restart/runtime brief** | **`RESUME.md`** (the paste-after-compact block) | — |
| **Per-context capability / data-model / API / workflow / configurability** | the respective **`spec/*.md`** | own their slice; reference MODEL-ALIGNMENT for the model |
| **Reporting / KYC tracks** | `REPORTING-REVAMP.md` / `KYC-APPROVAL-REVAMP.md` | — |
| **Dev DB / git / testing / RBAC enablement** | `DEV-DB.md` / `GIT-WORKFLOW.md` / `01-how-we-test.md` / `RBAC-ENABLEMENT.md` | — |
| **Memory (cross-session)** | `~/.claude/.../memory/*` (`platform-real-model`, `loyaltybase-spec-effort`, …) | sweep on every model change |

**SUPERSEDED docs** (historical; do not plan from them — they carry a banner → 00-MASTER-PLAN):
`02-milestone-A-warmups`, `04-milestone-C-finance-correctness`, `05-milestone-D-tenant-isolation`,
`06-epics-roadmap`, `07-phased-execution-plan`.

## Workflow tip (owner-requested)
Doc maintenance blocks nothing — when documenting, **fan out independent executor agents in parallel** for the
next build/recon tasks instead of serializing. Run the doc sweep as the gate before declaring the wave done.
