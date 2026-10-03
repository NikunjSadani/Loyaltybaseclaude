# UAT Checklist — Employee Rewards (Britannia pilot)

> **Purpose.** The tester-executable acceptance script for the Britannia employee-rewards pilot go-live.
> Every row is run by a **real user in the correct role, end-to-end through the real stack** (FE → proxy
> → backend → DB), against realistic data — `tsc`/unit/E2E are necessary, never sufficient
> ([`VERIFICATION-PROTOCOL.md`](./VERIFICATION-PROTOCOL.md)). **DONE** = a different session sees the
> persisted result and the unhappy path is honest.
>
> **This is the Deoleo UAT, curated for employee rewards** (see [WAYS-OF-WORKING §2/§5](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md)):
> the universal axes (auth, RBAC/isolation, nav, integrity, security, performance, concurrency, ops,
> real-data-load, device/locale) are **kept**; the employee flows (roster, points-upload, contests,
> redemption, fulfilment, liability) are **added**; the trade sections (**KYC, money-settlement/payouts/
> UTR, TDS/GST/invoicing**) are **dropped — they do not exist in this product.**
>
> **Tiers.** 🔴 go-live BLOCKER · 🟠 strongly recommended · 🟡 post-launch acceptable (defer consciously).
> **`[operator]`** rows run on STAGING/PROD by the owner (DLT, backups, scale, real-data-load).

---

## 0. Pre-UAT setup
| # | Step | Expected |
|---|---|---|
| 0.1 | UAT runs on **STAGING** (`FIXED_OTP=123456`). Host `uat-britannia.gifsy.in` (zero-touch). | Loads login over HTTPS. |
| 0.2 | Serving image = latest `develop` short-SHA (`gcloud run services describe …-staging`). | SHA matches pushed build. |
| 0.3 | Staging DB migrated (auto on `develop` push); no pending. | Migrations applied. |
| 0.4 | Test phones per role ready (Program Admin, Regional Admin, employee, vendor, GIFSY, **+ a Deoleo trade user**). | Each logs in with OTP `123456`. |
| 0.5 | Two browser profiles for the persistence check (write in A, verify in B). | Two isolated sessions. |

## 1. Authentication & access control
| # | Role | Steps | Expected |
|---|---|---|---|
| 1.1 | Program Admin | Login via `uat-britannia.gifsy.in`. | Lands on the **employee-rewards** admin nav (no KYC/Payouts/TDS tabs). |
| 1.2 | Employee | Login. | Lands on the rep app (home/wallet). |
| 1.3 | Vendor | Login. | Lands on the vendor portal (own orders only). |
| 1.4 | Any | Wrong OTP / resend spam. | Honest error; per-phone cooldown; no unbounded SMS. |
| 1.5 | Any | Logout, press Back / reuse old tab/token. | Session cleared; old token → 401; protected pages bounce. |
| 1.6 | Wrong role | A rep navigates to an `/admin/*` URL. | Scoped out / honest 403 — never admin data. |

## 2. Roster (REUSE the existing employee-hierarchy upload) 🔴
| # | Role | Steps | Expected |
|---|---|---|---|
| 2.1 | Program Admin | Bulk "Employee Hierarchy" Excel upload (dry-run diff → apply). | Employees + ASM→ASE→rep hierarchy persist; re-upload updates; bad rows reported per-row. |
| 2.2 | Program Admin | Single-employee edit (by `employeeCode`); deactivate. | Edit persists; deactivate frees the phone; employee → `EMPLOYEE` RewardAccount linked. |
| 2.3 | — | Confirm a Deoleo trade user's roster/KYC is untouched. | Deoleo flows unchanged (the dormancy proof). |

## 3. Points crediting — BULK UPLOAD, no compute 🔴 *(the money boundary — DUAL-audited)*
| # | Role | Steps | Expected |
|---|---|---|---|
| 3.1 | Program Admin | Upload a point-credit batch (one row per Employee Code) → confirm. | Points credit to each employee's wallet **exactly once**; ledger correct; verify balance in session B. |
| 3.2 | Program Admin | **Re-upload the same file.** | Idempotent / reported-as-duplicate — **no double credit**; totals stable. |
| 3.3 | Program Admin | Upload with bad rows (unknown `employeeCode`, non-numeric, negative). | Bad rows **reported, not silently dropped**; valid rows persist. |
| 3.4 | Program Admin | Upload the optional **target-points** column. | Target stored; the rep app shows the display-only achievement / "Potential" view. |
| 3.5 | — | Confirm there is **no compute step** anywhere — points are the uploaded numbers, verbatim. | No KPI/conversion/calculation; uploaded value == credited value. |

## 4. Contests 🟠
| # | Role | Steps | Expected |
|---|---|---|---|
| 4.1 | Program Admin | Create a contest (banner, name, duration, beneficiary = region/hierarchy slice). | Persists; "as the rep sees it" preview matches. |
| 4.2 | Rep | Open Contests. | Sees **their region's** contests (banner/name/duration/"for you & your team") — not others'. |
| 4.3 | Program Admin | Credit a contest bonus (via the same upload path) → employee sees it. | Bonus credits **once**; appears as a Contest-source wallet entry. |

## 5. Rewards / redemption 🔴
| # | Role | Steps | Expected |
|---|---|---|---|
| 5.1 | Rep | Open rewards; view catalogue + Dream Reward. | Real `RewardCatalog` items; no demo gifts. |
| 5.2 | Rep | Redeem → **"Are you sure?"** confirm → full-page success. | Points debit **exactly once**; order created; ledger + revised balance correct (verify in B). |
| 5.3 | Rep | Redeem with **insufficient balance**. | Honest 400; **no debit**; no stranded order. |
| 5.4 | Rep | **Double-submit** the confirm (rapid). | One debit / one order (atomic); second rejected. |
| 5.5 | Rep | Points **6-month expiry** display + expiry reminder. | "Expiring this month" + "valid 6 months" shown; expiry job behaviour confirmed (§17). |

## 6. Fulfilment / orders + vendor portal 🟠
| # | Role | Steps | Expected |
|---|---|---|---|
| 6.1 | Program Admin | Order lifecycle: processing → dispatched → delivered → returned; enter courier/tracking. | Status history correct; employee sees tracking. |
| 6.2 | Vendor | Login → see **only their** pending orders; enter tracking; upload a (moderated) product. | Only own orders; product queued for owner moderation; **IDOR: cannot see another vendor's orders**. |

## 7. Liability (finance, reframed) 🟠
| # | Role | Steps | Expected |
|---|---|---|---|
| 7.1 | Program Admin / Finance | View points-liability + expiry forecast + reward-cost + budget-vs-actual. | Liability reconciles to the ledger (₹ value of unredeemed, unexpired points); **no GST/TDS/payout anywhere**. |

## 8. RBAC & tenant isolation 🔴
| # | Role | Steps | Expected |
|---|---|---|---|
| 8.1 | Regional Admin | Across every list (people, points, contests, orders, insights). | Sees **only their hierarchy subtree** (`descendantSalesUserIds`); nothing above/outside. |
| 8.2 | Program Admin | Try to mint a GIFSY/other-tenant admin; over-post `clientId`/`role`/`isActive`. | Forbidden / stripped (`forbidNonWhitelisted` blocks at runtime). |
| 8.3 | Program Admin (Britannia) | Across every list, confirm **no Deoleo (or other tenant) data** ever appears. | Strict tenant scoping; **cross-tenant never leaks (Britannia↔Deoleo)**. |
| 8.4 | GIFSY | Un-assumed = platform context; assumed-Britannia = tenant-scoped. | `platformWide()` honoured; assume is audit-logged to the real operator. |

## 9. Data integrity & no-fabrication
| # | Steps | Expected |
|---|---|---|
| 9.1 | Spot-check every live page for fabricated/demo values. | None on live surfaces. |
| 9.2 | For each WRITE above, verify in a **second session**. | Persisted change visible to another user — no fake success. |
| 9.3 | Money/points exact (no float drift); wallet ↔ liability reconcile. | Consistent amounts. |

## 10. Unhappy-path matrix (must all be honest)
Wrong/expired OTP · insufficient balance on redeem · double-submit of any credit/redeem (single effect) ·
duplicate point-upload (idempotent) · bad-row upload (reported) · cross-tenant/IDOR id probing (scoped out) ·
backend error mid-action (honest, no fake success).

## 11. Excel round-trip & re-upload (every upload surface)
Point-credit batch · optional target column · bulk fulfilment · employee-hierarchy (roster) upload. For each:
real `.xlsx` download → fill → parse+persist (verify in B) → **bad rows reported per-row** → re-upload behaves
per design (idempotent/dedup) → malformed/wrong-template → honest error, no partial corruption.

## 12. Navigation & link integrity
For **each role**: click every nav item + every button/link/tab (no 404/dead `#`/console error); deep-link
each route; back/forward across redeem/contest flows stays coherent; bad route → graceful 404; cross-shell
(rep URL as admin, vendor URL as rep) scoped out.

## 13. Security (authz depth & abuse) 🔴/🟠
IDOR on **redemption orders / gift orders / vendor orders / wallet** (object-level, not just tenant) ·
mass-assignment/over-posting · token-after-logout (no token in URL/logs) · stored XSS (names/contest text) ·
**CSV/formula-injection on every export** (`cellSafe` at the serialisation boundary) · oversized/
content-type-spoofed upload rejected.

## 14. Performance & scale 🔴 `[operator]`
Volume pages (realistic employee + ledger counts): lists, wallet/ledger, insights load acceptably, correct
pagination, no N+1. Large point-upload / large export within the Cloud Run request timeout (or async).

## 15. Concurrency & resilience 🟠/🔴
Parallel wallet drain (exactly one redeem succeeds; no oversell) · concurrent same-batch point-upload (single
effect) · **transaction rollback proof** (force a failure inside the credit/redeem `$transaction` → wallet +
ledger + order roll back together) · retry idempotency (replay a credit/redeem POST → single effect).

## 16. Comms / DLT 🔴 `[operator]`
The **employee** MSG91 templates — OTP + the locked **Contest Alert** + expiry reminders — are **DLT-approved**
with the correct sender ID; send a real OTP to an unfamiliar number on a different telco → delivered. *(DLT
lives in the MSG91 dashboard, not code — the "works in UAT, telcos drop it in prod" trap.)*

## 17. Operational readiness `[operator]` 🔴
Prod-backdoor sweep (`NODE_ENV=production`, `FIXED_OTP` inert, no demo/seed routes, no stack-trace leak) ·
**backups + PITR on `gifsy-db` with one restore rehearsed** before any real data · **points-expiry scheduled
job** fires exactly once (Cloud Scheduler, not in-process `@Cron`) · observability/trace a redemption ·
deploy rollback proven (prior Cloud Run revision).

## 18. Real-data-load acceptance 🔴 `[operator]`
Dry-run the Britannia load (roster + the actual point credits + gift catalogue) against a **copy** first ·
idempotent re-run (no dup employees/credits) · encoding/format (Indian names; `employeeCode` validated; bad
rows reported) · post-load spot-check vs source + a loaded employee logs in · load runs **only after §17
backups/PITR are ON**.

## 19. Device / browser / network / localization 🟠/🟡
Rep app on Chrome/Safari/Edge · mobile viewport (field users) · throttled 3G usable · ₹ + Indian grouping ·
**IST** everywhere (expiry, lastLogin, contest dates).

## 20. Sign-off
| Gate | Status |
|---|---|
| §1 Auth · §2 Roster · §3 Points-upload · §4 Contests · §5 Redemption · §6 Fulfilment/Vendor · §7 Liability | |
| §8 RBAC/Isolation · §9–10 Integrity & unhappy paths · §11 Excel · §12 Nav | |
| §13 Security · §14 Perf · §15 Concurrency · §16 DLT · §17 Ops · §18 Real-data-load · §19 Device/locale | |
| **CUTOVER GATE — Deoleo regression unaffected** (real Deoleo login per role; trade flows unchanged) | |

**PASS only when** every 🔴 is green for the in-scope roles, every 🟠 is green or risk-accepted, every write
was independently verified to persist, every upload round-tripped + re-uploaded correctly, every nav/
unhappy/security/concurrency path was honest — **and the Deoleo regression proves trade is unaffected.**
Defects → log with role + steps + expected vs actual + tier.

**Not in scope (they don't exist for employee rewards):** KYC, TDS (194R/194C), payouts/settlement/UTR,
self-bill invoicing, GST/GSTIN, outlets, POSM/visibility.
