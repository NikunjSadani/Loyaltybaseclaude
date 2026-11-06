# Partner Rewards — filter-row UX (affordability chip · Wishlist de-dup · chip-row polish)

> **Status:** APPROVED 2026-11-06 by the owner (Nikunj) as **⚠️ PLATFORM-WIDE** — all three items reach every
> tenant incl. live **Deoleo**. Owner decisions: affordability filter on **Physical AND Vouchers** tabs; chip
> label is the **fixed text "Within my points"**. Frontend-only — **no backend, schema or migration change.**
> Builds on the dynamic category row (develop `635595f8`).

## 0. Read this first (zero-context primer)

**The product.** Loyaltybase is a multi-tenant trade-loyalty platform. "Partners" (retail outlet owners) earn
points and redeem them on the **partner Rewards page** for physical gifts, gift vouchers or a cash payout. Each
tenant ("brand", e.g. Deoleo, Bajaj) has its own catalogue. A change to shared partner code changes the page for
**every** brand — that is why this is "platform-wide".

**The page.** Everything here lives in ONE file:
`platform/src/app/partner/rewards/page.tsx` (~1,800 lines, a Next.js client component). Relevant landmarks
(line numbers approximate — search for the quoted text):

| What | Where (search for) |
|---|---|
| Catalogue item type | `interface CatalogueItem` (~line 55) — `points`, `voucherType: 'FIXED' \| 'FREE_AMOUNT'`, `minRedemptionPoints` |
| FREE_AMOUNT helper | `function isFreeAmount(` (~line 210) |
| Page component state | `const [wishlistFilter, setWishlistFilter]` (~line 1246), `category`, `search`, `tab` |
| Dynamic category list | `const categories = useMemo(` (~line 1395) |
| Effective tab | `const effectiveTab: MainTab =` — `'catalogue'` (Physical) \| `'vouchers'` \| `'bank'` |
| Filtering | `const filtered = useMemo(` (~line 1427) |
| Header Wishlist pill | `{/* Wishlist pill` (~line 1529) |
| Chip row | `{/* Category pills — catalogue only */}` (~line 1665) |
| Card "can afford" dimming | `const canAfford   = gift.voucherType === 'FREE_AMOUNT'` (~line 1701) |

**Domain rule you must not get wrong — "affordable".** The backend sends `isAffordable` per item, but it is
`balance >= pointsCost`, and **FREE_AMOUNT vouchers have `pointsCost = 0`**, so the backend flag says "affordable"
for every free-amount voucher even when the partner can't meet the minimum. **Do NOT use `isAffordable`.** The
correct rule already exists inline in the card render (see table) and must become ONE shared helper:
- FIXED / physical: `balance >= item.points`
- FREE_AMOUNT: `balance >= Math.ceil(settings.minVoucherFreeAmount * settings.pointsConversionRate)`

**Tests.** Vitest + React Testing Library, jsdom. Existing page tests live in
`platform/src/app/partner/rewards/__tests__/` — copy the mocking setup from **`category-chips.test.tsx`** (it
mocks the api client, `/api/rewards/catalog`, settings and features). Also read **`wishlist.test.tsx`** — it
exercises the Wishlist chip you are removing and WILL need updating. Run one file:
`cd platform && npx vitest run src/app/partner/rewards/__tests__/<file>`.

**Good test design here (please follow).**
- Test **behaviour a partner sees**, not implementation: "after tapping X, only items A and B are visible",
  queried by role/text (`getByRole('button', { name: 'Within my points' })`), never by CSS class — except the
  one place a class IS the behaviour (the fade overlay), where you assert on a `data-testid`.
- One behaviour per `it(...)`; name it as a sentence of the rule.
- Always include the **edge case that motivated the rule** (here: a FREE_AMOUNT voucher whose minimum exceeds the
  balance must be excluded; an item costing exactly the balance must be included).
- Write the test FIRST, run it, **watch it fail for the right reason**, then implement.

**Principles.** DRY (one affordability helper, used by the card AND the filter). YAGNI (no settings, no flags,
no animations library, no "show only when overflowing" scroll listeners). Small commits, one per task.

**Gates (must be green before the final commit).** From repo root: `bash scripts/gates.sh` — read its exit code /
`GATES: ✅` line, never a piped exit code. Frontend-only change, but run the full script anyway.

---

## Task 1 — Extract the shared affordability helper (pure refactor, no visible change)

**Files:** `platform/src/app/partner/rewards/page.tsx`; new test
`platform/src/app/partner/rewards/__tests__/affordability.test.ts`.

1. **Test first** (`affordability.test.ts`) for an exported pure function
   `isWithinPoints(item, balance, settings)` where `settings` is `{ minVoucherFreeAmount, pointsConversionRate }`:
   - FIXED item, `points` 500, balance 500 → `true` (exact balance counts).
   - FIXED item, `points` 501, balance 500 → `false`.
   - Physical item (no `voucherType`), `points` 300, balance 500 → `true`.
   - FREE_AMOUNT voucher, `points` 0, min ₹100 × rate 1 → needs 100 pts; balance 99 → `false`, balance 100 → `true`.
   - FREE_AMOUNT with a fractional rate (₹100 × 1.5 = 150) — balance 149 → `false` (uses `Math.ceil`).
2. Run it → fails (function not exported).
3. Implement `export function isWithinPoints(...)` next to `isFreeAmount` (pure, no React). Body = the existing
   inline rule from the card render.
4. Replace the inline `const canAfford = ...` in the card render with `isWithinPoints(gift, balance, settings)`.
5. Run the new test + `category-chips.test.tsx` + `rewards-redeem.test.tsx` → green. Commit:
   `refactor(partner): extract isWithinPoints affordability helper (rewards)`.

## Task 2 — "Within my points" filter chip (Physical + Vouchers)

**Files:** `page.tsx`; new test `__tests__/within-my-points.test.tsx` (copy setup from `category-chips.test.tsx`).

1. **Tests first:**
   - Physical tab: a chip/button named **"Within my points"** renders FIRST in the chip row, before "All", and
     is **not** pressed by default (`aria-pressed="false"`).
   - Tapping it shows only affordable physical items and sets `aria-pressed="true"`; tapping again restores all.
   - It **combines** with a category: chip ON + category "Luggage" → only affordable Luggage items.
   - Vouchers tab: the same chip renders (alone — category chips stay Physical-only) and filters vouchers; a
     FREE_AMOUNT voucher whose minimum exceeds the balance is **hidden** when ON.
   - Empty result while ON → empty state still renders (no crash).
2. Run → fail.
3. Implement:
   - State `const [withinPointsOnly, setWithinPointsOnly] = useState(false);` (shared by both tabs — a partner
     who turned it on keeps it on when switching tab; that is intended).
   - In `filtered`: `if (withinPointsOnly) items = items.filter(g => isWithinPoints(g, balance, settings));`
     (add `withinPointsOnly`, `balance`, `settings` to the memo deps).
   - Chip row: render it when `activeTab === 'catalogue' || activeTab === 'vouchers'`; inside, the new chip is
     always first; the category chips stay wrapped in `activeTab === 'catalogue'`.
   - Chip markup: `type="button"`, `aria-pressed={withinPointsOnly}`, same pill classes as category chips;
     active style = `bg-[var(--brand-primary)] text-white`. Fixed label text **"Within my points"**.
4. Green → commit `feat(partner): "Within my points" affordability filter on Rewards (platform-wide)`.

## Task 3 — Remove the Wishlist chip; make the header Wishlist pill the toggle

Why: the header already has a Wishlist pill that turns the same filter on. Removing the chip leaves the pill as
the ONLY control, so it **must** now also turn the filter OFF and visibly show it is ON — otherwise a partner gets
stuck in a filtered view.

**Files:** `page.tsx`; update `__tests__/wishlist.test.tsx`.

1. **Tests first** (in `wishlist.test.tsx`; delete/replace assertions that click the old chip):
   - The chip row no longer contains a "Wishlist" chip (only the header pill exists — assert exactly one
     element whose accessible name starts with "Wishlist").
   - Header pill: first tap → shows only wishlisted items, switches to the Physical tab, `aria-pressed="true"`.
   - Second tap → filter off, all items back, `aria-pressed="false"`.
2. Run → fail.
3. Implement: delete the chip `<button>` (the `{/* ♥ Wishlist filter chip` block). Header pill
   `onClick={() => { setWishlistFilter(v => !v); setTab('catalogue'); }}`, add `aria-pressed={wishlistFilter}`,
   active style `bg-red-500 text-white border-red-500` + `fill-white` heart (mirror the removed chip's styling).
   Keep the existing `aria-label` count text.
4. Green → commit `feat(partner): Wishlist filter toggled from the header pill only (platform-wide)`.

## Task 4 — Chip row: right-edge fade + keep the selected chip in view

**Files:** `page.tsx`; new test `__tests__/chip-row-polish.test.tsx`.

1. **Tests first:**
   - The chip row is wrapped in a `relative` container that contains an element with
     `data-testid="chip-row-fade"` and `aria-hidden="true"` (decorative only).
   - Selecting a category calls `scrollIntoView` on that chip with
     `{ block: 'nearest', inline: 'nearest' }` — mock it first:
     `Element.prototype.scrollIntoView = vi.fn()` (jsdom does not implement it), and assert the mock's
     `this`/instance is the selected chip (use `mock.contexts` or `mock.instances`).
2. Run → fail.
3. Implement:
   - Wrap the scroll row: `<div className="relative">` → existing `overflow-x-auto` row (add `pr-8` so the last
     chip can scroll fully clear of the fade) → sibling
     `<div data-testid="chip-row-fade" aria-hidden="true" className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-[var(--page-bg,white)] to-transparent" />`.
     Check what background the page actually uses (inspect the parent layout) and match it; if there's no CSS
     variable, use the literal background colour class.
   - A `useRef<Map<string, HTMLButtonElement>>` keyed by category; `ref` callback on each category chip. A
     `useEffect` on `category` → `chipRefs.current.get(category)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })`.
     (`?.` on `scrollIntoView` keeps old browsers/jsdom safe. `block:'nearest'` stops the PAGE jumping vertically.)
4. Green → commit `feat(partner): rewards chip-row edge fade + keep selected chip in view (platform-wide)`.

## Task 5 — Full gate, then hand back

1. `bash scripts/gates.sh` → must print `GATES: ✅ all passed.` (exit 0). If a suite flakes, re-run that ONE
   file in isolation to tell flake from regression; never weaken an assertion to pass.
2. Do **not** push. The orchestrator runs an independent review + staging verification, then pushes with the
   owner's OK.

## How to verify on staging (orchestrator / owner)

Bajaj staging partner: `https://uat-bajaj.gifsy.in` (staging OTP is fixed). On `/partner/rewards`:
1. Physical tab — "Within my points" is first in the row; ON hides gifts above the balance (e.g. Samsung phones
   at 19,000–23,000 pts when the balance is ~13.6k); combine with "Luggage".
2. Vouchers tab — chip present; ON keeps vouchers within balance.
3. No Wishlist chip in the row; header Wishlist pill toggles on/off and shows its ON state.
4. Narrow phone width — right edge fades; picking the last category scrolls it into view; the page doesn't jump.

## Out of scope (YAGNI — do not build)
"All categories" bottom sheet; desktop wrap/arrows; category image tiles; showing the live balance in the chip
label (owner chose fixed text); any backend change to `isAffordable`.
