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

- **Attachment:** rules live in a **dedicated `PointsRule` table** (Wave 0 — chosen over a `program_settings`
  JSON blob because rules are immutable-versioned + queried by attachment; the earlier `program_settings` idea
  is superseded). `program_settings.pointsEngine` now holds ONLY the two feature flags (`enabled`,
  `directCreditEnabled`). Natural key **`(program × input-KpiCode)`**, denormalized onto the row for indexed
  lookup (resolve each outlet's `programName`/`programCategory` from `Outlet`, select the effective published
  rule via `getActiveForAttachment`).
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

**⚠️ NEW requirement — RESOLVED (§12 #4):** the rail dedupes *double-confirm of one batch*, but nothing stops
**two compute runs for the same `(clientId, period, ruleset)`** from both crediting → **double credit**. This
only applies to the **direct-credit route (GIFSY-toggled)**; the export route is read-only (crediting is the
existing, already-guarded manual upload). The direct-credit route MUST carry a **compute-run idempotency key**
(unique on `clientId + period + fieldId + ruleVersion`). Also, per §12 #8, when the engine is ON for a tenant,
a manual points upload to an engine-managed period is warned/guarded to prevent double-sourcing.

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
- **B — %-of-target slab, marginal (L2):** target 500; `<80% →2, 80–100% →3, >100% →4` pts/case, marginal
  (rates chosen so the worked total is self-consistent). 600 cases (120%) → band edges in cases 0–400 / 400–500 /
  500–600 → `400×2 + 100×3 + 100×4 = 1,500 pts`. *Cliff (whole) mode → 600×4 = 2,400* — the 900-pt swing is the
  single best test of the `apply` flag. (Implemented + asserted in `points-engine.helper.spec.ts`.)
- **C — Gated milestone + cap (L3):** litres target 4,000; gate 80%; 1 pt/L once gated; +1,000 at ≥100%; cap
  5,000; floor 500. 3,000 L (75%) → **0**; 3,400 L (85%) → **3,400**; 4,800 L (120%) → `4,800+1,000=5,800`
  → **capped 5,000**. (tests order gate→compute→milestone→floor→cap)
- **D — Two-KPI bundled bonus + compliance multiplier (L4):** base 1 pt/case, qualify only if
  `new_outlets ≥ 3 AND visibility ≥ 90`, then `cases × (visibility/100) + 2000`, else base only.
  (400, 4, 95%) → **2,380**; (400, 2, 95%) → **400**; (400, 4, 88%) → **400**. (full L4 surface)

---

## 11. Delivery plan & scope — DECISIONS LOCKED (2026-10-02)

**Single build, full L1–L4** (owner chose the complete engine over a phased L1–L3-first split). Internally
phased, delivered in ~1–2 owner-gated cutovers.

Scope locked:
- **Full L1–L4** engine: `rate`/`slab`/`gate`/`segmentFilter`/`milestone`/`floor`/`cap` **+ the `formula`
  node** (whitelisted-AST evaluator, no `eval`) **and its formula authoring UI**, from the start.
- **Two output routes:** (a) **compute → preview → EXPORT** (read-only; in the existing credits-upload file
  format) for the offline client-approval flow → re-uploaded via the existing credits rail; **(b) optional
  in-portal "compute → preview → confirm → credit" shortcut**, whose availability is a **GIFSY-admin toggle**
  per tenant. Route (b) is a real money path → gets the **compute-run idempotency guard** (unique on
  clientId+period+fieldId+ruleVersion) + the **dual money+identity audit**.
- **Authoring = GIFSY_ADMIN + CLIENT_ADMIN self-serve.** Because clients author money logic, ship **strong
  structural validation** (slab gap/overlap, boundary inclusivity, explicit per-input null policy, formula
  ref-validation at save) + a **mandatory preview** before a rule is usable. The **direct-credit route stays
  GIFSY-gated** — clients may author + compute + export, but direct wallet crediting only if Gifsy enabled it.
- **Slabs:** no default — the author must pick **marginal vs whole-amount**, with a side-by-side worked total
  shown on sample numbers before save.
- **Clawback:** **reuse the EXISTING credits maker-checker reversal** (`credits.service.ts:1208–1282`,
  REVERSED status, bank-file exclusion) + wallet `REVERSE`/`DEBIT_ADJUSTMENT` ledger — do NOT build a new
  path. A recompute that lowers a period's total surfaces the delta and routes it through that existing
  reversal. (Per-invoice returns need a transaction store we don't have → deferred with per-transaction mode.)
- **Opt-in = per tenant (whole client on/off)** via a `pointsEngineEnabled` flag in `program_settings`. When
  ON for a tenant, manual points uploads for engine-managed periods are warned/guarded to prevent
  double-sourcing.

**Estimate:** ~**10–14 focused build sessions, ~3–5 weeks elapsed** (incl. your UAT + cutovers) — dominated by
the L4 formula engine + its authoring UI, the client-self-serve validation/preview guardrails, and the
direct-credit money path (idempotency + dual audit). Internal phase order: (1) rule model + pure evaluator
(incl. formula) + fixtures A–D; (2) compute + preview + EXPORT (read-only route); (3) direct-credit route
(GIFSY-toggled) + idempotency + reversal wiring + dual audit; (4) authoring UI (both roles) + validation;
(5) runtime + staging e2e + cutover(s).

Each phase: orchestrated build → full gates → **dual adversarial audit (money + identity)** → runtime verify →
staging e2e → owner-gated cutover.

---

## 12. Decisions — LOCKED (owner sign-off 2026-10-02)

| # | Decision | Chosen |
|---|---|---|
| 1 | Scope / sequencing | **Full L1–L4 in one build** (not phased) |
| 2 | Attachment | **Per (program × input-KPI), tenant-wide**; output lands in a credit-field (L4 rules read several input KPIs, still write one bucket) |
| 3 | Evaluation basis | **PERIOD_AGGREGATE (monthly)**; per-transaction deferred |
| 4 | Engine boundary | **Compute + export ALWAYS**, PLUS optional **in-portal direct credit, GIFSY-admin-toggle-gated** (direct path ⇒ idempotency guard + dual audit) |
| 5 | Authoring | **GIFSY_ADMIN + CLIENT_ADMIN self-serve** (strong validation + mandatory preview; direct-credit stays GIFSY-gated) |
| 6 | Slab marginal/whole | **No default — force the choice + show both totals** |
| 7 | Clawback | **Reuse the existing credits maker-checker reversal** (not a new path); recompute-delta → existing reversal |
| 8 | Opt-in granularity | **Per tenant (whole client on/off)**; block manual double-sourcing when engine-on |

---

## 13. Execution plan & orchestration (approved 2026-10-02; Wave 0 STARTED)

**Model:** I orchestrate; agents write code; I integrate + run full gates + run independent adversarial
audits + own the result. Peak ~3–4 concurrent agents; each wave modest. Money path = dual (money+identity)
audit. UI/UX gets a design-first lane + a dedicated UI/UX audit. **Owner comes in ONCE — Wave 5 UAT — after my
full end-to-end audit + runtime verification + staging e2e (it reaches the owner bug-free, as a confirmation).**

| Wave | Activity | Agents | Duration | Depends | Owner? |
|---|---|---|---|---|---|
| **0 Core** ✅ DONE (2026-10-02, `2e0702f`+`6deae79`) | `PointsRule` schema+migration+CRUD; pure evaluator (node pipeline + whitelisted-AST formula, no `eval`) + fixtures A–D. Audit found + fixed HIGH-1 (NaN/∞ emit guard + scale bound), HIGH-2 (cross-ruleId attachment overlap block + deterministic resolution), MED-3/4/5. Added derived `pct:<kpi>` for relative target-gates. Gate: build 0 · points-engine jest 85. Dormant/additive (per-tenant flag off). | 2 build + 1 correctness audit | ~done | — | no |
| **1 Compute+export** ✅ DONE (2026-10-02, `345874f`+`1310029`) | compute service (joins inputs like `getPace` → pure evaluator → preview rows + skip-reason; batched, memoized, tenant-scoped, read-only) + `mapPreviewToUploadRows`; credits-upload-format export (`buildCreditUploadXlsx`) + human review report (`buildPreviewReportXlsx`); `POST /preview`·`GET /export`·`GET /preview-report`. Independent audit confirmed join/scope/dedupe/read-only sound; found + fixed 6: CRITICAL POINTS-into-PAYOUT-field ×100 + HIGH silent-drop (→ live `outletTypeAwards` reconciliation; demote unsafe rows to ERROR), HIGH fractional-points round-trip (→ POINTS requires scale 0 + whole-int export filter), MED export-while-disabled (→ 403), MED KPI-typo silent-0 (→ publish reconciles against `KpiDef`). Finding #6 (unbounded preview load) → Wave 3 UI pagination (export must return all rows; no crash at 2.2k scale). Gate: build 0 · points-engine jest 105. Dormant/additive. | 2 build + 1 audit | ~done | W0 | no |
| **2 Direct-credit money path** ✅ DONE (2026-10-02, `18e3aa5`) | GIFSY-toggled compute→PENDING batch→(operator confirm)→credit, REUSING the existing credits rail (caps, confirm, maker-checker reversal/clawback). `CreditBatch.sourceKind/sourceKey` (+`@@unique`) = provenance + deterministic idempotency key; `createBatch(source)` is idempotent AND enforces ONE active programmatic batch per (clientId,period) under the existing advisory lock; double-gated (`enabled` + GIFSY-set `directCreditEnabled`, read UNCACHED/fail-closed); dedicated owner-only `/v1/admin/points-engine/settings`. DUAL audit (money+identity): ×100-safe, no cross-tenant leak, caps enforced, read-until-confirm; fixed MONEY-1 double-credit (one-active-per-period guard), MONEY-3 TOCTOU (`expectedKey`), MONEY-4 overflow, MONEY-5 header, IDENTITY-1 self-enable (fenced `pointsEngine` from the generic PUT), IDENTITY-2 kill-switch (uncached gate). Conservative limits → W5 UAT: re-credit after full reversal uses export fallback; `idempotentHit` best-effort under concurrency. Gate: build 0 · DI graph compiles · points-engine+credits jest 215. Dormant/additive. | 2 build + 2 audit (dual) | ~done | W1 | no |
| **3 UI/UX (masterpiece)** ✅ DONE (2026-10-02/03, `81ce866` design → `ed688b3` scaffold → `37a078b` /simulate → `a0ca899` screens) | 3a design §14 → 3b build: Settings (GIFSY toggles) + Rules list + the rule BUILDER (typed cards for all 8 node types, slab band-grid, predicate builder, lifecycle) + embedded LIVE SIMULATOR (posts the draft to the pure `/simulate`) + the compute→preview→export/commit stepper. Pure `POST /simulate` added so the simulator reuses the one evaluator. Independent UI/UX+correctness audit (14 findings) all addressed: HIGH edit-save-400 (updateRule strips ruleId), enum-measure seed, pre-submit `draftIssues` validation (blocks backend-invalid, warns footguns — never stricter than backend), read-only operand lockdown, preview returns `directCreditEnabled` (gate the button pre-click), export disabled+honest when engine off, Export/Credit blocked on stale selection, keyboard rows + Add-step Escape/aria. Residual minor polish (W4): nested-predicate round-trip, 2 a11y labels, number-field blank→0. Gate: platform tsc 0 · full vitest 2590 · backend points-engine jest 113 · nest build 0. ⚠️ RUNTIME browser screenshot verification DEFERRED to W4 (shared dev stack; done properly in the Playwright pass). Dormant (gifsyAdminOnly nav; flags off). | 1 design + 2 FE build + 1 UI/UX audit | ~done | W1–W2 | no |
| **4 Verify & harden** ✅ DONE (2026-10-03, `629b201` polish + `9eaedd9` specs/seed/fix) | 3 Playwright specs (clientAdmin compute→preview→commit idempotent money path; simulate; GIFSY-only settings gate) + deoleo seed fixtures; RAN GREEN 5/5 against the REAL stack (cloud gifsy_dev via a spare-port 5434 proxy — owner approved the dev-DB reset; Kwality's separate session untouched). **Runtime verification caught a CRITICAL bug the unit gates couldn't:** the global ValidationPipe (`transform + enableImplicitConversion`) coerced every ARRAY-typed DTO prop (`inputs`/`pipeline`) element to `[]` → validateRule 400'd EVERY real HTTP call (create/update/publish/simulate + the whole authoring UI). Fixed by typing the free-form config props `unknown` + @Allow() (validateRule = the shape authority). Closed W3 residual UX (#12 labels, #14 number-field; #10 can't-occur-yet). Gate: points-engine jest 113 · tsc build 0 · 5/5 e2e. ⚠️ pre-existing harness staleness: partner/partnerApproved logins land on /partner/select (unrelated — separate harness fix). | 3 build/audit | ~done | W3 | no |
| **5 Final audit + UAT + cutover** | my final end-to-end adversarial+runtime audit → owner UAT on staging → prod cutover | fresh e2e audit + me | my audit ~1 session + owner UAT + cutover | W4 | **✅ UAT + cutover go** |

**Agents total:** ~18–22 deployments across the project (sequential/reused), peak ~3–4 concurrent.
**Time:** ~10–14 build sessions; ~3–5 weeks elapsed (incl. owner UAT + cutover). Likely 1–2 cutovers (W0–W2
may ship dormant/off behind the per-tenant flag, then the UI).
**Owner dependencies:** mid-build ~none (I resolve intermediate forks with documented recommendations, interrupt
only for a genuine product-judgment fork). Unavoidable owner-gated points: staging deploy if the Actions
billing block bites (re-public decision), the Wave 5 UAT, the prod cutover approval.
**UI/UX bar:** design-first; progressive disclosure (simple rate = 2 fields, slabs = a grid, formula = a
power-user panel); a LIVE simulator (type inputs → see points + band breakdown, marginal vs whole side-by-side);
every state (loading/empty/error/async-race) + inline validation; light+dark parity, responsive, a11y; a
dedicated UI/UX audit lane + runtime screenshot review + iterate before it reaches the owner.

---

## 14. Wave 3 — UI/UX design (the masterpiece) — authored 2026-10-02

Grounded in the real FE architecture (thin Next 16, `'use client'`, `api` client + `ApiResponse` envelope,
`var(--brand-primary)`, light-mode cards `bg-white rounded-xl border-gray-200`, lucide, hand-rolled tables
like targets/schemes, native `confirm()` for destructive actions). NO new libs (no react-hook-form/zod/SWR).
Primary analog for the compute flow = `admin/credits-payouts/upload/page.tsx` (stepper + OK/SKIP/ERROR
summary cards + two-call confirm + done card). Backend is COMPLETE (Waves 0–2); the UI only calls:
`/api/admin/points-rules*` (CRUD/publish/archive), `/api/admin/points-compute/{preview,export,preview-report,commit}`,
`/api/admin/points-engine/settings` (GET/PUT, GIFSY-only PUT).

### 14.1 Routes (under `platform/src/app/admin/points-engine/`)
- `layout.tsx` — `RequireAuth allowedRoles={['GIFSY_ADMIN','CLIENT_ADMIN']}` (authoring is self-serve per §12 #5).
- `rules/page.tsx` — rule LIST (status/program/kpi filters; New Rule; row → builder).
- `rules/[id]/page.tsx` — the RULE BUILDER (progressive disclosure) + the embedded LIVE SIMULATOR.
- `rules/new/page.tsx` — builder in create mode (or reuse `[id]` with id='new').
- `compute/page.tsx` — the COMPUTE → PREVIEW → EXPORT / COMMIT screen (the credits-upload analog).
- `settings/page.tsx` — the per-tenant flags; the on/off toggles are GIFSY-only (CLIENT_ADMIN sees read-only).
- Nav: add a "Points Engine" group to `ALL_NAV_ITEMS` in `admin/layout.tsx`, gated so the whole group is
  hidden unless the tenant's `pointsEngine.enabled` feature flag is on (via `useTenantFeatures`), matching how
  other dormant features hide. Direct-credit affordances additionally gated on `directCreditEnabled`.

### 14.2 Rule builder — progressive disclosure (the core of the masterpiece)
A rule = Attachment + Inputs + an ordered Pipeline + Output + Rounding + Effective window. The builder never
shows raw JSON; it renders typed cards. Disclosure levels (match the node the author adds):
- **Attachment card:** program (select, "any" allowed) × programCategory (optional) × KPI (select from the
  tenant's `KpiDef` list — NEVER free text, so the publish-time KPI reconciliation can't trip). Effective from/to.
- **Inputs card:** auto-seeds a `value` input bound to the attachment KPI; author adds more inputs (achievement
  `kpiCode`, `target:<kpi>`, `pct:<kpi>`, or a `segment:<field>` enum) with a per-input null policy
  (reject/zero/skipRule) shown as plain-English radios ("missing → skip row / treat as 0 / this rule pays 0").
- **Pipeline builder:** an ordered, reorderable list of node cards; "Add step" menu groups them by level:
  - L1 **Rate** — 2 fields: measure (input picker) × rate. (The simple 90% case = just this.)
  - L2 **Slab** — a BAND GRID (from / to / rate / flat rows; last to=∞), basis = absolute | % of target,
    apply = marginal (tax-bracket) | whole (cliff). Inline gap/overlap validation. A mini marginal-vs-whole
    hint per band.
  - L3 **Gate / Segment filter / Milestone / Floor / Cap** — predicate builder (field op value, with all/any/not
    groups) for gate+milestone; allow-list for segment; min/max for floor/cap; onFail as plain-English.
  - L4 **Formula** — a power-user panel: an `expr` textarea over the bound input vars + output (add/multiply/set),
    with a live "valid / error" indicator (calls the same validator shape; never `eval`) and a var reference chip row.
  - Output card: the credit-field bucket (select from `/api/admin/credits/fields?active=true`; show its
    POINTS/PAYOUT classification — warn if PAYOUT, since Wave-1 demotes those) + rounding (POINTS forces scale 0).
- **Lifecycle:** Draft → Save (PATCH) → Publish (POST /publish; shows the supersede/overlap conflict inline) →
  a published rule is read-only with "Edit = new version". Archive with confirm. Version history list.

### 14.3 Live simulator (embedded in the builder)
A side panel: the author types achievement / target / segment values → we POST nothing; instead we reuse the
PURE evaluator client-side is NOT available (it's backend). Options: (a) a lightweight `/preview`-style
"simulate one row" — add `POST /api/admin/points-compute/simulate` (pure, no DB: body = the draft rule config +
a sample context → EvalOutcome with the full trace) so the simulator shows points + each node's delta +
marginal-vs-whole band breakdown live. **Decision: add a `simulate` route** (pure `evaluateRule` over the
posted draft; no persistence) — it keeps the evaluator the single source of truth and avoids shipping a second
JS evaluator to the browser. Simulator shows: final points (big), the TraceStep ladder (node → detail → delta →
running total), and for a slab, a marginal-vs-whole side-by-side.

### 14.4 Compute → preview → export / commit (credits-upload analog)
Stepper: **Select** (period month-picker + optional program/KPI) → **Preview** (`POST /preview`) → **Act**.
- Preview shows 4 summary cards (OK / Skip / Error / No-rule) + total points + `engineDisabled` banner + rule
  versions used, then OK/ERROR/SKIP/NO_RULE row lists (outlet, KPI, achievement/target, points, explanation).
- Act (operator chooses — §12 #6, show BOTH): **Export** (`GET /export` → xlsx via `downloadBlob`) + **Download
  review report** (`GET /preview-report`), and — only when `directCreditEnabled` — **Credit in portal**
  (`POST /commit` with the preview's `sourceKey` as `expectedKey`) → shows the created PENDING batch + a
  "Review & confirm in Credits & Payouts" link (confirm stays in the existing credits screen = the money gate).
  Surface `priorPointsEngineBatchesThisPeriod` as an amber "already an engine batch for this period" warning.

### 14.5 Settings screen
Shows `enabled` + `directCreditEnabled`. GIFSY_ADMIN: two toggles (PUT /settings). CLIENT_ADMIN: read-only with
"managed by Gifsy" note. Explain each flag in one line.

### 14.6 Build decomposition (3b) + states
- I scaffold: FE types (`platform/src/lib/points-engine/types.ts`, mirroring the backend contract), the api
  wiring, the route group + layout guard + nav entry, and the SETTINGS page (smallest, establishes patterns).
- Then orchestrate (parallel, against the scaffold + this design): (A) rules list + builder + node cards, (B) the
  simulator + the `simulate` backend route, (C) the compute/preview/commit screen.
- Every page: loading (Spinner), empty (EmptyState), error (red banner + retry), async-race guards, inline
  validation, `var(--brand-primary)` accents, a `__tests__/*.test.tsx` (vitest). Then a dedicated UI/UX audit +
  runtime screenshot review (preview_start) before it reaches the owner.
- Open micro-decision resolved: use HAND-ROLLED tables/cards (match targets/schemes, the adjacent features).

---

## 15. Final end-to-end audit — 2026-10-03 (before owner UAT)

4 independent adversarial lanes over the WHOLE feature (money·identity·correctness·UI/UX). **Core re-verified
sound**: NaN/∞/overflow fail-closed, formula AST safety, POINTS⇒scale-0, slab math, NO cross-tenant hole, NO
self-enable path, money gate uncached/fail-closed, tenant-scoped idempotency key, direct-path classification
(no ×100), FE↔BE contract (the Wave-4 DTO fix holds), simulator race handling, versioning/read-only lockdown.

**Money decision (owner, Option A — platform-consistent + warn):** the engine can credit a period two ways
(export→manual-upload or in-portal direct-commit) and the credits rail has never cross-deduped batches, so
the same run could be credited via both; separately my Wave-2 "one engine batch per period" guard over-blocked
legit corrections / a 2nd program / reverse-then-recredit (a reversal never flips `CreditBatch.status`). Chosen:
keep the per-run sourceKey idempotency (no accidental same-run double-submit); DROP the coarse period guard;
WARN when a period already has any credit batch (`priorBatchesThisPeriod`); the maker-checker confirm is the
money gate — exactly how manual uploads already behave. (Commit `47e90fc`.)

**Fixed (backend `47e90fc` + FE `2e3da3c`):** Option-A guard relaxation + broadened warning; settings PUT
rejects an ASSUMED session (TDS-parity); export engine-disabled gate reads UNCACHED; preview returns
`sourceKey` → commit `expectedKey` TOCTOU guard. UI: Publish blocked while dirty + refresh-after; Inputs
validated pre-submit (segment-input bug, duplicate ref, enum-needs-values, formula undeclared var); gate/
segmentFilter onFail restricted to the withhold option (over-credit footgun) + "checked first"/"applied at
end" ordering labels; edit-as-new-version date default; effectiveTo≥from; Field a11y; archive copy/banner;
tab counts; settings toggles-during-save; rate-0 warning. Gate: backend jest 216 · build 0 · platform tsc 0 ·
vitest 2606 (points-engine 30).

**Residual NOTES (no code change — inherent/low, documented for UAT):** export-file re-upload re-derives award
type from the LIVE CreditField at upload (inherent to the manual rail — a field reclassified in the offline
window could mis-credit; direct path is immune); un-assumed owner has platform-wide rule-WRITE reach
(consistent with `platformWide()`); maker-checker needs RBAC enforced (same as the existing credits rail; prod
deoleo has it on); compute's outlet universe is the Outlet table vs `getPace`'s sales/target union (benign);
gate/segmentFilter position + `onFail` soft modes are inert by design (position-aware gating = future
enhancement); wildcard tenant-default + per-program override is blocked at publish (product gap — decide if
wanted); mid-month `effectiveFrom` doesn't apply that month.

**Runtime verification:** the Wave-4 e2e (5/5) already exercised publish→preview→commit→idempotent against the
real stack; the Option-A + preview-sourceKey changes keep that path's behavior identical and are covered by the
216 backend + 2606 FE unit tests, so the authoritative final e2e re-run is the **owner's Wave-5 staging UAT**
(avoids a 2nd cloud-dev reset). ▶ Wave 5: push `develop`→staging (owner; Actions-billing/privacy trap) → owner
UAT → prod cutover (additive migrations, dormant until per-tenant flags on).
