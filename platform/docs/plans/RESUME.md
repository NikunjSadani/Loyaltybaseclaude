# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️⚠️ **STATE (corrected 2026-06-18 after a live runtime audit): BACKEND P0–P6 ✅ COMPLETE, but the
FE/AUTH/INTEGRATION layer is INCOMPLETE. "P0–P6 complete" was a backend+static-gate green; a runtime pass found
the app's front door does not open.** Do NOT trust a green status — read `reconcile/P0.5-make-it-runnable.md` +
[[runtime-audit-p0.5]] + gap-register #33–#37 first.
**NEXT = P0.5 "Make It Runnable" (then P0.6/P0.7) BEFORE P7.** Critical runtime findings: **login broken
end-to-end** (FE↔backend contract never reconciled post-Phase-S — #33), **pervasive FE auth-attachment bug**
(pages 401 → fabricate demo data — #34), **Gift Catalogue 500** (uncoerced pagination — #35), **dashboards
fabricate / unwired mock pages** (#36), **broken seed + empty dev DB** (#37). Backend is real & correct
(verified: real wallet, credits, TDS+Excel export, targets, invoices, schemes).
**P0.5 (NOW):** Wave 0 auth fix (login contract + token→localStorage + clientId + route guard) → Wave 1 parallel
agents A=global auth-attachment, B=seed rebuild, C=catalogue-500/DTO-coercion. **P0.6 (NEXT):** parallel D=KYC
writes, E=redemption/wallet writes, F=visibility/invoices, G=tickets/support, H=dashboards→real, I=payouts.
processBatch+TDS. **P0.7:** cleanup (demo chrome, dead routes). **Gate MUST add a live runtime re-verify per
`reconcile/../VERIFICATION-PROTOCOL.md`** (real login per role · role matrix · cross-tenant · DB persistence seen by
a different session · honest unhappy path) — the static gate (tsc+jest+vitest) missed all of this; `tsc`/unit tests
are never sufficient, and "the backend is complete" is a hypothesis to test (e.g. tickets list scopes CLIENT_ADMIN
to own tickets; KYC approve 404s cross-tenant for Gifsy — both behind "complete" features).
**P6 (Finance) DONE 2026-06-18 (backend):** money-unit→BigInt paise (#19) · credits→wallet (#16) · visibility
capture-mode (#17) · self-bill invoicing (#8/#15) · TDS engine 194R/194C + redemption→payout bridge (#25).
Dev login: `FIXED_OTP=123456`; seeded users in `gifsy_dev` (deoleo admin `9000000001`, partner `9000000002`,
sales `9000000003`, gifsy admin `9830011252`).

**Architecture (Phase S, done):** API-first — a dedicated NestJS backend built IN PLACE in `api/` (reused its shell,
deleted its World-A domain, rebuilt the real domain from the platform's `lib/`+schema), consumed by a thin Next.js FE
over a `next.config.ts` proxy (`/api/*` → backend `/v1/*`, wrapped `{success,data}`). FE calls `/api/*` directly —
**never add local `app/api/*` proxy routes** (the proxy already forwards; such routes are shadowed/dead). See
[[architecture-backend-split]] + `docs/spec/04-architecture.md`.

**THE REAL MODEL (owner-confirmed — do not relitigate; [[platform-real-model]]):** sales/achievement = **upload
FINAL amounts per outlet × parameter, NO compute**; segmentation **program = a reporting/filter facet, NOT a
targeting dimension**; no point-tiers, no SKU. Validate any inherited concept against this BEFORE building
([[reconcile-fit-before-build]]) — the codebase still has speculative World-A scaffolding.

**DONE so far (brief — full records in the reconcile docs + memories):**
- **P3 Onboarding & KYC** (`api/src/kyc/*`): two-stage two-lane field-level KYC. Closes #9/#12/#13/#14/#15.
  `reconcile/P3-onboarding-kyc.md` · [[p3-kyc-complete]]. (Touching KYC: enqueue notifications only AFTER the tx
  commits; resolve the primary outlet BEFORE any status flip.)
- **P4 Programs/Targets/Enrollment** (no compute): `KpiDef` · `OutletTarget` + verbatim per-outlet×KPI×month upload ·
  achievement (`/v1/admin/achievements/*`) + pace · enrollment. Schemes ⟂ targets. Closes #6/#10/#29.
  `reconcile/P4-programs-targets-enrollment.md` · [[p4-complete]]. P5 also closed the **P4 test-debt** (stale
  geo-hierarchy wizard tests retired/updated) + added **Download Final Targets export** + **past-month upload lock**.
- **P5 Wallet, points & rewards** (`api/src/{wallet,rewards}/*`): ledger-aware wallet primitives
  (`creditEarn`/`debitRedeem`/`reverse`/`adjust`/`expireDuePoints`) writing `WalletTransaction` **+** `PointsLedger`
  atomically + expiry sweep (**closes #28**); real `RewardCategory`/`RewardCatalog` admin CRUD (retired the
  gift-config JSON blob, #18-gift); redeem → OTP(`REDEMPTION_CONFIRM`) → debit → guarded status lifecycle +
  refund-on-cancel + voucher/tracking fulfilment (inline + bulk Excel); partner wallet/rewards FE + admin
  catalogue/fulfilment FE. Money-path audit caught + fixed real double-spend/oversell bugs (guarded
  PENDING→CONFIRMED claim, one-pending-order OTP binding, guarded stock claim, FIXED_OTP prod-gate, in-tx OTP
  consume, atomic refund claim). `reconcile/P5-wallet-points-rewards.md` · [[p5-complete]].

**P6 · Finance — ✅ DONE (2026-06-18, backend).** Full record: `reconcile/P6-finance.md` + `reconcile/P6.5-TDS-SPEC.md`.
**NEXT = P0.5/P0.6 "Make It Runnable" (FE/auth/integration remediation) BEFORE P7** — full plan:
`reconcile/P0.5-make-it-runnable.md` + [[runtime-audit-p0.5]]. P7 (Engagement & support) resumes after, with the
platform-retirement residual (#31) as its opening unit. The P6 decisions below are the historical record; all shipped.

**P6 key facts (DO NOT relitigate; full record: `reconcile/P6-finance.md` + `P6.5-TDS-SPEC.md` + [[p6-finance-decisions]]):**
- **Money = integer `BigInt` paise EVERYWHERE** (#19). Shared `money.ts` (api `src/common` + platform `src/lib`);
  global `BigInt.prototype.toJSON`→Number in `main.ts`; FE converts ↔₹ ONLY at the upload-ingest + display edges.
- **Two distinct money rails (#5)** — Awards/Credits `api/src/credits` (admin *push*) vs Redemption Payouts
  `api/src/payouts` (partner *pull*). Separate, never consolidated.
- **#16** — awarded POINTS credit the **partner** wallet on confirm (`walletService.creditEarn`, race-safe claim);
  reversal → `clawbackAward` (reduces redeemablePoints ONLY; lifetime counters monotonic). Already-redeemed
  **shortfall = report-only** (`CreditReversal.shortfallPaise`; supposed/reversed/pending; client settles off-platform).
- **#8/#15 invoicing** (`api/src/invoices`) — auto idempotent per-outlet/month self-bill; re-run never mutates a PAID
  invoice; GST from the **retailer GSTIN state vs 19** (Tech Gifsy/WB, `19AAACT9811F1Z9`); number editable-while-GENERATED,
  locked-once-PAID; KYC-complete guard. Deferred: invoice PDF/email.
- **#17** — per-tenant `features.visibilityCaptureMode` (`PHOTO_APPROVAL`/`AMOUNT_UPLOAD`) + Gifsy `PUT` toggle.
- **#25 TDS** (`api/src/tds`) — **194R** (client; per-tenant/FY; 10/20% no-PAN; ₹20k threshold, retroactive) +
  **194C** (Gifsy; platform per-PAN; 1/2/20%; >₹30k single|>₹1L agg; **two columns** w/ & w/o threshold);
  **grossed-up (payer-borne)**; **PAN-keyed** (null/off-platform PAN → `__NO_PAN__` 20%); **compute+track+export ONLY**
  (Form-16A/26Q filing OFF-platform — TRACES / future 3rd-party TDS API; §206AB removed). Redemption 194R value =
  **points ÷ conversionRate**, frozen at confirm on `RedemptionOrder.valuePaise`. Off-platform + deposit Excel uploads
  (PAN-required, `uploadBatchId` dedup); liability − deposited = outstanding. **Cash redemptions (UPI/BANK_TRANSFER)
  now create a `PayoutTransaction`** (the settlement bridge) → existing payouts engine. **Audit money paths hard.**

**NEXT = P7 · Engagement & support (spec §02 WF6; 00-MASTER-PLAN §P7).** Banners, notifications, leaderboard,
tickets. Much read-side already exists (Phase S re-homed `api/src/{leaderboard,tickets,notifications}`). Tasks:
**7.0** reconcile Engagement + Support · **7.1** banner config (admin) + partner-app banners · **7.2 notification
engine** — templates/queue/delivery on the canonical **MSG91** path (**closes #21**; MSG91 = sole SMS/OTP/WhatsApp/email
provider; retire `lib/notifications.ts` axios senders + `nodemailer`; the S3 `NotificationsService.enqueue` seam +
DB template/queue exist — build the delivery worker) · **7.3** leaderboard config + snapshot + entries (ranking) ·
**7.4** ticket lifecycle + threaded messages + escalation/SLA/routing. **START P7:** confirm on `develop` + dev DB
reachable, read `00-MASTER-PLAN §P7` + the existing `api/src/{notifications,leaderboard,tickets}`, propose the P7
reconcile before building. (No P6 finance gaps remain open.)

**Residuals carried forward (NOT done — don't assume):**
- **Platform retirement (~P6, ONE unit):** stale `platform/prisma/schema.prisma` + still-live platform Prisma code
  (auth/session/client-config + the proxy-excluded `visibility/submit`+`partner/invoices`[P6] / `admin/kyc`) + the
  ~96 shadowed rollback-net route files + `lib/incentive`/`lib/kyc-approval`. **P5 note: the platform `lib/targets.ts`
  geo-hierarchy + `lib/gifts.ts`/`redemption-store.ts` demos are now dead/legacy but still imported by ~9 FE pages —
  they retire as part of this unit, NOT piecemeal.** ~120 platform files still use Prisma. Also Gap #32 `auth/logout`.
- P5 deferred: **holding/lock period** (schema fields kept — `lockedUntil`/`lockedPoints`/`LOCK_HOLDING`; ~½-day, no
  migration). `lib/invoice` reg-type read = **P6**. WhatsApp + notification worker (#21) = **P7/MSG91**. Seed `kyc:*`
  perms + enable RBAC (OFF by default — `RBAC-ENABLEMENT.md`). target-config/banner JSON-blob normalization (#18 resid).

ROLE & OPERATING MODEL (owner-agreed): you ORCHESTRATE, plan, GATE, own docs. **Per task: plan (Opus) → execute
(Sonnet executor, run in background; they have NO shell — you run the gate) → ONE independent adversarial audit
(Sonnet, Read/Grep — also no shell) → Opus gates → commit.** AUDIT EVERYTHING — don't risk-tier (audits this session
caught real DOUBLE-SPEND/oversell bugs in the redemption money-path that tsc+tests missed; also cross-tenant keys,
tx-escaping notifications, half-commits). Parallelize streams that touch disjoint files; Opus owns `schema.prisma` +
migrations so executors never collide. The gate (run it YOURSELF): `cd api && npx tsc -p tsconfig.build.json --noEmit`
(0) + `npx jest <area>` + a boot smoke for new endpoints; for FE, `cd platform && npx tsc --noEmit -p tsconfig.json` +
`npx vitest run <area>` (platform = **vitest**, not jest) + `node scripts/check-doc-consistency.mjs` GREEN. After a
task, re-run the full FE suite and diff failing FILES vs `reconcile/baseline-red-snapshot.txt` — **no NEW reds**.
Sweep docs (reconcile/gap-register/RESUME/00-MASTER-PLAN/memory) after every task. Protocol: `DOC-MAINTENANCE.md`.

CONSTRAINTS (must hold):
- WORK ON **develop**. **main = prod releases only — never push main.** **Commit/push ONLY when the owner asks.**
  Never expose secrets (grep/cut DB creds without echoing). ⚠️ Don't `git add -A` while a background FE executor is
  mid-write — it sweeps half-written files into the wrong commit (happened in P5; recoverable, local-only, but messy).
- DEV DB = Cloud SQL `gifsy-db-dev` via Auth Proxy on **127.0.0.1:5433** / `gifsy_dev` (drops after reboot — restart
  per `DEV-DB.md`). **`SELECT 1` + confirm `current_database='gifsy_dev'` before migrating.** NEVER point dev at prod.
  **NEVER `prisma migrate dev`** (RESETS gifsy_dev) — use guarded SQL via `prisma db execute --file` (no `--schema`
  flag in Prisma 7; URL comes from `prisma.config.ts`) in `api/prisma/migrations-manual/`, txn-guarded by
  `current_database='gifsy_dev'`. **`ALTER TYPE … ADD VALUE` must run OUTSIDE a transaction** (see
  `P3_doctype_split.sql` / `P5_wallet_rewards_additive.sql` for the proven shape). **SHOW migration SQL
  (independently audited) + WAIT for owner go before applying.** Never `DEMO_MODE` in staging/prod.
- ⚠️ **SCHEMA SOURCE OF TRUTH = `api/prisma/schema.prisma`** (P5 added `OtpPurpose.REDEMPTION_CONFIRM`,
  `RewardCatalog.stockQuantity`, `RedemptionOrder.voucherCode/voucherProvider`). `platform/prisma/schema.prisma` is
  stale — retires ~P6.
- CI is red-by-design (TDD-baseline fails) — gate is DIFFERENTIAL ("no NEW reds vs the snapshot").
- ⚠️ **Backend dev gotchas (recur on restart):** (1) `api/.env` was once found pointing at **PROD (`gifsy_prod`)** —
  re-verify it reads `127.0.0.1:5433/gifsy_dev` before any DB op. (2) The dev backend runs a compiled `dist/`; new
  code needs a rebuild, and repeated `tsc --noEmit` gate runs **poison `tsconfig.tsbuildinfo`** so `nest build` emits
  nothing → rebuild with `tsc -p tsconfig.build.json --incremental false`, then `node dist/main.js`. (3) The owner
  already runs servers; a stale backend may hold :4000 (`EADDRINUSE`) — find the PID
  (`Get-NetTCPConnection -LocalPort 4000`) + `Stop-Process` before starting the fresh build. Platform :3000 is Next
  dev (serves FE live from disk — no restart needed for FE changes).

Reload (read before building):
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P5 + S DONE**; **§P6 = NEXT**)
- docs/plans/MODEL-ALIGNMENT.md           (the REAL parameter model)
- docs/plans/P6-TDS-EXPLAINER.md          (TDS structure for owner review — 6.5 is HELD on its 4 questions)
- docs/plans/reconcile/{P6-finance,P6.5-TDS-SPEC,P5-wallet-points-rewards,P4-programs-targets-enrollment}.md  (build records)
- docs/plans/08-agent-execution-guide.md · GIT-WORKFLOW.md · DEV-DB.md · DOC-MAINTENANCE.md · RBAC-ENABLEMENT.md
- docs/spec/gap-register.md               (open gaps; 19 resolved; P6 magnets = #16 + #7/#8/#19/#25)
- memory: [[p6-finance-decisions]] · [[p5-complete]] · [[p4-complete]] · [[p3-kyc-complete]] · [[architecture-backend-split]] · [[platform-real-model]] · [[reconcile-fit-before-build]] · [[own-consistency-no-micromanage]]

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (restart per DEV-DB.md); platform on :3000 (Next dev) + backend on :4000
(rebuild `dist` + `node dist/main.js`). Drive the live app via the Chrome extension (not preview_start). Confirm on
`develop` + dev DB reachable. Before any migration/irreversible step, show the SQL/plan (independently audited) + wait.
```
