# P0 baseline — git + test state of the inherited tree

Captured at start of P0 execution. **Branch `main`, ahead of `origin/main` by 4 commits**, with a large
uncommitted working tree from prior sessions.

## Git state
- **94 modified** tracked files + **62 untracked** files (~156 uncommitted changes).
- Includes a **completed, test-guarded refactor** of the credits-payouts domain: old libs
  (`credits-payouts-store/reversal/fields/payout-store`) were **deleted** and replaced by
  `app/api/admin/credits/*` route handlers + `credits-migration`. Guard tests in
  `src/lib/__tests__/credits-payouts-api.test.ts` (C1–C4, B1–B12) assert the old modules are gone and
  unreferenced. **`tsc --noEmit` is clean** → the refactor is coherent (no dangling imports).
- `prisma/schema.prisma` is modified and was **already pushed** to the dev DB (`gifsy_dev`, 79 tables).

## Test state (full `npx vitest run`)
**1556 passed / 115 failed across 29 files.** **Every failing file is untracked-NEW** — i.e. no committed
baseline test fails. **HEAD is green.** All red is unfinished TDD from prior sessions, written tests-first
for features that aren't wired yet (at least one — the sales ledger page — has a real runtime null-deref at
`sales/kyc/[id]/ledger/page.tsx:219` on `o.name`).

### Red files mapped to the phase that will finish them
| Area | Files | Phase | Nature |
|---|---|---|---|
| `sales/kyc/**` (detail, list, edit, ledger, new, team) | 16 | **P3** (+ some org views P2) | page wiring incomplete / real bugs (ledger null-deref) |
| `partner/wallet/**` (kpi-filter, narration, statement) | 3 | **P5** | page wiring incomplete |
| `partner/leaderboard/**` | 3 | **P7** | page wiring incomplete |
| `partner/targets`, `sales-excel-upload`, `target-excel-upload` | 3 | **P4** | wiring + source-structure asserts (`getTenantKpiDefs`) |
| `admin/hierarchy`, `admin/users/outlets`, `sales/team/**` | 4 | **P2** | page wiring incomplete |
| `credits-migration-live` | 1 | **P6** | live-DB integration test — fails only because vitest doesn't load `.env` (Prisma → stub). Fix in 0.1. |

## Decision taken for the baseline (chosen approach)
**Commit the whole inherited tree as one checkpoint baseline, with a recorded red-snapshot — do NOT
quarantine or branch the half-baked work.** Rationale (settled after review):
- A TDD build's suite is **red throughout** — every task starts red, every phase surfaces more. There is no
  "pristine green main" to protect; chasing it is a fiction and adds quarantine/rebase friction for months.
- The real gate is **differential, not absolute**: "do the tests for what I touched pass, and did I turn any
  previously-green test red?" That works on a known-red baseline **as long as the baseline is recorded.**
- The red files are **good, ~80%-baked, co-located** feature work — fastest to finish in place when their
  phase arrives (tests already written).

**Mechanism — the gate going forward:** `reconcile/baseline-red-snapshot.txt` records the exact known-red set
(29 files / 115 tests, mapped to phases). After any task: re-run the suite, diff the failing set vs the
snapshot. A NEW red not in the snapshot = a regression → reject. A snapshot entry now green = progress →
remove it. **The gate is "no new reds vs snapshot," never "zero reds."**

- 0.1 first win: make vitest load `.env` (or split integration tests) so `credits-migration-live` goes green
  and the dev DB is validated through Prisma end-to-end (10 reds → 0; then update the snapshot).

## P0 work completed this session (uncommitted, all green + tsc-clean)
- **0.0** reconcile (`reconcile/P0-shared-infra.md`).
- **0.2** `src/lib/api-response.ts` + test (shared `ok`/`err`).
- **0.3** `src/lib/__tests__/auth-getauthuser.test.ts` (getAuthUser contract; getClientId already covered).
- **0.4a** #1 domain rename `loyaltybase.in`→`gifsy.in` (8 files; verified 0 residual, 14/14, tsc clean).
