# Doc Maintenance Protocol — keep the docs from drifting

**Why this exists:** docs went stale twice (catalog, then the whole partner-class/tier/compute model) because
doc-updates were *discretionary* and the same fact lived in many files. This makes doc-consistency a **checkable
gate**, not a memory exercise.

## The rule (definition of done)
> **A model-level, scope-level, or owner-decision change is NOT "done" until the doc sweep passes.**
> Treat it with the same weight as `tsc`/tests. The machine check is `scripts/check-doc-consistency.mjs`
> (also wired to a Stop hook). Run it; if it exits non-zero, the work isn't finished.

## Trigger events (when to sweep ALL docs, not just the one in your path)
- The owner corrects/changes the **model** (e.g. "sales is parameter-based", "segmentation is program").
- A concept is **dropped/retired/reverted** (catalog, tiers, partner-class, the compute engine).
- A **phase/task** completes or is re-scoped, or a **gap** is resolved.
- Any decision that a future reader could otherwise act on from a now-wrong doc.

## The machine check
- `node scripts/check-doc-consistency.mjs` — greps all `docs/**/*.md` for **retired terms** (partnerClass,
  TierConfig, pointsMultiplier, SKU catalog, invoice-line, …) and **fails** if any appears WITHOUT a nearby
  annotation (`retired`/`legacy`/`DROPPED`/`~~strikethrough~~`/`MODEL-ALIGNMENT`/`P4.0`/…). Exit 0 = clean, 1 = drift.
- Wired to a **Stop hook** so it runs automatically each turn and surfaces drift (no reminder needed).
- **Extend it** when the model evolves: edit `RETIRED_TERMS` / `ANNOTATION_MARKERS` / `ALLOWLIST` at the top of
  the script. Adding a newly-retired concept to `RETIRED_TERMS` is part of retiring it.

## Ownership map — the SINGLE SOURCE OF TRUTH per fact-domain
Update the owner doc; everyone else **references** it (don't restate). This is what keeps the edit-count low.

| Fact-domain | Source of truth | Others should… |
|---|---|---|
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
