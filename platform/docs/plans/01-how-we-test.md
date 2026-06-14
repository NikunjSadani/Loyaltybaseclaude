# 01 · How we test (read before any task)

You write good production code; this doc is about writing good **tests**, because that's where
new engineers here struggle most. Tests are not an afterthought — in TDD they come first and
**drive** the design.

## The TDD loop (do this every task)

1. **RED** — write the smallest test that expresses the next bit of behavior. Run it. Watch it
   fail *for the right reason* (assertion fails, not "function undefined" forever).
2. **GREEN** — write the least code to make it pass. Ugly is fine here.
3. **REFACTOR** — clean up names/duplication with the test as your safety net. Re-run.
4. Commit. Repeat.

If you didn't see the test fail first, you don't know the test works.

## What makes a good test here

- **Test behavior (the contract), not implementation.** Assert on *what the function returns or
  does*, not on which private steps it took. A good test survives a refactor.
- **AAA shape** — Arrange (inputs/state), Act (call the thing), Assert (one clear expectation).
- **One behavior per test.** Many small `it()`s beat one big one. The name states the behavior:
  `it('credits points to the wallet for each POINTS row', …)`.
- **Cover the edges**: empty input, zero/negative amounts, the error path, the boundary
  (e.g. "row with `awardType: PAYOUT` is NOT credited as points").
- **Deterministic.** No real network, no real clock dependence (inject dates if needed), no
  reliance on test order.

### Good vs bad

```ts
// ❌ Bad: tests implementation detail, brittle, no edge cases
it('works', () => { expect(spy).toHaveBeenCalled(); });

// ✅ Good: states behavior, asserts the contract, names the case
it('returns PENDING_GIFSY after a first approval', () => {
  expect(nextStatusAfterFirstApprove('PENDING_SO_APPROVAL')).toBe('PENDING_GIFSY');
});
it('leaves an unknown status unchanged', () => {
  expect(nextStatusAfterFirstApprove('DRAFT')).toBe('DRAFT');
});
```

## The two test styles in this repo (and when to use each)

1. **Pure-function unit tests** *(preferred — use this whenever you can)*.
   The repo keeps decision logic in pure functions under `lib/` with no DB/browser, e.g.
   [`src/lib/kyc-approval.ts`](../../src/lib/kyc-approval.ts) and `src/lib/pace.ts`. Their tests
   (`src/lib/__tests__/*.test.ts`, `src/lib/pace.test.ts`) just call the function with inputs and
   assert outputs. **Fast, reliable, no mocking.**
   → **Design rule:** when a task touches a route, push the real logic into a pure `lib/`
   function and test *that*; keep the route a thin caller. This is how you make DB code testable.

2. **Source-read wiring tests** *(use for "is it wired correctly" checks)*.
   See [`src/app/admin/__tests__/admin-pages-wiring.test.ts`](../../src/app/admin/__tests__/admin-pages-wiring.test.ts).
   These read a file's source text and assert it imports/calls the right thing (e.g. "the page
   fetches `/api/admin/kpi-config` and does not call the old localStorage helper"). Use them to
   lock in wiring that's awkward to exercise at runtime — **not** as a substitute for testing
   logic.

## Testing code that touches Prisma

Prefer **option A**. Use **option B** only when logic genuinely can't be separated.

- **A — Extract the pure decision, test it directly.** Example for Milestone B: write a pure
  `pointsCreditsFromBatch(rows)` that, given batch rows, returns the list of
  `{ partnerId, amount, … }` to credit. Unit-test that with plain arrays — no DB. The route then
  just loops the result and calls `creditPoints()`.
- **B — Mock Prisma.** Vitest can replace the module:
  ```ts
  import { vi } from 'vitest';
  // ⚠️ src/lib/prisma.ts has BOTH a named (`export const prisma`) and a default export.
  // Mock BOTH — otherwise code that does `import { prisma }` (e.g. lib/wallet.ts) is NOT mocked.
  const fake = { wallet: { update: vi.fn() } };
  vi.mock('@/lib/prisma', () => ({ default: fake, prisma: fake }));
  ```
  Powerful but brittle and easy to get wrong — avoid unless A is impossible.

Note: many routes have a `DEMO_MODE` branch returning canned data. That is for manual/demo runs,
**not** a test strategy — don't assert against demo output.

## Running tests

```bash
npm test                                   # whole suite, once
npm run test:watch                         # re-run on change while you work
npx vitest run path/to/file.test.ts        # a single file
npx vitest run -t "credits points"         # tests whose name matches
```

## Per-task testing checklist

- [ ] At least one test fails before the change and passes after.
- [ ] The happy path **and** one edge/error case are covered.
- [ ] Tests assert behavior, not internals; names describe the case.
- [ ] No real network/DB/clock; deterministic.
- [ ] `npm test` and `npx tsc --noEmit` clean.
