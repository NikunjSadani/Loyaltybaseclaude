# Redemption Report

**Status:** on staging in `release/2026-11-21` (code tip `27581819`), real-login verified 2026-11-21; **not on prod**
(waiting on the owner's go for `main` — `RESUME.md` §4). **Scope:** ⚠️ PLATFORM-WIDE (all tenants incl. Deoleo) —
owner-approved in-session.

## Purpose

One report of reward redemptions (orders) for a date range, for Gifsy operators and client admins: what was requested,
what was actually deducted from wallets, and where physical gifts were delivered — without exposing personal or
voucher secrets.

## Columns (what is known)

- Per-order rows with points **requested** and points **deducted** (they differ for cancelled / failed orders).
- Delivery **city / state / pincode** (by design) — **never** the street address.
- A **Summary** sheet whose totals equal the sums of the rows.
- TODO: full column list (read it from the export kind in `api/` and record it here).

## Roles

| Caller | Result |
|---|---|
| Gifsy operator assumed into a client | report for that client |
| Gifsy operator NOT assumed | 400 "Choose a client (assume one)…" |
| Gifsy with an unknown `clientId` | 400 "Unknown client" |
| CLIENT_ADMIN | own tenant |
| MIS_USER | 403 |

## Data handling

- Never in any cell: voucher code, voucher PIN, PAN, full phone number, street address, raw notes.
- Large requests (more than 5,000 orders, or long date ranges) are queued to the **Downloads** page
  (`DOWNLOADS-PAGE.md`) instead of streaming.

## Verified on staging (2026-11-21, real logins)

- Bajaj staging, 1–21 Nov 2026: **37 orders**, **22,314 pts deducted** vs **30,614 requested** (gap = cancelled /
  failed orders). Summary totals == row sums.
- Checked every cell: no full phone, PAN, voucher code or PIN.
- Un-assumed Gifsy → 400 "Choose a client (assume one)…"; unknown clientId → 400 "Unknown client"; MIS → 403 (Bajaj
  staging has no MIS_USER — checked with Deoleo's).
- Deoleo: the export works (Deoleo level names XSR / RSM / ZNM / NSM).
