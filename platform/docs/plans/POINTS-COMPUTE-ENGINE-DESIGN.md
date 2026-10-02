# Points Compute Engine — Phase 0 Design (platform capability)

> **Status:** DESIGN / Phase 0 — for owner review. No code written yet.
> **Author aid:** synthesized from three research threads (rules-engine architecture, loyalty/incentive
> domain modeling, and a grounded codebase-fit pass). Read `[[platform-real-model]]` first — this
> *re-introduces a compute layer* the platform deliberately dropped in the P4 de-scaffold, so it is
> built **clean, additive, and opt-in**, NOT by resurrecting the old World-A tier/multiplier engine
> (confirmed dead — see §9).

---

## 1. Goal & framing

Today the platform is **no-compute**: tenants upload raw per-outlet-per-KPI-per-month values (achievements)
+ targets, and SEPARATELY upload pre-computed points as credits. This feature lets the **portal compute the
points** from the raw parameter values + targets via a configurable rule set, then credit the wallet through
the existing rail.

**The engine is a pure, deterministic function**, not a general rules platform:

```
compute(outlet, params, targets, ruleVersion) → { points: wholeInt, trace: Step[] }
```

evaluated over (tens of thousands of outlets) × (KPIs) × (months). That reframing is the key
anti-over-engineering move: bounded typed inputs, a non-negative integer output + a trace, pure and
snapshot-pinned. Everything downstream (versioning, preview, audit) is easy *only because* compute is pure.

**Non-negotiables baked in from the start:**
- **Additive + opt-in per tenant.** The verbatim credits-upload path stays; a tenant either uploads final
  points (as today) OR turns on the engine. Never both for the same field/period.
- **Money path.** Computed points become real wallet balance → it flows through the existing
  `CreditBatch → confirm → wallet ledger` rail (inherits every money safeguard) and gets a dual audit.
- **Immutable, versioned, explainable.** Editing a rule never silently restates already-paid history.

---

## 2. The model — a hybrid "ordered pipeline of typed nodes"

Both the architecture and domain research independently landed here. A rule is an **ordered pipeline of
typed nodes**; each node reads the running context (+ points so far) and returns a points delta + a trace
step. **L1–L4 are not four engines — they are which node types a rule happens to use:**

| Node type | Tier | What it does |
|---|---|---|
| `rate` | **L1** | `points += measure × rate` (the ~90% case; first-class so simple rules never see a formula box) |
| `slab` | **L2** | explicit ordered bands; `basis: absolute \| pct_of_target`; `apply: marginal \| whole` |
| `gate` | **L3** | pay nothing (or skip) unless a predicate holds (e.g. achievement ≥ 80%) |
| `segmentFilter` | **L3** | restrict to a program / category / outlet-type segment |
| `milestone` | **L3** | flat lump on crossing a discrete threshold |
| `floor` / `cap` | **L3** | clamp min / max (always applied last, floor→cap) |
| `formula` | **L4** | cross-parameter arithmetic — the **only** node that uses the expression evaluator (§5) |

Declarative nodes (L1–L3) stay as **structured, validatable data** — diffable, business-readable, each row a
test case. Only genuine multi-KPI arithmetic drops to a sandboxed formula. (Decision tables are great for
slabs but can't do L4; JSONLogic/json-rules-engine either coerce money wrong or don't output numbers; a pure
formula engine is the wrong *default*. Hence the hybrid.)

---

## 3. The versioned rule object (concrete schema)

```jsonc
{
  "ruleId": "rule_cases_q3",          // stable identity across versions
  "tenantId": "deoleo",
  "version": 7,                        // monotonic; a published version is NEVER mutated
  "status": "published",              // draft | published | archived
  "effectiveFrom": "2026-07-01",      // BUSINESS-time validity (not edit-time)
  "effectiveTo":   "2026-09-30",
  "attachsTo": { "scope": "program_kpi", "program": "GOLD", "kpiCode": "CASES_SOLD" }, // see §6
  "evaluationBasis": "PERIOD_AGGREGATE", // PERIOD_AGGREGATE (today's model) | PER_TRANSACTION (deferred)
  "output": { "awardType": "POINTS", "fieldId": "cf_scheme_q3" }, // the CreditField bucket to credit
  "rounding": { "mode": "half_up", "scale": 0 },   // declared, single, at the end
  "inputs": [                         // the ONLY variables the pipeline may read (by KpiDef.code)
    { "ref": "value",  "kpiCode": "CASES_SOLD", "type": "number", "nullAs": "reject" },
    { "ref": "target", "source": "target:CASES_SOLD", "type": "number", "nullAs": "skipRule" },
    { "ref": "newOutlets", "kpiCode": "NEW_OUTLETS", "type": "number", "nullAs": "zero" }
  ],
  "pipeline": [
    { "type": "gate", "id": "n1", "when": { "op": "gte", "left": {"var":"value"}, "right": {"var":"target"} }, "onFail": "zero" },
    { "type": "slab", "id": "n2", "basis": "pct_of_target", "measure": {"var":"value"},
      "apply": "marginal",            // MARGINAL (tax-bracket) | WHOLE (re-rate everything) — explicit, never defaulted
      "bands": [                       // half-open [from,to); last to=null = ∞; validated gap/overlap-free
        { "from": 0,   "to": 80,  "rate": 0 },
        { "from": 80,  "to": 100, "rate": 2 },
        { "from": 100, "to": null,"rate": 3 }
      ] },
    { "type": "milestone", "id": "n3", "when": { "op": "gte", "left": {"var":"value"}, "right": {"var":"target"} }, "flat": 1000 },
    { "type": "floor", "id": "n4", "min": 0 },
    { "type": "cap",   "id": "n5", "max": 50000 }
  ]
}
```

**Explicit flags that prevent the classic silent-wrongness bugs** (every one called out by the domain research):
- `apply: marginal | whole` on every slab — *the single highest-leverage correctness switch* (same 600 cases
  can pay 1,500 vs 2,400 pts). Never defaulted; the authoring UI shows a side-by-side worked example.
- `basis: absolute | pct_of_target` — does the slab band on raw volume or on achievement %?
- `nullAs: reject | zero | skipRule` **per input** — a blank cell is an *omitted key, not 0* (the codebase
  stores it that way); missing data must not silently become money. Default `reject` (surface for review).
- `evaluationBasis` — today's data is monthly `PERIOD_AGGREGATE`; `PER_TRANSACTION` (bill-to-bill) is a
  deferred axis (no per-invoice store exists yet).
- band boundaries carry explicit inclusivity; `rounding` is single + final; floor→cap order is structural.

---

## 4. Evaluation pipeline (fixed, documented order)

1. **Input binding & null policy** — resolve every `inputs` ref against the context; apply `nullAs` *before any
   arithmetic*. (`reject` → row skipped-with-reason; `skipRule` → rule contributes 0; `zero` → treat as 0.)
2. **Gates & segment filters** — short-circuit to `onFail` if any fails (record which).
3. **Accrual nodes** (`rate`, `slab`, `milestone`, `formula`) in listed order, accumulating points + trace.
4. **Floor then cap** (always last, always that order — cap-before-floor can land below the floor).
5. **Rounding** — single declared rounding at the very end, on integer points. Never mid-pipeline.
6. **Emit** `{ points, trace[], ruleVersionRef }`.

A flat ordered list (vs a nested tree) is diffable in a UI, maps 1:1 to trace steps, and makes
floor/cap/rounding order a structural guarantee.

---

## 5. L4 safe formula evaluator (no `eval`)

The `formula` node is the ONLY place arbitrary arithmetic runs. **Never** `eval`/`new Function`/`vm`/any
"not-a-sandbox" library. Mechanism (directly modeled on the existing, proven
`enrollment-form.helper.ts::evaluateFormula` — a hand-written regex tokenizer, no eval, null-on-error,
server-authoritative recompute):

1. **Parse** the expression to an AST (hand-rolled Pratt parser, ~200 lines we own — or use only the *parse*
   step of a lib, never its `.evaluate()`).
2. **Whitelist-validate the AST at publish time**: allowed = number/string literals, variable refs (must be a
   declared `inputs` ref / known `KpiDef.code`), `+ - * / %`, unary minus, comparisons, `&& || !`, and a fixed
   function whitelist `min,max,abs,round,floor,ceil,clamp,if`. **Reject** member access, indexing, assignment,
   unknown identifiers, unknown functions. Bound AST depth (≤20) and node count (≤200); no recursion.
3. **Compile once per rule version, evaluate many** (cache by `(ruleId, version)`) — the performance crux at
   10k×KPI×months.
4. **Numeric safety:** integer/decimal domain (points are whole ints; money is BigInt-paise); explicit
   divide-by-zero handling; **no** JSONLogic-style coercion (`null→0`, `"5"→5`). Nulls handled only by §4.1.
5. **Deterministic:** no `now()`, `random()`, locale, or I/O. Same inputs + version ⇒ same output forever.

Reuse the existing `VISIBLE_WHEN_OPS` / `evaluateClause` predicate helpers for gate conditions.

---

## 6. Integration map (grounded in real code)

```
INPUTS (per-tenant, verbatim, no-compute — reuse the getPace join)
  KpiDef               schema.prisma:2835   (clientId,code) unique            ← the "parameters"
  OutletSalesRecord    schema.prisma:2806   kpiValues Json  @@unique(clientId,outletCode,month)  ← raw achievement
  OutletTarget         schema.prisma:2874   targetValues Json (same keying, past-month locked)    ← targets
  Outlet.programName/programCategory                                          ← segmentation facet (join by outletCode)
        │  join on (clientId, outletCode, month) per KPI code — MIRROR TargetsService.getPace (targets.service.ts:899)
        │  blank cell = OMITTED key ≠ 0; divide-by-zero on target → skip/reject
        ▼
NEW ENGINE  (build this — thin orchestration + pure evaluator)
  points-engine.helper.ts   pure evaluator (sibling of enrollment-form.helper.ts)
  PointsRule config store    (§ attachment below)
  → emits UploadRowDto[]  { awardType:'POINTS', amount: wholePoints, fieldId, outletId: outletCode, status, skipReason? }
        ▼
OUTPUT RAIL (REUSE AS-IS — do not rebuild)
  CreditsService.createBatch   credits.service.ts:884   → CreditBatch (PENDING_CONFIRM)   ← PREVIEW lands here
  CreditsService.confirmBatch  credits.service.ts:933   → money commit (atomic, guarded)
     → WalletService.creditEarn → applyBalanceDelta (wallet.service.ts:167)
        → Wallet.redeemablePoints += pts  +  WalletTransaction  +  PointsLedger (one lot/row, traceable)
```

**Reuse (don't rebuild):** the whole output rail (inherits idempotent double-confirm guard, atomic ledger
write, TDS freeze, invoice-at-confirm, notifications); the `getPace` input join; `KpiDef`/`OutletSalesRecord`/
`OutletTarget` as sources (no input-schema change); `CreditField` as the output bucket; the
`evaluateFormula` evaluator mechanism.
**Build new:** the `PointsRule` config store, the pure evaluator, and a thin compute service
(load inputs → evaluate → **preview** `UploadRowDto[]` → on confirm call `createBatch`).

---

## 7. Attachment, tenancy, RBAC

- **Attachment:** per-tenant rules live in **`program_settings` via `TenantSettingsService`** (same typed,
  cache-busted home as conversion-rate / credit-caps / TDS) as a new `pointsEngine` sub-config. Natural key
  **`(program × KpiCode)`** (resolve each outlet's `programName`/`programCategory` from `Outlet`, select the
  matching rule), with an optional **per-`Scheme`** rule set when rules vary by scheme rather than tenant-wide.
- **Tenancy:** all reads/writes `clientId`-scoped via `platformWide()`/`tenantScope()`; un-assumed GIFSY_ADMIN
  platform-wide, everyone else (incl. assumed staff) pinned to their tenant.
- **RBAC:** author rules = **GIFSY_ADMIN** + a finance-reserved permission (follow `tenancy:write_finance`);
  run/preview = `credits:upload`; **commit = `credits:confirm_payout`** (the existing money-commit gate).
  GIFSY_STAFF reach these only when assumed into a granted tenant with the permission.

---

## 8. Money-path requirements (inherited + one NEW)

Inherited from the credits rail (must not be bypassed): two-phase batch→confirm; idempotent double-confirm
guard (`updateMany WHERE status='PENDING_CONFIRM'`, atomic 180s tx, deliberately un-chunked); one
`PointsLedger` lot per credit; server-side safety caps + IST upload window on **both** create and confirm;
skip-with-reason (never silent drop); whole-points invariant (no ×100); fire-and-forget notifications.

**⚠️ NEW requirement (owner decision needed):** the rail dedupes *double-confirm of one batch*, but nothing
stops **two compute runs for the same `(clientId, period, ruleset)`** from each producing a batch that both get
confirmed → **double credit**. The engine MUST add a **compute-run idempotency key** (e.g. unique on
`clientId + period + fieldId + ruleVersion`, or refuse a second compute batch for a period already credited).
Do not ship without deciding this.

**Versioning / snapshot / explainability (the money-trust core):** a published rule version is append-only;
"editing" makes `version+1` with a new `effectiveFrom`. On commit, **freeze into every result row**: the
resolved `ruleVersionId` + a content hash of the rule JSON + the input snapshot + the conversion-rate snapshot
+ the per-node **trace** (`{nodeId, type, inputsSeen, bandMatched/gateResult, delta, pointsAfter}`). Editing a
rule then *cannot* restate paid history. "Why N points?" = render the trace
("Gate passed (120 ≥ 100) → slab band 100%+ @3 +300 → milestone +1000 → **1,300 pts**").

---

## 9. Dead scaffolding — AVOID-LIST (confirmed)

The old World-A compute engine is **fully removed/unwired** — build clean, do not reference:
no `lib/incentive` / `schemes/calculate` / tier / partner-class files exist; every `PartnerClassConfig` /
`TierConfig` / `pointsMultiplier` hit is a "DROPPED in S2" comment or a test asserting absence; the
`partnerClass` string in `kyc.service.ts` is a display label, not a compute input. (De-scaffold codified in
`migrations-manual/S2_descaffold_worldA.sql`.)

---

## 10. Worked archetypes (regression fixtures — stress-test the schema across L1–L4)

- **A — Flat per-case (L1):** 2 pts/case, no target. 137 cases → **274 pts**. (trivial linear path)
- **B — %-of-target slab, marginal (L2):** target 500; `<80% →0, 80–100% →2, >100% →3` pts/case, marginal.
  600 cases (120%) → `400×2 + 100×3 + 100×... ` → **1,500 pts**. *Cliff (whole) mode → 2,400* — the 900-pt
  swing is the single best test of the `apply` flag.
- **C — Gated milestone + cap (L3):** litres target 4,000; gate 80%; 1 pt/L once gated; +1,000 at ≥100%; cap
  5,000; floor 500. 3,000 L (75%) → **0**; 3,400 L (85%) → **3,400**; 4,800 L (120%) → `4,800+1,000=5,800`
  → **capped 5,000**. (tests order gate→compute→milestone→floor→cap)
- **D — Two-KPI bundled bonus + compliance multiplier (L4):** base 1 pt/case, qualify only if
  `new_outlets ≥ 3 AND visibility ≥ 90`, then `cases × (visibility/100) + 2000`, else base only.
  (400, 4, 95%) → **2,380**; (400, 2, 95%) → **400**; (400, 4, 88%) → **400**. (full L4 surface)

---

## 11. Delivery plan & scope

**Two waves** (ship value early, de-risk the costly L4 formula layer until a real scheme validates the DSL):

- **Wave A — L1–L3 engine (the 80%).** `PointsRule` store + CRUD + the pure evaluator (`rate`/`slab`/`gate`/
  `segmentFilter`/`milestone`/`floor`/`cap`) + preview (`createBatch`) + commit (`confirmBatch`) + the
  compute-run idempotency guard + rule-version snapshot/trace + authoring UI + fixtures A–C. **~5–7 build
  sessions, ~1.5–2.5 weeks elapsed** (incl. your UAT + a cutover). Architected so L4 is just one more node.
- **Wave B — L4 formula node.** The whitelisted-AST evaluator + formula authoring UI + fixture D, added once
  ≥1 real cross-KPI scheme exists to validate the expression model. **+~4–6 sessions.**

Each wave: orchestrated build → full gates → **dual adversarial audit (money + identity)** → runtime verify →
staging e2e → owner-gated cutover.

---

## 12. Open decisions for the owner (Phase 0 sign-off)

1. **Wave A scope** — confirm L1–L3 first, L4 (Wave B) deferred until a concrete scheme? *(recommended)*
2. **Attachment** — per `(program × KPI)` tenant-wide, per `Scheme`, or both?
3. **`evaluationBasis`** — PERIOD_AGGREGATE (monthly, matches today's data) for now; PER_TRANSACTION deferred? *(recommended)*
4. **Compute-run idempotency policy** — refuse a 2nd compute for a credited period, or unique-key + upsert? (§8 — must decide)
5. **Authoring** — GIFSY_ADMIN-operator-authored only, or CLIENT_ADMIN self-serve too?
6. **Marginal vs whole-amount default** in the UI (recommend: no default — force the choice + show both).
7. **Clawback** (returns/cancellations reversing accrued points) — schema hook now, behavior later?
8. **Opt-in granularity** — per tenant, per CreditField, or per scheme (engine-computed vs verbatim-upload)?
