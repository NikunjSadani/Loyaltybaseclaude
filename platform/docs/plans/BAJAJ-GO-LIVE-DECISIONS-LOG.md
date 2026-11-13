# Bajaj go-live — owner decisions log (Nov 2026)

> One place for every owner decision taken during the Bajaj go-live (11–13 Nov 2026): what was decided, the
> alternative rejected, and where it is implemented/recorded. Newest first within each section. When a decision changes,
> strike it through and add the new one with its date — never delete history.
> Related records: `BAJAJ-PROD-OUTLET-IMPORT.md` (every prod import, step by step) · `RESUME.md` (current state) ·
> `WALLET-REVERSAL-ENGINE-DESIGN.md` (on branch `feat/wallet-reversal-engine`) · `APPLIES-TO-TARGETING-PLAN.md`.

## 1. Releases & process
| Date | Decision | Rejected alternative | Where |
|---|---|---|---|
| 2026-11-13 | **ONE tenant-sectioned "Daily Operations Digest"** (health, KYC, points, redemptions, Hubble vouchers, payouts, message failures, visibility, needs-attention) **replaces** the two existing daily emails (KYC actionables + credits/payouts). ⚠️ PLATFORM-WIDE, owner approved **option A**. BUILT on the branch (not yet pushed/merged) — design `DAILY-OPS-DIGEST.md`. | Keep two separate emails / add a third | branch `feat/daily-ops-digest`, worktree `.claude/worktrees/ops-digest` |
| 2026-11-13 | **Retailer-TDS setting ships as its own small release** after the main release. ✅ **LIVE on prod `ad01ace5`** (api + frontend `ad01ace51abc18eb2fdabe99805667d2dcf15bf1`, `/health` 200); owner saved Bajaj `tdsImportedPayouts = {countFrom: 2026-04-01}` at 10:06 UTC — landed on BAJAJ, not `gifsy`. | Hold the main release for it | prod `ad01ace5`; §9.1a |
| 2026-11-13 | **Release first, reversal engine later** — ship no-PAN / rounding / TDS / applies-to with SAFE INTERIM reversal rules; engine = fast follow-up after go-live. | Ship together (~1–1½ day delay) | prod `247fae4b`; engine branch |
| 2026-11-13 | **Wallet reversal engine paused** until after go-live (not needed for go-live or imports); fully documented for resumption. | Build now | `WALLET-REVERSAL-ENGINE-DESIGN.md` |
| 2026-11-13 | **Two staging deploys** (applies-to first, then the money release) instead of one batched deploy, to go faster. | One batched deploy | develop `7a78bc26` → `2be10c5d` |
| 2026-11-13 | **Prepare-main must `git revert e8c3f46` explicitly** (re-adds the 194R VENDOR_IMPORT exclusion) — a plain merge does not undo the revert. Supersedes "keep the TDS revert". | Keep revert | main `247fae4b` (`e3669142`) |
| 2026-11-13 | **Staging role tests: Claude logs in itself** with FIXED_OTP 123456 + staging test accounts. Prod logins stay with the owner. | Owner logs in for every test | memory `test-on-bajaj-staging` |
| 2026-11-13 | **Approval requests list every recommendation in full** (plain words + recommendation + alternative) — never "approve all N" by reference. | — | memory `show-recommendations-before-approval` |
| 2026-11-13 | Training deck: owner builds it on another laptop. | Claude builds | — |

## 2. Wallet reversals
| Date | Decision | Rejected | Where |
|---|---|---|---|
| 2026-11-13 | **Interim (until the engine is live for a tenant):** points reversals on a wallet carrying debt (negative, or credit landed on a negative balance) are REFUSED with a clear message; otherwise floor 0 as before; never debit a wallet that didn't receive the credit; cap = actually credited. PAYOUT reversals: whole entries of the same batch only, exact match, never consumed twice, cancel unpaid entries before creating a receivable, PROCESSING refused. | Patched negative-floor logic (order bugs) | prod `247fae4b` |
| 2026-11-13 | **Long-term engine design approved — 14 choices (all recommended):** Q1 a reversal on a debt wallet may go below 0 down to the debt it restores (never on never-negative wallets); Q2 first approved recovers first; Q3 fungibility on positive wallets as today; Q4 debit the wallet that received the credit; Q5 unattributable legacy credits refused until Gifsy maps them; Q6 expiry clamp as today; Q7 reversal removes the credit's own lot first; Q8 don't show debt to partners; Q9 whole payout entries only; Q10 pending payout reversal holds the entry out of bank files; Q11 PAID payouts → receivable only; Q12 credits repay debt first; Q13 historical reversals kept as recorded; Q14 interim refusal on debt wallets. | — | `WALLET-REVERSAL-ENGINE-DESIGN.md` §12 |
| 2026-11-13 | Owner: "the correct long-term solution … this is real money related points" → stop patching, design the engine properly. | Simple rule + flag | engine branch |
| 2026-11-13 | A reversal FULLY UNDOES a credit that landed on a negative wallet (−841 +500 → −341 → reverse → −841). | Stay at −341, note shortfall | engine Q1 / R1 |
| 2026-11-12 | 8 negative Bajaj wallets (sales returns) are KEPT negative; fix "debit never adds points" shipped. | Write off to 0 | prod `247fae4b` |

## 3. Bajaj prod data imports (all: dry run → owner OK → backup → import → verifier PASS)
| Date | Decision | Where |
|---|---|---|
| 2026-11-13 | **November sales file** (`Sales data  13 nov.xlsx`, 97 MB, sheet "Sheet1", header row 1 = the staging-verified DMS layout): **upload + aggregate first, preview/apply only after the Bajaj sales KPI definitions + column mapping exist on prod** — upload/aggregation never reads KPI definitions (they are consumed at preview/apply via `expectedDefinitionsHash`). | Wait for the KPI config before touching the file | §12 |
| 2026-11-13 | **Partial vendor TDS (FY 2026-27, 119 wholesalers):** vendor TDS was PAID BY BAJAJ ON TOP (gross-up) → import as-is: monthly benefit value (off-platform, Σ = "Outlet Points") + vendor deposits (challan date, "TDS for month"); rows keyed by OUTLET with blank PAN so PANs added later recalculate automatically (owner reminder). Report shows the gross-up difference (~₹2.59 L) for Bajaj's CA. ₹3.97 L unallocated challan money + 5 outlets not on prod left out. | §10 |
| 2026-11-13 | **Retailer TDS:** Bajaj confirmed no TDS deposited for retailers → Bajaj-only setting counts imported payouts from **1 Apr 2026** (FY 2026-27) in the 194R report as LIABILITY ONLY; FY 2025-26 excluded (CA handles outside); deposits subtract later; no automatic deduction/recovery (Bajaj is gross-up → payer-borne). | §9.1, branch `feat/tds-count-imports` |
| 2026-11-13 | **Payout history** imported only AFTER the 194R vendor-import rule was live on prod. Done rows only, Apr 2025+, prod outlets only; placeholder references ("Same Bank does not provide Utr No.") stored as UTR = NULL with the text in narration; amounts kept to the paisa (history, not the whole-rupee rule). "UTR no. awaited" rows excluded pending Bajaj status. | §9 |
| 2026-11-13 | **Historical targets + achievements** (file to Sep 2026; October file to follow; November targets entered by owner; November achievements via Sales Import): RLP → TOTAL/ADHO/NON ADHO/FOCUS BRAND/LINES, FOCUS BRAND 2 none; BSC → TOTAL only (case counts not imported); prod outlets only; sheet/type mismatches imported (out-of-scope KPIs hidden); 2 decimals; negatives kept; duplicates once (first wins). **Never run points compute for imported months.** | §9c |
| 2026-11-13 | **October 2026 file** (`Book1 (5).xlsx`): import **targets/achievements only — October rewards NOT imported** (owner: the client will send October rewards as a SEPARATE file → import it then; never compute points for Oct). Same rules as §9c; 3 outlets in both sheets → RLP row (they are retailers on prod). Owner approved the write after the dry run. | §9d |
| 2026-11-13 | **Wholesaler points:** final balance must equal the vendor's 11-Nov closing; vendor stopped redemptions on 11 Nov (final balance); 2 outlets show "Last year's over-redemption recovered" to match the vendor; scratch payouts dated 30 Jun 2025 (their column position), MAH-Sept 25 Sep 2025, Bottle QPS 25 Nov 2025. | §9b |
| 2026-11-12 | **Visibility history:** only "Approved CISPL Status = Approved"; November 2026 included; photos copied to OUR storage. | §8 |
| 2026-11-12 | **Outlets/KYC/docs:** CISPL_Approval = Approved only (6,491); nothing from staging; owner groups → approved parents; fill blanks from group; shared bank across different owners → blank on all; city/pincode from ADDRESS when blank; non-approved profileStatus → Re-KYC after all data lands; docs copied to OUR storage (vendor links expire); rehearsal on a prod clone. | §1–§7 |

## 4. TDS
| Date | Decision | Where |
|---|---|---|
| 2026-11-13 | **194R Excel export gets three display-only columns** (approved, build in the NEXT release): 'Outlet Code' populated on PAN rows too (comma-separated for multi-outlet deductees), new 'Outlet Type' (Retailer / Wholesaler / SSS TOT) and new 'Outlet Name'. Today 'Outlet Code' appears only when a no-PAN row exists and is filled only from `noPanDeductee.outletCodes`, so PAN rows export blank — the owner spotted it in the downloaded Excel. No change to rate, threshold, amounts or any money path. ⚠️ PLATFORM-WIDE (shared export, Deoleo too) — explicit owner approval 2026-11-13. | 'Entity Type' derived from the PAN's 4th character (deliberately skipped) | §9.3 |
| 2026-11-13 | Bajaj follows **GROSS_UP**; owner saves TDS Config explicitly. **Corrected fact (code-verified 2026-11-13):** the method is recorded on every credit-upload ₹ payout but only CHANGES visibility payouts (Deduct = TDS taken out of the bank line; Gross-up = paid in full + TDS invoice). Incentive payouts are never deducted and raise no TDS invoice; the 194R report always shows the gross-up liability. Section applies only to visibility (incentive always 194R). Points redemptions never deducted (194R report only). Screen copy fixed to say exactly this. | TDS Config screen |
| 2026-11-13 | **TDS deposits count in the FY of the month they pay for** ("TDS for month" column; default: deposit day ≤ 7 → previous month; 8–30 April → March; else own month). ⚠️ platform-wide. | prod `247fae4b` |
| 2026-11-12 | **Deposit-only rows for ANY PAN** (a deposit never drops out of the totals). ⚠️ platform-wide. | prod `247fae4b` |
| open | 194C "Outstanding" = liability − deposited − withheld can double-count once Gifsy uploads deposits for withheld DEDUCT TDS (guide says don't upload withheld TDS as a deposit). Owner decision pending (non-blocking; prod has 0 such rows). | RESUME |

## 5. Payouts, credits, rounding
| Date | Decision | Where |
|---|---|---|
| 2026-11-12 | **Rounding:** points AND ₹ payouts credited in WHOLE units, rounded half-up once (₹199.5 → ₹200); uploads accept decimals and show "typed → credited". ⚠️ platform-wide (Deoleo: ₹150.5 now credits ₹151). | prod `247fae4b` |
| 2026-11-12 | **No-PAN payouts:** Bajaj-only flag `allowPayoutWithoutPan` (default OFF); per-partner no-PAN 194R / per-outlet 194C keys at 20%. Owner turns it ON for Bajaj prod. | prod `247fae4b` |
| 2026-11-12 | **UTR upload:** only processed payments can be marked PAID, but payments made OUTSIDE the platform are never blocked → "Paid outside platform (Y/N)" + note; never on bank-sent rows or refunded orders. | prod `247fae4b` |
| 2026-11-12 | Deoleo: all outlets have PAN (owner). | — |

## 6. Applies-to (KPI + visibility scope)
| Date | Decision | Where |
|---|---|---|
| 2026-11-12/13 | Build fast follow-ups #1 KPI ↔ Program/Sub-Program, #2 KPI multi outlet-type, #3 Visibility by Program/Sub-Program together; all ★ decisions D1–D12 approved. ⚠️ platform-wide (Deoleo unchanged — no scoped KPIs). | `APPLIES-TO-TARGETING-PLAN.md`, prod `247fae4b` |
| 2026-11-13 | **Single-outlet-type KPIs are enforced everywhere** (template N/A, uploads ignore, every screen/report/points agree; raw exports keep stored values). | prod |
| 2026-11-13 | **Re-uploads and batch deletes never delete stored out-of-scope values** (kept, hidden on screens, in exports). | prod |

## 7a. FOLLOW-UP LIST (owner 2026-11-13: not blocking go-live; pick up after the current releases)
| # | Item | Status / where |
|---|---|---|
| F1 | **TDS Treatment toggle saves to the wrong tenant** — a Gifsy admin working inside a brand saves to the HOME account ('gifsy'), so the brand keeps the default (owner saw "Saved" then 194C). Fix: server pins assumed operator to the assumed tenant; screen saves to the client it loaded; audit other admin screens for the same pattern. Bajaj meanwhile = default 194C + GROSS_UP (correct behaviour). Prod has a stray `gifsy` tdsPolicy row = 194R/GROSS_UP (harmless; can be reset). | Fix in progress on `feat/tds-count-imports` → next small release |
| F2 | Wallet reversal engine (WP2–WP8). | Paused; `WALLET-REVERSAL-ENGINE-DESIGN.md` on branch `feat/wallet-reversal-engine` |
| F3 | CI "Tests & Type-check" failure email (2026-11-13) — most likely the paused engine backup branch push; its API suite passes locally (5,951/5,951) → check the run log for the failing job and fix or note. | Investigate |
| F4 | Applies-to staging checks not yet done: sales-rep views (team view filters) + visibility editor Programs/Sub-Programs. | Staging |
| F5 | Optional platform-wide decision: should INCENTIVE payouts raise a TDS invoice under gross-up (today only visibility does; incentive TDS shows as 194R liability only)? | Owner decision |
| F6 | 194C "Outstanding" double-count when deposits for withheld DEDUCT TDS are uploaded (§4 open item). | Owner decision |
| F7 | Staging clean-up: test redemptions/batch `PB-1794549226921`, two 10-pt test credit batches, order BAJAJ-26-000031, earlier UAT data ("ZZ PIN test card", Sai Trader order). | Staging |
| F1 status | ✅ Fixed `63201b39` (server pins assumed operator; screen saves to the loaded client + re-reads; audit: no other page affected). Ships in the next small release. The stray `gifsy` `tdsPolicy` row {SEC_194R, GROSS_UP} (updatedAt 2026-11-13T08:14:54Z) is still on prod — **cleanup when convenient**, no tenant reads it. | — |
| F9 | Root cause of F1: `platform/src/lib/admin-session.ts` hard-codes `clientId: 'deoleo'` for every client admin/MIS user → `session.clientId` is wrong for Bajaj admins too. Fix: derive from auth/me or remove from the session type. ✅ Fixed `801c48d3`; ships with F1. | Next release |
| F8 | 194R export takes ~23 s for ~3,900 retailers — consider streaming/caching if it grows. | Perf |
| F10 | **194R Excel export columns** (§4 / §9.3): 'Outlet Code' on PAN rows, new 'Outlet Type' + 'Outlet Name'. ⚠️ PLATFORM-WIDE, approved 2026-11-13. | Build in the NEXT release |
| F11 | **Daily Operations Digest** — one tenant-sectioned digest replacing the two daily emails. ⚠️ PLATFORM-WIDE, owner approved option A. | **Approved, NOT started**; branch `feat/daily-ops-digest`, worktree `.claude/worktrees/ops-digest` |
| F12 | **Bajaj prod points rule + sales-import config** — `points_rules`, `sales_import_profiles` and `sales_kpi_definitions` are all EMPTY on prod (§ checklist "Prod readiness audit"). Owner has the KPI codes/rule content and will do the points rule before end-November; a test run with the main session is planned. | Owner + main session |

## 7. Pending owner actions (as of 2026-11-13 evening)
- Prod settings for Bajaj: no-PAN payouts ON · TDS Config GROSS_UP saved explicitly · ✅ imported-payouts counting from
  **2026-04-01 saved 2026-11-13** on the BAJAJ tenant (§9.1a).
- Spot-check a KYC "OTHER" document shows its real name on prod.
- **Bajaj prod points rule** (prod `points_rules` is empty) — owner before end-November, then a test run with the main session.
- **Bajaj sales-import config on prod**: column mapping (`sales_import_profiles` empty) + sales KPI definitions
  (`sales_kpi_definitions` empty). Prod Sales Import **infra already exists** — no owner infra OK needed any more.
- Files: ✅ October targets/achievements received + imported · October **rewards** file (separate, awaited) ·
  ✅ November sales file received 2026-11-13 · Bajaj PAN/GST corrections · retailer TDS deposits (if/when made) ·
  status of "UTR no. awaited" payouts.
- ✅ Hubble prod voucher whitelisting DONE (vendor, 2026-11-13; prod VPC egress 34.96.40.72 → HTTP 200 + token) →
  catalogue step unblocked.
- ✅ Client training deck done (2026-11-13), now incl. 7 install / allow-location slides (checklist I).
