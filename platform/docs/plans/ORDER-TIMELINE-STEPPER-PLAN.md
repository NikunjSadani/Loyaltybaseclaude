# Partner "My Orders" — full order-timeline stepper

> **Classification: ⚠️ PLATFORM-WIDE — already APPROVED by the owner.** It changes the shared partner page
> `/partner/rewards/orders` for **every** tenant incl. live **Deoleo**. If the owner picks **D1 = C** below, the plan
> also touches shared backend money-path code (`payouts.service.ts`, `rewards.service.ts`). That is still inside the
> approved scope, but **re-confirm D1 with the owner before building the backend tasks**. No schema change and no
> migration under any option.
>
> **Status:** ✅ SHIPPED to prod (in cutovers #56–#58, 2026-11; see `GO-LIVE-ISSUE-LIST.md`). Built 2026-11-06 — `2bf64006` shared transition fn · `7506cd22` cash UTR · `2eeffbe5` all other status writers · `cf9a0c02` D4 hide never-confirmed + D5 refundedAt · `5fca4b36` step builder · `841e4fac` OrderStepper · `0a8bee73` page wiring · `96d0ff8a` /track dates. No migration, forward-only history, legacy gaps remain by design. The "Not confirmed" step (old D4=A) was not built: those orders are now hidden by the backend. Written 2026-11-06 against develop `35e6ad8c`.

---

## ✅ OWNER DECISIONS (2026-11-06) — these OVERRIDE the "recommended" answers below

| # | Owner's choice | What it means for the build |
|---|---|---|
| **D1** | **Long-term fix only** (a stronger C) | Build the **backend first**. ONE shared status-transition function in `api/src/rewards/` updates `RedemptionOrder.status` **and** inserts the `RedemptionStatusHistory` row in the **same transaction** (takes a Prisma tx client). **Every** status-changing path is routed through it — incl. the ones that write no history today: cash UTR `DELIVERED`/`FAILED` (`payouts.service.ts`), auto-supersede of abandoned `PENDING` in `redeem(` **and** `redeemForOutlet(`, both OTP-send-failure cleanups, Hubble, the confirm paths, the admin + vendor transitions. No migration, no backfill. Money-path behaviour other than the added history row stays byte-identical (proved by tests). Then the stepper loads real dates from the existing `GET /v1/rewards/orders/:id/track` when an order is expanded. |
| **D2** | **B** (plan recommendation) | Compact progress bar always visible on each card + dated vertical stepper on "View timeline". |
| **D3** | **A** — per order type (§3) | Physical / voucher / cash label sets as in §3. |
| **D4** | **B — HIDE never-confirmed orders** | `CANCELLED` orders that never reached `CONFIRMED` (no points deducted) are removed from the partner's My Orders **in the backend list endpoint** (`rewards.service` `listOrders`, member branch only) so pagination + counts stay correct. "Never confirmed" = `CANCELLED` **and** no history row with `toStatus ∈ {CONFIRMED, PROCESSING, DISPATCHED, DELIVERED, RETURNED, FAILED}` **and** `dispatchedAt`/`deliveredAt` both null (there are no confirmed/processed timestamp columns; the confirm paths have written the `CONFIRMED` history row in the same tx since day one, and only `redeem(`/`redeemForOutlet(` create orders). Admin/Gifsy order views are unchanged. The frontend's "Not confirmed" branch is therefore never reached from the list and is not built. |
| **D5** | **Refund line only when a refund was recorded** | Every refund goes through `wallet.reverse` → a `WalletTransaction` `CREDIT_REVERSAL` with `referenceType='REDEMPTION_ORDER'`, `referenceId=<order id>` (indexed). `/track` returns `refundedAt` (that row's `createdAt`, or `null`) and the stepper shows "Points refunded to your wallet" **only** when it is set. The compact bar (no `/track` fetch) never shows refund copy. |

The remaining sections below are the original plan; where they say "recommended … D1=B / D4=A / D5=A", read the
table above instead. Task 5 (backend) now runs **first**, generalised to the shared function.

## OPEN DECISIONS for the owner (answered above — kept for the record)

**D1 — Where do the step dates come from?** *(this is the main one)*
The backend already keeps a per-transition audit table (`RedemptionStatusHistory`), and a member-safe endpoint that
returns it (`GET /v1/rewards/orders/:id/track`) **already exists. It is tested but no screen calls it.** The list
endpoint the page uses today does **not** return history. Only these columns hold dates: `createdAt`,
`dispatchedAt`, `deliveredAt`, `cancelledAt`. Some code paths also skip writing a history row (see §2.4).
- **A. Frontend-only, status-derived.** The stepper is built from the current `status` plus the four date columns.
  "Confirmed", "Processing", "Failed" and "Returned" steps show **no date**. Zero backend risk.
- **B. Frontend-only, but load the existing `/track` endpoint when the partner expands an order** *(recommended)*.
  Every transition that wrote a history row gets its real date. Gaps fall back to the date columns, and then to
  "no date". **No backend change at all.** It costs one small request per expanded order.
- **C. B + forward-only additive history writes** in the 3 backend paths that skip them today: cash UTR
  `DELIVERED`/`FAILED`, the supersede/OTP-fail auto-cancel, and order creation. No migration, no backfill. Old
  orders keep their gaps. This touches the money-path transaction in the UTR upload.
- **D. Return full history inside the list endpoint** (`listOrders`). *Not recommended:* every list call would
  carry every order's history (N×M rows) even though most cards are never expanded.

**D2 — How is the stepper laid out on the page?**
- **A.** Replace today's "View timeline" list with a vertical stepper, still collapsed by default.
- **B.** A compact **horizontal progress bar always visible on each card** (status only, no fetch). "View timeline"
  expands a **vertical, dated stepper**. *(recommended)*
- **C.** A separate order-detail page `/partner/rewards/orders/[id]` holding the stepper. *(More surface; YAGNI for
  now.)*

**D3 — What step labels does each order type use?** *(recommended = the table in §3. Answer "as in §3" or edit
it)*
- **A.** Use §3 as written: per-type labels, e.g. physical "Dispatched", voucher "Voucher issued", cash "Paid to
  your bank". *(recommended)*
- **B.** One generic label set for all types (Placed → Confirmed → Processing → Completed).

**D4 — How do orders that were never confirmed appear?** These are `PENDING` orders cancelled automatically when
the partner abandoned the OTP or started a new redemption. **No points were ever deducted.** Today they show as a
red "Cancelled" card.
- **A.** Keep them in the list. The stepper reads "Order placed ✓ → **Not confirmed** ✗" with the sub-line "OTP
  not completed — no points were deducted". *(recommended)*
- **B.** Hide them from My Orders. *(This changes what the list shows, so it is a bigger change.)*
- **C.** Treat them the same as any other cancel.

**D5 — Should the stepper tell the partner that points were refunded?** Cancel, fail and return all refund the
points, except a cancel from `PENDING`, which never deducted any.
- **A.** Show "Points refunded to your wallet" under a Cancelled, Failed or Returned step **only when the order
  provably reached Confirmed** (a `CONFIRMED` history row, or any later dated column). Otherwise say nothing.
  *(recommended)*
- **B.** Always show it on those statuses. *(This would be wrong for never-confirmed orders.)*
- **C.** Never show refund copy.

> The task list below assumes the recommended answers **D1=B, D2=B, D3=A, D4=A, D5=A**. Tasks marked
> **[C-only]** run only if the owner picks D1=C. If D1=A, skip Task 4 and use only the status-derived path.

---

## 0. Read this first (zero-context primer)

**The product.** Loyaltybase is a multi-tenant trade-loyalty platform. "Partners" (retail outlet owners) earn
points and redeem them for a **physical gift**, a **gift voucher**, or a **cash payout to their bank** (UPI /
bank transfer). Every redemption creates one **`RedemptionOrder`**. Each tenant ("brand", e.g. Deoleo, Bajaj) has
its own partners. Shared partner code changes the page for **every** brand, which is why this change is
"platform-wide".

**Architecture.** `api/` is NestJS + Prisma and owns the DB and **all** business logic. `platform/` is a thin
Next.js frontend. The browser calls same-origin `/api/*`, and `platform/next.config.ts` rewrites that to backend
`/v1/*`. `platform/src/proxy.ts` injects the `x-active-partner-id` header on the way through: one login can operate
several sibling outlets, and the header says which one. **Never add that header yourself.** A plain
`fetch('/api/…')` already gets it.

**⚠️ This Next.js version differs from what you know.** Read `platform/AGENTS.md`. If you touch routing or data
fetching, read the matching guide in `platform/node_modules/next/dist/docs/`. This plan only edits a `'use client'`
page and adds pure TS + a presentational component, so you should not need any new Next API.

**Repo rules you must follow** (from the root `CLAUDE.md`). Work on branch `develop`. Never push without the
orchestrator. Run the full gate before the last commit. Commit footer:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### 0.1 The order lifecycle (memorise this)

`RedemptionStatus` enum (`api/prisma/schema.prisma`, search `enum RedemptionStatus`):
`PENDING · CONFIRMED · PROCESSING · DISPATCHED · DELIVERED · CANCELLED · RETURNED · FAILED`.
There is **no `REJECTED`** status. `REVERSED` appears in some frontend maps but is **not** a backend order status.
Treat it like any unknown status.

| Status | Meaning to the partner | Who sets it / where |
|---|---|---|
| `PENDING` | Order created, **waiting for the partner's OTP**. No points deducted yet. | `rewards.service.ts` `redeem(` / `redeemForOutlet(` |
| `CONFIRMED` | OTP done, points deducted. | `confirmRedeem(` / `confirmRedeemForOutlet(` (writes history PENDING→CONFIRMED) |
| `PROCESSING` | Ops (or Hubble) is fulfilling it. | `transitionOrder(` (Gifsy console), vendor portal, `markHubbleProcessing(` |
| `DISPATCHED` | Physical parcel shipped (tracking may be set). Stamps `dispatchedAt`. | `transitionOrder(`, `vendor-portal.service.ts` |
| `DELIVERED` | Parcel delivered / voucher issued / cash paid. Stamps `deliveredAt`. | `transitionOrder(`, vendor portal, `storeHubbleSuccess(`, **cash UTR upload** (`payouts.service.ts`) |
| `CANCELLED` | Cancelled; points refunded **if** they had been deducted. Stamps `cancelledAt`. | `transitionOrder(`, **auto-supersede** of abandoned PENDING in `redeem(`, OTP-send failure cleanup |
| `FAILED` | Fulfilment failed; points refunded. **No dedicated timestamp column.** | `transitionOrder(`, `refundAndFailHubble(`, **cash UTR = FAILED** (`payouts.service.ts`) |
| `RETURNED` | Gift came back / value reversed; points refunded. **No timestamp column** (the list endpoint fakes `returnedAt = updatedAt`). | `transitionOrder(` |

Legal manual edges (`transitionOrder`, search `const allowed: Record<string, RedemptionStatus[]>`):
`PENDING→CANCELLED`, `CONFIRMED→PROCESSING|CANCELLED|RETURNED`, `PROCESSING→DISPATCHED|FAILED|CANCELLED`,
`DISPATCHED→DELIVERED|RETURNED`, `DELIVERED→RETURNED`. Automated paths can **skip** steps:
- **Hubble vouchers** go `CONFIRMED→DELIVERED` directly. Their history row has `fromStatus = null`.
- **Cash orders** go `CONFIRMED→DELIVERED` or `CONFIRMED→FAILED` from the UTR upload.

**So the stepper must never assume every step happened.** A step that was skipped but is "behind" the current
status renders as complete **without a date**.

### 0.2 Order types (how the partner page tells them apart)

The order's `redemptionMode` (`PayoutMode` enum) is `GIFT_CARD · UPI · BANK_TRANSFER · PHYSICAL_GIFT`. The frontend
also treats `VOUCHER` as a voucher.
- **Voucher:** `redemptionMode ∈ {GIFT_CARD, VOUCHER}` **or** `voucherCode` is present. This is the existing rule
  `isVoucher` in `page.tsx`. Keep it.
- **Cash:** `redemptionMode ∈ {UPI, BANK_TRANSFER}`.
- **Physical:** everything else (`PHYSICAL_GIFT`, or a missing mode).

Ops sometimes march a **manual** voucher through `PROCESSING` or even `DISPATCHED` before delivering. The page
comment above `showVoucher` explains this. For vouchers, "Voucher issued" is complete when **`voucherCode` is set
OR status is `DELIVERED`**.

### 0.3 Member-safe data rule (security, do not break)

The partner must **never** see ops-only fields: `fulfilmentChannel`, `supplierOrderRef`, `fulfilledByVendorId`,
`podUrl`, `notes`, `valuePaise`, or the history `notes` / `changedById`. The `/track` endpoint already selects
only `{ fromStatus, toStatus, createdAt }` for history. A Jest test locks that in: `rewards.service.spec.ts`,
`describe('trackOrder (member-safe tracking) — audit #5'`. Existing frontend test `MT4` in
`orders-tracking.test.tsx` checks the UI. **Keep both green, and never widen those selects.**

### 0.4 Tests and tooling

- **Frontend:** Vitest + React Testing Library on jsdom. Single file:
  `cd platform && npx vitest run src/lib/__tests__/order-timeline.test.ts`
  (add `-t "name fragment"` for one case). Existing page tests to copy setup from:
  `platform/src/app/partner/rewards/orders/__tests__/orders-api.test.tsx` and `orders-tracking.test.tsx`. They stub
  `global.fetch` with `vi.stubGlobal`.
- **Backend (C-only tasks):** Jest. Single file / case:
  `cd api && npx jest src/payouts/payouts.service.spec.ts -t "UTR"` (use `--no-coverage` for speed). Prisma is
  mocked as `mockPrisma` in each spec. Copy the patterns already in the file.
- **Node on this machine:** prefix shell commands with `export PATH="$HOME/.local/node/bin:$PATH";`.
- **Gate (must be green before the final commit):** from repo root, `bash scripts/gates.sh`. Read **its** exit code
  and the `GATES: ✅` line. **Never** trust a piped exit code (`… | tail` always exits 0). `--fast` runs only the
  compile gates.

**Good test design here (please follow).**
- Put the logic in a **pure function** (`buildOrderSteps`) and test it exhaustively with plain objects. No React,
  no fetch. The component tests then only check the wiring (does it render what the function returns, does it
  fetch at the right time).
- Test **what the partner sees**: step labels, which step is current, which is failed, which date is shown. Query
  by text/role/`data-testid`, never by CSS class.
- One behaviour per `it(...)`, named as a sentence of the rule.
- Always include the **edge case that motivated the rule**: skipped steps (Hubble, cash), missing history (legacy),
  never-confirmed cancels, unknown statuses.
- Write the test FIRST, run it, **watch it fail for the right reason**, then implement.
- Use fixed ISO dates in fixtures. Never use `new Date()`, or tests become flaky.

**Principles.** DRY: one step-builder, used by both the compact bar and the detailed stepper. YAGNI: see the last
section. One task = one commit.

---

## 1. Landmarks (files and what's in them)

| What | Where (search for the quoted text) |
|---|---|
| Partner orders page (the only page you change) | `platform/src/app/partner/rewards/orders/page.tsx` (~340 lines). Today's timeline: `function buildTimeline(o: ApiOrder)` and the `{/* Timeline */}` block |
| Its tests | `platform/src/app/partner/rewards/orders/__tests__/orders-api.test.tsx` (OR1–OR7), `orders-tracking.test.tsx` (MT1–MT4) |
| Member list endpoint | `api/src/rewards/rewards.service.ts` `async listOrders(` (member-safe `select`, synthesises `returnedAt`, default `limit` 20) |
| Member **track** endpoint (already exists, unused by UI) | same file, `async trackOrder(`. Route `@Get('orders/:id/track')` in `api/src/rewards/rewards.controller.ts`. Frontend URL: `/api/rewards/orders/<id>/track` → `{ success, data: { tracking: { status, …, timeline: [{ fromStatus, toStatus, createdAt }] } } }` |
| History table | `api/prisma/schema.prisma` `model RedemptionStatusHistory` (`fromStatus?`, `toStatus`, `changedById?`, `notes?`, `createdAt`). In the baseline migration since day 1 |
| Ops transition (writes history + date columns) | `rewards.service.ts` `async transitionOrder(` |
| Vendor transition (writes history) | `api/src/vendor/vendor-portal.service.ts` (search `redemptionStatusHistory.create`) |
| Hubble voucher paths (write history, `fromStatus: null` on DELIVERED/FAILED) | `rewards.service.ts` `storeHubbleSuccess(`, `markHubbleProcessing(`, `refundAndFailHubble(` |
| Cash UTR upload (**no history row**) | `api/src/payouts/payouts.service.ts`, search `Complete the linked redemption (DELIVERED)` and `Reverse the redemption points ONCE` |
| Auto-cancel of abandoned PENDING (**no history row**) | `rewards.service.ts`, search `Supersede the ACTIVE partner's abandoned PENDING` (and the same in `redeemForOutlet`), plus `cleanup after OTP-send failure` (2 places) |
| Admin equivalent (reference only, do not change) | `platform/src/lib/gift-orders.ts` `export function buildTimeline(` (prefers history, falls back to columns), used by `platform/src/app/admin/gift-orders/[id]/page.tsx` |
| Existing stepper visual to copy the look from | `platform/src/app/sales/kyc/[id]/page.tsx` `function StepDot(` and `function ApprovalTimeline(` (states: complete / active / rejected / pending) |
| Date helpers | `platform/src/lib/utils.ts` `formatDate(`, `formatDateTime(` |
| Design background | `platform/docs/plans/GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md` §"Status lifecycle" / "Member view" (line ~110) |

---

## 2. Current state (what exists today and what's wrong)

1. **The page already has a "timeline", but it is a flat list of dated bullets** (`buildTimeline` in `page.tsx`)
   behind a "View timeline" toggle. It shows only steps that have a date, so the partner never sees what is
   **still to come**, and there is no failed or cancelled branch styling.
2. **It reads fields the backend never sends.** `ApiOrder.confirmedAt` and `ApiOrder.processedAt` do not exist in
   the `listOrders` select, so they are always `undefined`. The test fixture `VOUCHER_ORDER` in
   `orders-api.test.tsx` sets `confirmedAt` anyway, which is misleading. `returnedAt` is synthesised server-side as
   `updatedAt`.
3. **Real per-transition dates exist** in `RedemptionStatusHistory`, and the member-safe `/track` endpoint exposes
   them. No screen calls it.
4. **History has known gaps.** Some writers skip the history row:
   - Order creation: no `PENDING` row. `createdAt` covers "placed", so this is fine.
   - Auto-supersede / OTP-fail cancel (`PENDING→CANCELLED`): no row, but `cancelledAt` is stamped.
   - Cash UTR `DELIVERED`: no row, but `deliveredAt` is stamped.
   - Cash UTR `FAILED`: no row and **no date at all** (only `updatedAt`, which any later edit can move).
   - `FAILED` and `RETURNED` have no dedicated date column anywhere.
   - Hubble rows have `fromStatus: null`. Always use `toStatus`.
5. **Legacy orders:** the history table exists since the baseline migration, and console/vendor/confirm paths have
   always written it. So most orders have history, **except** every cash order's final step and every
   auto-cancel. The engineer must still handle "history is empty" (e.g. if `/track` fails), falling back to the
   date columns, then to undated.
6. **The list only shows the newest 20 orders.** The page calls `/api/rewards/orders` with no `page`. This is not
   part of this feature (see Out of scope), but don't be surprised by it.

---

## 3. Target behaviour (the spec your tests encode)

**Step model.** `buildOrderSteps(order, history?)` returns an ordered array of
`{ key, label, state: 'complete' | 'current' | 'upcoming' | 'failed', date?: string, sublabel?: string }`.
- **Happy-path steps by type (D3=A):**
  - Physical: `placed` "Order placed" → `confirmed` "Confirmed" → `processing` "Processing" → `dispatched`
    "Dispatched" → `delivered` "Delivered".
  - Voucher: `placed` "Order placed" → `confirmed` "Confirmed" → `issued` "Voucher issued".
    Processing is folded into "Confirmed → Voucher issued" because vouchers are near-instant. If the order is in
    `PROCESSING` or `DISPATCHED` without a code, "Voucher issued" is `current` with sublabel "Being processed".
  - Cash: `placed` "Request placed" → `confirmed` "Confirmed" → `paid` "Paid to your bank".
- **Where the order is:** every step up to the current status is `complete`, the step for the current status is
  `current`, and the rest are `upcoming`. **Exceptions:** `DELIVERED` (and voucher `issued`, cash `paid`) is the
  last step and renders `complete`, not `current`. A finished order has no "current" step.
- **`PENDING`:** "Order placed" is `complete`, "Confirmed" is `current` with sublabel "Waiting for OTP
  confirmation".
- **Terminal branches** (`CANCELLED`, `FAILED`, `RETURNED`): keep the steps that were completed, then **append one
  `failed` step** and **drop the remaining upcoming steps**. A cancelled order should not show "Delivered" as
  upcoming.
  - Labels: "Cancelled", "Failed" (cash: "Payment failed"), "Returned".
  - The step before the branch is the last step that was actually reached. Use history (latest `toStatus` before
    the terminal row) or, without history, the date columns: `dispatchedAt` ⇒ reached Dispatched; `deliveredAt` ⇒
    reached Delivered (e.g. `DELIVERED→RETURNED`). Otherwise assume it reached **Confirmed**, except
    `CANCELLED` + never confirmed (next bullet).
  - **Never confirmed (D4=A):** `CANCELLED` with no `CONFIRMED` history row and no `dispatchedAt` / `deliveredAt`
    ⇒ steps are "Order placed" ✓ → "Not confirmed" (failed) with sublabel "OTP not completed — no points were
    deducted".
  - **Refund copy (D5=A):** on a `failed` step, sublabel "Points refunded to your wallet" only when the order
    provably reached Confirmed: a `CONFIRMED` history row, or `dispatchedAt` / `deliveredAt` set.
- **Dates on a step.** Use, in order of preference:
  1. The `createdAt` of the **latest** history row whose `toStatus` matches that step. Latest, because an order can
     revisit a status in theory and the newest one is the truth.
  2. The column: `placed`←`createdAt`, `dispatched`←`dispatchedAt`, `delivered` / `issued` / `paid`←`deliveredAt`,
     `Cancelled`←`cancelledAt`.
  3. No date (render nothing, **never** "Invalid Date", never `updatedAt`, which is unreliable).
- **Skipped steps** (Hubble `CONFIRMED→DELIVERED`, cash) are `complete` with no date.
- **Unknown status** (e.g. `REVERSED`, or a future enum value): render "Order placed" ✓ plus one `current` step
  labelled with the raw status. Never throw.
- Sort history by `createdAt` ascending before using it. Do not trust API order.

**Display (D2=B).**
- **Compact bar** (always visible on each card): built from `buildOrderSteps(order)` with **no history** (no
  fetch), showing labels only, no dates. Horizontal dots + connectors, the current label in bold.
  `data-testid="order-stepper-compact"`. On a 360px-wide phone it must fit with no horizontal page scroll. Show the
  labels only for the first, current and failed step if space is tight, and give each dot an `aria-label`.
- **Detailed stepper** (on "View timeline"): vertical, with dates (`formatDateTime`), the sublabels, and the
  tracking note on the Dispatched step ("Tracking: <number>"), as today. `data-testid="order-stepper-detail"`.
  Each step is `data-testid="order-step-<key>"` with `data-state="<state>"`, so tests can assert state without CSS.
- Accessibility: wrap it in `<ol>`. The current step gets `aria-current="step"`.

---

## 4. Tasks (one task = one commit)

### Task 1 — Pure step builder `buildOrderSteps` (no UI change)

**Files:** new `platform/src/lib/order-timeline.ts`; new test `platform/src/lib/__tests__/order-timeline.test.ts`.

1. **Tests first.** Use plain object fixtures with fixed ISO dates. Export the input types from the module:
   `OrderTimelineInput` (status, redemptionMode, voucherCode, createdAt, dispatchedAt, deliveredAt, cancelledAt,
   trackingNumber) and `HistoryEntry` (`{ fromStatus: string | null; toStatus: string; createdAt: string }`).
   Cases:
   - **Physical happy paths:** `PENDING` → placed complete, confirmed current ("Waiting for OTP confirmation"),
     rest upcoming. `PROCESSING` with history [P→C, C→PR] → placed / confirmed complete with history dates,
     processing current. `DISPATCHED` with `dispatchedAt` and `trackingNumber` → the dispatched step has that date
     and sublabel "Tracking: TN1". `DELIVERED` → all 5 complete, **none** `current`.
   - **History beats column:** a DISPATCHED history row at 10:00 and `dispatchedAt` 10:00:05 → uses the history
     date.
   - **Latest history row wins** when two rows share a `toStatus`.
   - **Unsorted history** input still produces correct dates and order.
   - **Legacy, no history:** `DELIVERED`, no history, only `createdAt` and `deliveredAt` → confirmed / processing
     / dispatched are complete **without** `date`, and delivered has `deliveredAt`.
   - **Hubble voucher:** mode `GIFT_CARD`, `DELIVERED`, history `[ {fromStatus:null,toStatus:'DELIVERED'} ]`,
     `voucherCode` set → 3 voucher steps, all complete, issued dated from history, confirmed undated.
   - **Manual voucher stuck in `DISPATCHED`** without a code → issued is `current`, sublabel "Being processed".
     With a code → issued is complete.
   - **Cash:** mode `UPI`, `DELIVERED`, no DELIVERED history row, `deliveredAt` set → "Paid to your bank"
     complete with `deliveredAt`. Mode `BANK_TRANSFER`, `FAILED`, history [P→C] only → placed ✓, confirmed ✓, a
     final failed step "Payment failed" **with no date**, sublabel "Points refunded to your wallet".
   - **Cancelled after confirm:** history [P→C, C→CANCELLED] → placed ✓ confirmed ✓ Cancelled (failed, dated,
     "Points refunded…"). No upcoming steps remain.
   - **Never confirmed (D4):** `CANCELLED`, no history, `cancelledAt` set → exactly 2 steps: placed ✓ and "Not
     confirmed" (failed) with "OTP not completed — no points were deducted". **No** refund copy.
   - **Failed from processing:** history [P→C, C→PR, PR→FAILED] → 3 complete + Failed.
   - **Returned after delivery:** `RETURNED`, `deliveredAt` set, no history → all physical steps up to delivered
     complete, then Returned (failed, undated, refund copy).
   - **Unknown status** `REVERSED` → placed ✓ plus one `current` step labelled "REVERSED". Does not throw.
   - **Never** produces a step whose `date` is `undefined`-stringified, `'Invalid Date'`, or equal to `updatedAt`.
     Put `updatedAt` in a fixture and assert it is not used.
2. Run: `cd platform && npx vitest run src/lib/__tests__/order-timeline.test.ts` → fails (module missing).
3. Implement `export function buildOrderSteps(order, history = [])` plus `export function orderKind(order):
   'physical' | 'voucher' | 'cash'`. `orderKind` must use the same rule as `isVoucher` in `page.tsx` (§0.2).
   Keep it pure, under ~120 lines, with no imports from React.
   Suggested shape: (a) pick the step template by kind; (b) compute the "reached index" from status, history and
   columns; (c) map each template step to a state; (d) if the status is terminal, slice to the reached steps and
   append the failed step; (e) attach dates.
4. Green → commit `feat(partner): pure order-timeline step builder (platform-wide)`.

### Task 2 — Presentational `OrderStepper` component (compact + detail variants)

**Files:** new `platform/src/components/partner/order-stepper.tsx`; new test
`platform/src/components/partner/__tests__/order-stepper.test.tsx`. Create the `partner/` folder. Keep it out of
`components/ui/`, because it is order-specific.

1. **Tests first:** render `<OrderStepper steps={…} variant="detail" />` with hand-built `steps` (no builder, so
   this test is independent):
   - Renders an `<ol>` with one `<li data-testid="order-step-<key>" data-state="…">` per step, in order.
   - The `current` step has `aria-current="step"`. Others do not.
   - A step with `date` shows the formatted date text. A step without one renders **no** date element. Assert
     with `queryByTestId('order-step-date-<key>')` returning null.
   - Sublabels render.
   - `variant="compact"` renders `data-testid="order-stepper-compact"`, shows **no dates**, and gives each dot an
     `aria-label` equal to the step label plus state (e.g. "Dispatched — current").
2. Run → fail.
3. Implement. Copy the **visual language** of `StepDot` / `ApprovalTimeline` in
   `platform/src/app/sales/kyc/[id]/page.tsx` (emerald complete, amber current, red failed, grey upcoming, lucide
   `CheckCircle` / `Clock` / `XCircle`). **Do not import from or edit that KYC page.** Copy the ~20 lines of
   markup; refactoring KYC is out of scope. Use `var(--brand-primary)` only where the existing orders page
   already does (links). Status colours stay semantic.
4. Green → commit `feat(partner): OrderStepper component, compact + detail (platform-wide)`.

### Task 3 — Wire the compact bar + status-only detail into the orders page; drop dead fields

**Files:** `platform/src/app/partner/rewards/orders/page.tsx`; update `__tests__/orders-api.test.tsx` and
`__tests__/orders-tracking.test.tsx`.

1. **Tests first** (add them to `orders-tracking.test.tsx` as `MT5…`):
   - A DISPATCHED physical order shows `order-stepper-compact` with the dispatched dot as current. No fetch
     beyond the list call: assert `fetch` was called exactly once, with `/api/rewards/orders`.
   - A CANCELLED, never-confirmed order (no history, `cancelledAt` set) shows "Not confirmed" in the compact bar.
   - **MT4 still passes**: expand the timeline and still see no ops-only text.
   - Update fixtures: remove `confirmedAt` from `VOUCHER_ORDER` (the backend never sends it). Keep OR5–OR7
     (voucher code + copy + tracking link) unchanged and green. They are regression guards.
2. Run → fail.
3. Implement:
   - Delete the local `buildTimeline`, `TimelineStep`, and the `timeline` field on `Order`. Remove `confirmedAt` /
     `processedAt` from `ApiOrder`. Keep `returnedAt` out too: the builder doesn't use it.
   - Keep `ApiOrder`'s raw date columns on `Order` (or keep the `ApiOrder` itself) so the builder can read them.
   - Under the badge row, render `<OrderStepper variant="compact" steps={buildOrderSteps(order)} />`.
   - Replace the `{/* Timeline */}` block with `<OrderStepper variant="detail" steps={buildOrderSteps(order)} />`.
     History comes in Task 4. If D1=A, this is the final state.
   - Keep the "View timeline / Hide timeline" toggle text. Existing tests click it.
4. Green (run both orders test files) → commit
   `feat(partner): order stepper on My Orders, status-derived (platform-wide)`.

### Task 4 — Load real dates from `/track` when a timeline is expanded (D1 = B or C)

**Files:** `page.tsx`; new test `platform/src/app/partner/rewards/orders/__tests__/orders-timeline-history.test.tsx`
(copy `stubOrders` from `orders-tracking.test.tsx`, but make `fetch` a `vi.fn` that routes by URL).

1. **Tests first:**
   - Expanding order `o1` calls `fetch('/api/rewards/orders/o1/track', …)` **once**. Collapsing and expanding again
     does **not** call it again (cached per order id).
   - **Not** called before expanding, and not for other orders.
   - With a `/track` response whose `timeline` has `{toStatus:'CONFIRMED', createdAt:'2026-05-01T01:00:00.000Z'}`,
     the confirmed step shows that date (`order-step-date-confirmed` exists).
   - While loading, the detail stepper still renders the status-only steps. Don't blank it, and don't show a
     spinner that hides it.
   - **`/track` failure** (`ok:false`, `success:false`, or a rejected promise) → the status-only stepper stays,
     there is no error toast, and nothing throws. The timeline is a nice-to-have. The order card must never break.
   - Response shape is `{ success: true, data: { tracking: { timeline: [...] } } }`. Unwrap it the same way the
     list call does.
2. Run → fail.
3. Implement: `const [historyById, setHistoryById] = useState<Record<string, HistoryEntry[]>>({})`. When expanding
   an id that has no entry in `historyById`, fetch the track endpoint. On success, store `tracking.timeline`. On
   failure, store `[]` so it is not refetched in a loop. Pass `historyById[order.id]` into `buildOrderSteps` for
   the **detail** stepper only. The compact bar stays status-only, so the list never fans out N requests. Use the
   same `fetch(…, { headers: { ...authHeader() } })` style as `load`. `proxy.ts` adds the active-partner header.
   Do **not** add a backend route: `trackOrder` already scopes to the active partner and is member-safe.
4. Green → commit `feat(partner): dated order timeline from status history (platform-wide)`.

### Task 5 — [C-only] Write the missing history rows (forward-only, no migration)

Only if the owner picked **D1=C**. Each sub-step is its **own commit**. These are money-path files: change
**nothing** except adding the history insert inside the existing transaction, conditional on the existing claim
succeeding.

**5a — Cash UTR DELIVERED / FAILED** (`api/src/payouts/payouts.service.ts`; spec `payouts.service.spec.ts`).
- Tests first:
  - A SUCCESS UTR row for a txn with `redemptionOrderId` creates
    `redemptionStatusHistory` `{ orderId, fromStatus: <prior status>, toStatus: 'DELIVERED', changedById: <uploader> }`
    **only when** the `updateMany` count is 1.
  - An already-terminal order (count 0) creates **no** row.
  - A FAILED UTR row creates a `toStatus:'FAILED'` row.
  - **Re-uploading** the same file creates no duplicate. The existing idempotency claim must gate the insert:
    for FAILED, gate on the order's status **before** the update not being `FAILED`, by reading it in the
    existing `findFirst` (add `status` to its select).
  - Notes stay null. History `notes` is ops-only anyway, but don't put bank remarks there.
- Implement: in the SUCCESS branch, capture the `updateMany` result and `if (res.count > 0) await
  tx.redemptionStatusHistory.create(...)`. `fromStatus` is unknown there, so pass `null` (the frontend uses only
  `toStatus`). In the FAILED branch, add `status` to the `findFirst` select and write the row only if
  `order.status !== 'FAILED'`.
- Commit `feat(api): record status history for cash UTR completion/failure (platform-wide)`.

**5b — Auto-cancel of abandoned PENDING** (`rewards.service.ts`, both `redeem(` and `redeemForOutlet(` supersede
blocks, plus both OTP-send-failure cleanups; spec `rewards.service.spec.ts`).
- Tests first:
  - Superseding 2 PENDING orders writes 2 history rows `PENDING→CANCELLED` with
    `notes: 'Superseded — OTP not completed'`, and `changedById: user.sub`.
  - Zero PENDING orders → no `createMany` call, or an empty one.
  - The OTP-fail cleanup writes 1 row.
- Implement: before the `updateMany`, run `findMany({ where: <same where>, select: { id: true } })` inside the same
  tx, then `updateMany`, then `redemptionStatusHistory.createMany`. Keep the existing `where` byte-identical.
- Commit `feat(api): record status history for auto-cancelled pending redemptions (platform-wide)`.

*(Skip writing a `PENDING` creation row. `createdAt` already dates "Order placed". YAGNI.)*

### Task 6 — Docs + full gate

**Files:** `platform/docs/plans/GO-LIVE-ISSUE-LIST.md` and `platform/docs/plans/RESUME.md`. Add a short entry
under the current develop/staging section, following the existing entry style. Mark this plan's **Status** line
as BUILT with the commit SHAs. If D1=C, note "no migration, forward-only history, legacy gaps remain by design".

1. `bash scripts/gates.sh` → must print `GATES: ✅ all passed.` (exit 0). If a suite flakes, re-run that ONE file
   alone to tell a flake from a regression. Never weaken an assertion to make it pass.
2. Commit `docs: order-timeline stepper status (platform-wide)`.
3. Do **not** push. The orchestrator runs the independent review and staging verification, then pushes with the
   owner's OK. The repo's push hook will ask the platform-wide checklist.

---

## 5. How to verify on staging (orchestrator / owner)

Staging hosts follow `uat-<slug>.gifsy.in` (e.g. `https://uat-deoleoloyalty.gifsy.in`,
`https://uat-bajaj.gifsy.in`). Staging OTP is fixed. The owner completes real logins.

1. Partner login → `/partner/rewards/orders`. Every card shows the compact bar. Check one order of each kind:
   - physical DISPATCHED: Dispatched current, tracking link still there;
   - DELIVERED physical: all complete, no current;
   - voucher: code block still visible, "Voucher issued" complete;
   - cash (if the tenant has cash redemptions): "Paid to your bank";
   - a CANCELLED and a FAILED order: red branch, no upcoming steps;
   - an abandoned-OTP order: "Not confirmed", no refund copy.
2. Tap "View timeline" on each. Steps show real dates where history exists. Network tab: exactly one
   `/api/rewards/orders/<id>/track` per first expand, none on re-expand, and the response contains **no**
   `notes` / `changedById` / `fulfilmentChannel`.
3. Narrow to a 360px phone width. No horizontal page scroll, and the compact bar is legible.
4. **Multi-outlet partner** (a login with a switched sibling outlet): after switching outlet, expand an order. The
   `/track` call returns 200, not 403, which proves the proxy header reaches it.
5. Gifsy admin `/admin/gift-orders/<id>`: unchanged (regression check). Move a test order CONFIRMED→PROCESSING→
   DISPATCHED in the console, then reload the partner page. The steps advance with fresh dates.
6. **Optional data check** (owner-run only: staging and prod share one DB instance, so start with a
   `SELECT current_database();` guard and read-only SQL):
   `SELECT o.status, o."redemptionMode", count(*) FILTER (WHERE h.id IS NULL) AS no_history, count(*)
   FROM redemption_orders o LEFT JOIN redemption_status_history h ON h."orderId" = o.id GROUP BY 1,2;`
   This sizes how many orders will show undated steps. The rows are expected to be cash and auto-cancelled.

---

## 6. Out of scope (YAGNI — do not build)

- No schema change: no `failedAt` / `returnedAt` / `confirmedAt` columns, and no migration of any kind.
- No **backfill** of history for old orders. Legacy gaps render as undated complete steps by design.
- No separate order-detail route (`/partner/rewards/orders/[id]`). D2=C was not chosen.
- No live courier tracking or polling of the logistics partner. The existing `trackingUrl` link is enough.
- No auto-refresh or polling of order status. Pull-to-refresh / reload is enough.
- No pagination or "load more" on My Orders (today's 20-order cap is a separate issue; raise it with the owner if
  you think it matters).
- No changes to the admin gift-orders timeline (`platform/src/lib/gift-orders.ts`), the vendor portal UI, or
  notifications.
- No refactor of the sales KYC `ApprovalTimeline` to share the new component. A possible later DRY follow-up, but
  it touches a different, live surface.
- No exposure of ops-only fields (fulfilment channel, supplier ref, vendor, POD, notes, actor names) to partners.
- No Hubble "needs reconcile" banner (`metadata.hubbleNeedsReconcile` is ops-only).
- No `PENDING` creation history row (Task 5 note). No i18n or translation work beyond the existing English copy.
- No per-tenant flag or config for the stepper: it is approved platform-wide.
