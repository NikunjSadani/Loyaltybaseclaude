# Off-portal payments register — design + owner decisions

Branch `feat/off-portal-payments` (from `release/next6`). Owner-approved 2026-11-25, **platform-wide (all clients)**.
Status: built + independently audited (twice); NOT pushed / deployed; migration not applied anywhere.

## Purpose
Record payments ALREADY MADE outside the portal (bank transfer / UPI / gift) so that:
1. TDS yearly totals per payee are right (194R per client, 194C platform-wide);
2. Fund Reconciliation shows them as paid from the client's advance;
3. the outlet's payout history (partner app + admin / sales ledger) shows them;
4. the Payments Report lists them (own totals card + own export sheet).

## Model (`api/prisma/schema.prisma`, migration `20261125140000_off_portal_payments`)
- `OffPortalPaymentUpload` — one confirmed file (stored file key, sha256, counts, ticked warnings).
- `OffPortalPayee` — an Outlet ID paid while NOT on the portal (latest details).
- `OffPortalPayment` — one payment, keyed by **client + Outlet ID** (`outletCodeKey` = upper-cased code). Freezes PAN
  (file, else portal owner's at upload), TDS section + method, period, flags; void fields.
- Migration-only: partial unique `off_portal_payments_one_live_supersede`, CHECK `off_portal_payments_amount_positive`
  (guarded by `off-portal-payments.schema-guard.spec.ts`).

## Flow
Gifsy admin (GIFSY_ADMIN, assumed into the client) only: template → preview (every row classified; every warning
category listed with all its rows) → confirm with the SAME file + a tick per warning category (server-enforced) → one
transaction under a client advisory lock (re-analysed inside), audit row. Void: Gifsy admin, reason, audited; every
consumer ignores a void row (fund shows it returned). Register list / export: that admin or the client's CLIENT_ADMIN
(phone / PAN / bank / UPI masked for anyone but a Gifsy admin; never logged).

## TDS treatment (what the code does)
- **194R** (incentive; visibility when the client's visibility section is 194R): counted in the yearly base by
  PAYMENT DATE (cash → cash, gift → non-cash, visibility cash → visibility). The DEDUCT engine counts them for the
  THRESHOLD only — it never withholds catch-up TDS for them; the 194R report shows the visibility TDS on them as a
  SHORTFALL (amount on the row + summary). Nothing is invoiced (the client is the deductor).
- **194C** (visibility of a 194C client): only allowed on **DEDUCT** clients. Counted by payout PERIOD; the engine
  counts them for the threshold only (PAN), the 194C report shows the shortfall. Without a PAN: 194C no-PAN is never
  withheld — the outlet's next portal payment records the client recovery on portal + off-portal (not a shortfall).
- A **GROSS-UP 194C client's** visibility rows are **refused** (whole file, rows listed).

## Owner decisions
| Date | Decision |
|---|---|
| 2026-11-25 | Key = Outlet ID (not PAN). Outlet not on the portal → off-portal payee; links automatically when it registers. |
| 2026-11-25 | No silent failure: every skipped / unmatched / suspicious row shown and explicitly ticked. Everything audited. |
| 2026-11-26 | (1)+(2) Off-portal payments COUNT toward the yearly TDS threshold/base (194R and 194C) but NEVER trigger automatic catch-up withholding on later portal payouts; the TDS reports show the shortfall loudly. |
| 2026-11-26 | (3) Accepted PAN mismatch → TDS counts under the FILE's PAN. |
| 2026-11-26 | (4) Gifts stay in outlet totals / statements, labelled "Gift (off-portal)". |
| 2026-11-26 | (5) A no-PAN payment stays on the no-PAN key (PAN-change rule: the year splits at the change). |
| 2026-11-26 | **Off-portal GIFTS carry NO agency fee** in Fund Reconciliation (charged at face value; the line shows the note "No agency fee — gift"). Cash off-portal payments are charged face + agency fee like any payout. |
| 2026-11-26 | 194C GROSS-UP payouts are always made through the portal itself. |
| 2026-11-26 | **Off-portal files must NOT contain 194C GROSS-UP payments** (visibility under a gross-up client): the upload REFUSES the whole file — "Visibility payouts for this client (194C, TDS paid on top) must be paid through the portal's payout flow, not recorded as off-portal. Rows: …". This replaces the earlier idea of invoicing off-portal 194C gross-up TDS at recording (removed after the re-audit). |
