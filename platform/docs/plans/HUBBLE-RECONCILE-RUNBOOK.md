# Hubble gift-card orders — reconcile runbook (ops)

**Who:** Gifsy admins (role `GIFSY_ADMIN`, permission `rewards:manage_orders`). Client admins see a view-only list.
**Where:** admin portal, assumed into the tenant → **Gifts → Orders**. A Hubble order that needs attention shows a
review flag with a plain-language reason and the buttons that apply to it.
**Applies to:** tenants with the flag `hubbleVoucherEnabled` — today **Bajaj** (live on prod). Behaviour as of the
2026-11-15 release (`2eb8271d`). Code: `api/src/rewards/rewards.service.ts` (Hubble section), `api/src/hubble/`,
screen `platform/src/app/admin/gifts/page.tsx`. Keep this file in step with those.

## 1. The one rule

**A timeout is not a "no".** If we can't tell whether Hubble created a voucher, the order stays open and the points
stay deducted. Points are returned only when Hubble itself clearly says it has no order (checked as below). Never
refund a Hubble order by hand or in the database — the screens below are the only exits, and each one is audited.

## 2. What happens when a retailer confirms a Hubble redemption

| Hubble's answer at confirm | What we do | What the retailer sees |
|---|---|---|
| Voucher issued | Order DELIVERED, code + PIN shown | the voucher |
| Hubble still processing | Order stays open; the **automatic re-check** (§2a) finishes it (a webhook or ops retry also can) | "processing" |
| **Definitive rejection** (HTTP 400/422 with Hubble's own business error) **and** Hubble's lookup says "no such order" **and** the canary check passes (§4; at confirm max 2 tries / 20 s) | Order FAILED, points refunded at once | refund message with order number and date |
| Hubble failed the order | Order FAILED, points refunded | refund message |
| **Anything else** — timeout, network error, 5xx, 401/403/404/408/409/429, a rejection whose wording suggests a retry/duplicate/limit, an unverified "no order", an unexpected error | Order **CONFIRMED + flagged** (`HUBBLE_INDETERMINATE` or `HUBBLE_UNEXPECTED`). **No refund.** | "Redemption confirmed. Your voucher is taking longer than usual — we're checking with the voucher provider. It will appear in your orders once issued; our team will follow up if there's a problem." |

## 2a. Automatic re-check (since 2026-11-24)

⚠️ **Hubble has never POSTed our webhook in prod** (no `/v1/hubble/webhook` requests in 14 days as of 2026-11-24 — the
prod webhook is not registered with Hubble). Before this, an order Hubble left PROCESSING was never looked at again
(prod BAJAJ-26-000050). The automatic re-check is now the safety net:

- **Driver = Cloud Scheduler** → `POST /v1/hubble/sweep` (one pass per call, inside the request). Prod `gifsy-api` runs
  with CPU throttling (`run.googleapis.com/cpu-throttling=true`), so the in-process `HubbleOrderSweep` `@Interval`
  (2 min) does NOT fire reliably while idle — the deploys set `HUBBLE_ORDER_SWEEP_ENABLED=false`, so the Scheduler
  job is the only trigger (the timer could be switched back on as a harmless extra). Overlapping runs (scheduler + timer, several instances) are safe: the claim phase holds a Postgres
  transaction-level advisory lock (a second run skips with `LOCKED`) and every order is claimed with a compare-and-set
  on `hubbleLastSweepAt`, so one order is never checked twice at once.
- It re-checks open orders handed to Hubble (CONFIRMED / PROCESSING, no code, a place attempt / Hubble provider / Hubble
  order id on record; not taken over manually) through the SAME `reconcileHubbleOrder` as the webhook and ops retry —
  it never places an order and **never refunds on "no order"** (that stays an ops decision via Retry). Hubble's own
  FAILED answer is refunded through the usual path and the member gets the usual refund message.
- "No order" on an unflagged order (e.g. the server died in the middle of the place call) → flagged **Hubble state
  unknown** (`HUBBLE_INDETERMINATE`) so ops Retry can refund it under the usual 2 h + same-account + canary rules (the
  2 h count from the flag); if Hubble had acknowledged the order before → `HUBBLE_PROCESSING_NOT_FOUND`.
- Order no longer eligible for Hubble (tenant flag off / product gone) → **Hubble can't be checked — fulfil manually**
  (`HUBBLE_NOT_ELIGIBLE_NOW`). A hand refund stays blocked (a Hubble order may exist).
- Orders ops **fulfilled manually** after handing them to Hubble are still asked about for 7 days (check only — never
  delivered or refunded): if Hubble reports SUCCESS too → the double-issuance flag (`HUBBLE_SUCCESS_MANUAL_CODE_PRESENT`).
- Each Scheduler call has a 60 s budget (the job's attempt deadline is 180 s); work left over is picked up by the next
  call (`budget` in the response).
- A manual code that IS Hubble's own voucher (ops copied it from Hubble's portal) is recognised (same code, and PIN when
  both have one): one voucher, no double-issuance flag; recorded as `hubbleManualMatchesHubble` and no longer re-checked.
  Only a DIFFERENT code raises the double-issuance flag.
- A VOUCHER_ISSUED message that could not be sent is never silent: the once-only marker is cleared (a later path can send
  it), `voucherNotifyFailedAt` / `voucherNotifyFailedReason` are recorded on the order, and the Daily Ops Digest lists
  those orders under Vouchers (Hubble) → "voucher message not sent".
- Not before 2 min after hand-off; every run for the first hour, then every 15 min, until 7 days. At most 25 orders per
  run, least-recently-checked first. One instance at a time (Postgres advisory lock + per-order claim). Metadata:
  `hubbleLastSweepAt`, `hubbleSweepCount`, `hubbleLastSweepOutcome`.
- Delivered through the re-check → the member gets the same VOUCHER_ISSUED bell + WhatsApp as the confirm path (the
  webhook / ops-retry path now sends it too — it did not before). Only the call that actually delivers sends it, and a
  once-only marker per code (`voucherIssuedNotifiedFp`, a hash) stops a duplicate when two paths race.
- Still not delivered **1 hour** after hand-off (and no other flag open) → flagged **Still processing at Hubble**
  (`HUBBLE_STILL_OPEN_STALE`): it appears in the console's needs-review list and the Daily Ops Digest "needs reconcile"
  count. Hubble delivering later clears it automatically. An open Hubble order older than the 7-day window gets the same
  flag once (no Hubble call), so nothing waits silently.
- Re-raising a reason that is already open changes nothing (no timestamp churn).

### 2b. Setting up the scheduler (owner infra, one-time per environment)

Same pattern as `voucher-dispersal-drain-*` (VOUCHER-DISPERSAL.md):

1. **Secret:** create Secret Manager secret `HUBBLE_SWEEP_SECRET` (prod) / `HUBBLE_SWEEP_SECRET_STAGING` (staging) with a
   random value. The deploy workflows bind it to the API as env `HUBBLE_SWEEP_SECRET` (`--set-secrets`) and the
   **preflight fails the deploy if it is missing** — create it BEFORE the deploy that carries this change. Until it is
   set the endpoint answers 403 (fail-closed, no dev bypass).
2. **Cloud Scheduler job**, created **PAUSED**:
   - name `hubble-sweep-prod` / `hubble-sweep-staging`
   - schedule `*/2 * * * *`, time zone `Asia/Kolkata`
   - target HTTP `POST https://<api-host>/v1/hubble/sweep`, header `x-drain-secret: <the secret>`, empty body
   - e.g. `gcloud scheduler jobs create http hubble-sweep-prod --location=<region> --schedule="*/2 * * * *"
     --time-zone="Asia/Kolkata" --http-method=POST --uri="https://<api-host>/v1/hubble/sweep"
     --headers="x-drain-secret=<secret>" --attempt-deadline=180s` then `gcloud scheduler jobs pause hubble-sweep-prod --location=<region>`
     (or create from the console and pause it).
3. **RESUME the job only after the deploy that carries `/v1/hubble/sweep` is serving** (before that it would 404 every
   2 min). Check: `gcloud scheduler jobs resume hubble-sweep-prod --location=<region>`; the job's last run shows HTTP 200
   with a JSON body `{ claimed, outcomes, flaggedStale, errors }` (`skipped: "LOCKED"` = another run held the lock — fine).

## 3. "Retry with Hubble" (ops)

Shown (Gifsy admin) on **any open order handed to Hubble**, flagged or not. An unflagged one shows
"Waiting for Hubble since <time> · last checked <time ago>".

Asks Hubble for the order by our reference. It never places a new order. Outcomes shown on screen:

| Shown | Meaning | Next step |
|---|---|---|
| Voucher issued | Hubble had it; code stored, order DELIVERED, flag closed | none |
| Hubble is still processing the order | not finished yet | retry later |
| Hubble reported the order failed — points refunded | Hubble's own FAILED | none |
| **Hubble confirmed it has no order for this redemption — points refunded** | all four held: (1) the order's flag is `HUBBLE_INDETERMINATE` (or `HUBBLE_UNEXPECTED` with a record that the place call never got an answer); (2) Hubble's own 404 "no order" body; (3) the order is **at least 2 hours old** (counted from the later of: order created, place attempt, flag raised) and was placed on the same Hubble account; (4) the canary check passed | none — the retailer gets the refund message; wallet line "Refund <order> (voucher not issued)" |
| Hubble has no order yet — too recent to refund; retry later (orders must be at least 2 hours old) | under 2 hours | retry after the 2 hours |
| Hubble says it has no order, but we couldn't confirm that answer against a known Hubble order — not refunded | the canary failed (wrong route, gateway 404, Hubble degraded, or no delivered order to test with); the reason is shown on the order | check the order in Hubble's portal; retry later |
| Hubble has no order for this redemption, but it can't be refunded automatically… | Hubble acknowledged an order earlier, or the state is unclear | review manually in Hubble's portal (see §5) |
| Still unresolved — Hubble could not confirm the order state | Hubble unreachable or unclear | retry later |
| Nothing to do — the order is already resolved | already final | none |
| Already refunded — but flagged for review: Hubble contacted us after the refund | see §5, post-refund flags | check Hubble's portal, then Acknowledge |

**Canary check:** before trusting any "no such order", we look up an order Hubble is *known* to have delivered (newest
first, up to 5 at ops retry / 2 at confirm) through the same lookup. It must come back as that order with status
SUCCESS. Any tenant's delivered order counts when it was placed on the **same Hubble account** (account fingerprint);
older orders without a fingerprint count only for the same tenant. If none verifies → no refund.

## 4. Review flags — what each one means and what to do

| Screen text (reason code) | Meaning | What ops does |
|---|---|---|
| Hubble state unknown (`HUBBLE_INDETERMINATE`) | placement timed out / failed and Hubble had no order yet | wait ≥ 2 h → **Retry with Hubble** |
| Unexpected Hubble error (`HUBBLE_UNEXPECTED`) | something failed around placement (e.g. storing the code) | **Retry with Hubble**; it refunds only with proof the place call never got an answer |
| Hubble has no record of this order (`HUBBLE_PROCESSING_NOT_FOUND`) | Hubble once said "processing", now "not found" | check Hubble's portal; **Fulfil manually** or escalate to Hubble — never auto-refunded |
| Hubble succeeded without a code (`HUBBLE_SUCCESS_NO_CODE`) | success but no voucher code in the reply | Retry; if still no code, get it from Hubble's portal → **Fulfil manually** |
| Unknown Hubble status (`HUBBLE_UNKNOWN_STATUS:*`) | a status we don't recognise | check Hubble's portal; Retry or Fulfil manually |
| Order changed while Hubble was processing (`HUBBLE_PROCESSING_CLAIM_LOST`) | a race with another change | Retry |
| Still processing at Hubble (`HUBBLE_STILL_OPEN_STALE`) | the automatic re-check has asked Hubble for an hour+ and it is still not delivered (still processing, no order yet, or Hubble not answering) | check the order in Hubble's portal; **Retry with Hubble** (an aged "no order" can be refunded there), or **Fulfil manually**; escalate to Hubble if it stays processing |
| Hubble sent a webhook but has no order for this reference (`HUBBLE_WEBHOOK_BUT_NOT_FOUND`) | contradiction — the webhook path never refunds | check Hubble's portal; Retry |
| Hubble not configured / Amount not issuable on Hubble (`HUBBLE_NOT_CONFIGURED`, `HUBBLE_INVALID_AMOUNT`) | no Hubble order was ever placed | refund via the normal status change, or **Fulfil manually** (Retry is hidden) |
| Hubble issued a voucher on top of a manual code / Hubble failed but a code is on the order / Hubble processing after a manual takeover (`HUBBLE_SUCCESS_MANUAL_CODE_PRESENT`, `HUBBLE_FAILED_VOUCHER_PRESENT`, `HUBBLE_PROCESSING_AFTER_MANUAL`) | **possible double issuance** — sticky: a later delivery does not clear it | check both vouchers in Hubble's portal; cancel one with the vendor if needed; then **Acknowledge** with a note |
| **Hubble may have issued a voucher for refunded points** (`HUBBLE_ISSUED_AFTER_REFUND`) | points were refunded, then Hubble reported a voucher / processing order — **highest priority** | in Hubble's portal: cancel the voucher, or recover it; then **Acknowledge** with what you did |
| Hubble webhook arrived after the points were refunded (`HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND`) | a signed webhook arrived after a "no order" refund and Hubble couldn't be re-checked | check Hubble's portal → **Acknowledge** |

Late webhooks on a refunded order are **always** re-checked with Hubble; only a webhook that itself says FAILED is
logged without a flag. A Hubble delivery closes the ordinary flags automatically (not the double-issuance ones, and not
on orders taken over manually). A "Newer: <reason>" note means a second reason arrived while the flag was open.

## 5. Acknowledge — resolved

Available only on a post-refund flag, or on any flag left on a FAILED / CANCELLED / RETURNED (points returned) or
DELIVERED order. A note is required (what you checked in Hubble and concluded).
- On a refunded order whose reason says Hubble holds an order (or a double issuance), the system **re-asks Hubble first**:
  Hubble reports an order → refused, and the flag becomes "Hubble may have issued a voucher for refunded points";
  Hubble says no order / failed → allowed.
- Hubble unreachable → refused ("try again in a few minutes"). If it stays unreachable, tick **"Hubble unreachable —
  acknowledge anyway"** and write a note of **at least 20 characters**; recorded as forced and audited. Force never
  overrides a Hubble that reports an order.
- If a newer reason was recorded meanwhile, acknowledging re-raises that newer reason instead of clearing the flag.
- Every acknowledge is in the audit log (`HUBBLE_FLAG_ACKNOWLEDGED`, with note, recheck result, forced, re-raised).

## 6. Other exits

- **Fulfil manually…** — enter the code (and PIN) obtained from Hubble's portal with a reason; audited.
- **Voucher cancelled with vendor…** — after cancelling an issued code with the vendor; this unlocks the refund.
- Issued vouchers can never be refunded until "Voucher cancelled with vendor" is recorded.

## 7. Escalate to engineering when

- Many orders flag at once (Hubble outage, credentials, IP allow-list — prod egress `34.96.40.72` is whitelisted).
- The canary keeps failing although Hubble's portal shows delivered orders.
- An order shows a voucher in Hubble's portal but nothing on our side after Retry.
