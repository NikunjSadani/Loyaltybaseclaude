# Partner Rewards — pre-fill the physical-gift delivery address

> **⚠️ PLATFORM-WIDE — needs owner approval BEFORE any build.** It touches shared code that every tenant runs,
> including the **live Deoleo** program: the partner Rewards redeem sheet (`platform/src/app/partner/rewards/page.tsx`),
> the shared partner identity hook (`platform/src/lib/partner-identity.ts`), and the shared backend
> `GET /v1/partner/me` (`api/src/partner/partner.service.ts`), which every partner page loads.
> A **flag-gated variant** is possible and is the recommendation (see **D1**). The code still ships to everyone,
> but with a per-tenant flag defaulting OFF, Deoleo behaves exactly as it does today. Precedent: `catalogueMrpSlash` and
> `captureBankAtRedemption` both shipped as "PLATFORM-WIDE, Bajaj-flagged, Deoleo byte-identical".
>
> **Status:** ✅ SHIPPED to prod (in cutovers #56–#58, 2026-11; see `GO-LIVE-ISSUE-LIST.md`). _(Was: built on a worktree branch 2026-11-06.)_ Owner-approved PLATFORM-WIDE.
> Shipped: `api/src/partner/delivery-defaults.helper.ts` (pure selector), `deliveryDefaults` on `GET /partner/me`
> (read from the existing primary-outlet query, no extra query), `usePartnerIdentity().deliveryDefaults`,
> `platform/src/lib/address-prefill.ts` (`applyAddressPrefill`; moved from `app/partner/rewards/` on 2026-11-07 so the
> sales catalogue shares it), and the redeem-sheet wiring (the shown
> address is DERIVED from what the partner typed + the outlet defaults, so no effect and no overwrite).
> Pending: independent review, push to `develop`, staging runtime-verify (steps below, minus the flag / last-order steps). See **OWNER DECISIONS (taken)** at the
> bottom, which **override** the task text wherever they differ: always ON for every tenant incl. Deoleo (no flag,
> Task 3 dropped), outlet address ONLY (no last-order source, no `redemptionOrder` query), Task 0 is not part of
> the build (the feature degrades gracefully when nothing is on file).
>
> **Backend change: YES (small, additive, no schema/migration).** One new nullable key on the `/partner/me`
> response. **No** change to the redeem endpoint, DTO, validation or the `RedemptionOrder` table.

---

## 0. Read this first (zero-context primer)

**The product.** Loyaltybase is a multi-tenant trade-loyalty platform. "Partners" (retail/wholesale outlet owners)
earn points and redeem them on the **partner Rewards page** for physical gifts, vouchers or a cash payout. Each tenant
("brand": Deoleo, which is live in prod, and Bajaj, which is on staging) shares the same code. **`api/`** is NestJS + Prisma and owns
the DB and **all** business logic. **`platform/`** is a thin Next.js frontend: the browser calls `/api/*` and a rewrite
forwards it to the backend's `/v1/*`. The proxy (`platform/src/proxy.ts`) injects the auth token and the
`x-active-partner-id` header from cookies. **This Next.js version differs from your training data.** If you touch
anything routing-related, read `platform/node_modules/next/dist/docs/` first. This plan only touches client-component
state, so you should not need to.

**What happens today (current state, verified in code 2026-11-06):**
1. The partner taps a physical gift, then **Redeem now**, which opens the **"Delivery address"** step of `GiftDetailSheet`
   (`page.tsx`, search `function GiftDetailSheet`). It shows *Recipient name* (already pre-filled from
   `/api/auth/me` `user.name`) plus four **always-empty** inputs: `line1` (*Street address \**), `city` (*City \**),
   `state` (*State*, optional), `pincode` (*Pincode \**). State: `useState({ line1:'', city:'', state:'', pincode:'' })`.
2. FE validation (`handleSendOtp`) requires line1, city and pincode; pincode must match `/^\d{6}$/`.
3. It POSTs `/api/rewards/redeem` with `deliveryAddress: { name, mobile, address: line1, city, state: state||city, pincode }`.
   Backend DTO `RedeemDeliveryAddressDto` (`api/src/rewards/dto/rewards.dto.ts`) requires all six fields to be non-empty. The service
   (`rewards.service.ts`, `assertValidPincode`) additionally requires `/^[1-9]\d{5}$/` for `PHYSICAL_GIFT`.
4. The address is stored **only on the order**: `RedemptionOrder.deliveryAddressLine1/City/State/Pincode`
   (+ `deliveryName/Phone`; `deliveryAddressLine2` exists but the FE never sends it).
5. Nothing is pre-filled from data we hold. Partners retype their address on every redemption.

**Where address data lives (`api/prisma/schema.prisma`):**

| Model | Fields | Populated by |
|---|---|---|
| `Outlet` | `addressLine1?`, `addressLine2?`, `city` (**NOT NULL**), `district?`, `state` (**NOT NULL**), `pincode?` | `city`/`state`: outlet-master upload (always present). `addressLine1`/`pincode`: **KYC form** (`address`, min 5 chars; `pincode` 6 digits). Written at KYC **draft** for a brand-new outlet; for a re-KYC, staged and applied at Gifsy approval (`kyc.service.ts`, search `addressLine1: text.address`). `addressLine2` is never captured by the form. |
| `ChannelPartner` | **no address columns** | n/a |
| `KycSubmission` | no address columns (only `declarationData.outletAddressSnapshot` for the SO-declaration variant, and `proposedPartner` staging) | n/a |
| `RedemptionOrder` | `deliveryAddressLine1/2`, `deliveryCity/State/Pincode` | the redeem flow above |

No model has a `landmark` field. `Outlet.city` and `Outlet.state` are NOT NULL, so **city and state can essentially always be
pre-filled**. Only **street (`addressLine1`) and `pincode`** are at risk of being empty.

**Bajaj imported outlets (6,505, `enrollmentSource = VENDOR_IMPORT`).** The vendor dump **did** contain
`Address`, `City`, `Pin Code` and `MainState` columns. `BAJAJ-DATA-MIGRATION.md` §3 maps them to `city / pincode / address`, and
`BAJAJ-ENROLLMENT-IMPORTER.md` §3 says the Outlet gets "MainState/City/Pin/Address". The importer policy blanked only the
**23 invalid pincodes**. So the docs suggest the address **was** imported, which contradicts the owner's worry that it is
"likely empty". **This cannot be confirmed from the repo:** the import job (`bajaj-enrollment-import.job.js`) lived in a
past session's scratchpad and is not committed. Task 0 settles it with a count.
Also relevant: in Bajaj only **BSC = WHOLESALER** outlets (2,363; 2,317 wallets with points) redeem points. **RLP = SSS**
retailers are payout-only, so the wholesalers are the population that matters.

**Existing payloads the partner app already loads (DRY: reuse, don't add an endpoint):**
- `GET /api/auth/me`: `AuthService.getMe` (`api/src/auth/auth.service.ts`). It is keyed on `userId`, so it always returns the
  **login's own** partner and **ignores the active-outlet switch**. **Do not use it for the address**: a multi-outlet
  owner switched to a sibling outlet would get the wrong shop's address.
- `GET /api/partner/me`: `PartnerService.getMe` (`api/src/partner/partner.service.ts`). It **is active-outlet aware**
  (it re-authorizes `x-active-partner-id`), already loads the active partner's **primary outlet**
  (`resolvePartnerActivity`, ordered `isPrimary desc, createdAt asc`, the same row that drives `outletName`), and the
  Rewards page already consumes it through `usePartnerIdentity()` (`platform/src/lib/partner-identity.ts`).
  **This is the payload to extend.**
- `GET /api/rewards/orders` deliberately **excludes delivery PII** from its member projection. Don't reuse it for "last
  address", and don't add PII to it.

**Multi-outlet partners** (`PARTNER-MULTI-OUTLET.md`). Each child outlet keeps its **own** `ChannelPartner`/wallet. One
login can *act as* a login-less same-group sibling through the picker (`x-active-partner-id`). The redeem
(`POST /rewards/redeem`) is charged to the **active** partner, so the pre-fill must be the **active partner's primary
outlet**, which `/partner/me` already resolves. A parent (`isParent`) has no outlet and no wallet, so it never redeems.

**Adjacent finding — FIXED 2026-11-07 (branch `fix/sales-gift-redeem-address`, owner-approved platform-wide).** The
sales-assisted redeem (`platform/src/app/sales/catalogue/page.tsx` → `POST /rewards/redeem-for-outlet`) sent no
`deliveryAddress`, so a rep redeeming a *physical* gift got a 400. Now: `GET /sales/outlets` (`buildOutlets`, already
tenant + downline scoped) carries each outlet's `deliveryDefaults` (same `pickDeliveryDefaults`) + `ownerName`; the
catalogue's confirm step shows the address form for `PHYSICAL_GIFT` only, pre-filled via the shared
`@/lib/address-prefill`, hint "From the outlet address", phone = the outlet's mobile. No document upload (the partner
flow has none either). Vouchers/cash unchanged. **Still open:** VENDOR-sourced physical gifts need `consent: true`,
which the sales flow does not send (owner decision: who consents on the outlet's behalf).

### File landmarks (search for the quoted text; line numbers are approximate)

| What | Where |
|---|---|
| Redeem sheet component | `platform/src/app/partner/rewards/page.tsx`, `function GiftDetailSheet(` (~362) |
| Address state + recipient-name seeding pattern to copy | same file, `const [address,    setAddress]` (~379) and `recipientTouched` (~384) |
| Validation + payload | same file, `const handleSendOtp` (~404) |
| Address inputs | same file, `{ key: 'line1',   label: 'Street address *'` (~566) |
| Identity hook use on the page | same file, `const identity = usePartnerIdentity()` (~1264); sheet mount `<GiftDetailSheet` (~1862) |
| Identity hook | `platform/src/lib/partner-identity.ts`: `interface PartnerIdentity`, initial state, the `setIdentity((prev) => ({` mapper |
| `/partner/me` backend | `api/src/partner/partner.service.ts`: `async getMe(` (~95), `private async resolvePartnerActivity(` (~193), its `outlet.findMany` (~207) |
| Backend spec | `api/src/partner/partner.service.spec.ts`: `describe('getMe'`; the **exact `toEqual`** in the first `getMe` test MUST gain the new key |
| Redeem pincode rule (mirror it) | `api/src/rewards/rewards.service.ts`, `private assertValidPincode` (`/^[1-9]\d{5}$/`) |
| Per-tenant flag plumbing (only if D1 = B) | `platform/src/lib/platform/client-config.ts` (`FeatureFlags`), `platform/src/lib/platform/default-client-config.ts`, `platform/src/lib/tenant-features.ts` (`normalizeFeatures`), Gifsy console toggles `platform/src/app/gifsy/clients/new/page.tsx` + `platform/src/app/gifsy/clients/[slug]/page.tsx`, backend `api/src/gifsy/gifsy.service.ts`. Copy how `catalogueMrpSlash` is wired, file for file. |
| Physical-gift FE test harness to copy | `platform/src/app/partner/rewards/__tests__/vendor-consent.test.tsx` (`openGiftForm`, `fillAddress`, the `usePartnerIdentity` mock) |

### Tests, how to run one, gates
- **Frontend:** Vitest + React Testing Library (jsdom). Run one file:
  `export PATH="$HOME/.local/node/bin:$PATH"; cd platform && npx vitest run src/app/partner/rewards/__tests__/<file>`
- **Backend:** Jest. Run one file:
  `export PATH="$HOME/.local/node/bin:$PATH"; cd api && npx jest src/partner/<file>.spec.ts`
- **Gates (must be green before the last commit):** from the repo root, `bash scripts/gates.sh`. Read **its** exit code or
  the `GATES: ✅` line. **Never** trust a piped exit code (`| tail` hides failures).

**Good test design here (please follow).**
- Test the **behaviour a partner sees** ("the Pincode box already contains 411001") and query by **label**
  (`getByLabelText('Pincode *')`), not by CSS class or internal state.
- One rule per `it(...)`, named as a sentence: `it('never overwrites a field the partner already typed in', …)`.
- Always include the case that **motivated** the rule: an empty Bajaj outlet (nothing on file) must still render
  a working, empty form.
- Write the test **first**, run it, and **watch it fail for the right reason** (not a typo or import error) before implementing.
- Existing tests mock `usePartnerIdentity` **without** the new field. They must keep passing unchanged, which proves
  the "nothing on file" path. Don't "fix" them by adding the field.

**Principles.** DRY: one pure selection helper on the backend, one pure merge helper on the frontend, and no new endpoint.
YAGNI: see the out-of-scope list. TDD. **One task = one commit.** Commit footer as in `CLAUDE.md`.

---

## Task 0 (orchestrator, NOT the engineer): get the staging data count. No DB access.

**Do this before Task 1**, and present the numbers to the owner with the decisions. Use the existing admin
**Outlet Master** export. It is a read-only xlsx built from the same `Outlet` columns the feature would read, so no SQL is
needed and the CLAUDE.md DB guard does not apply.

1. **Get owner OK for a file download** (it contains PII: owner phones, GST/PAN, and **30-day signed KYC-doc links**). Then log in
   to **`https://uat-bajaj.gifsy.in`** as the Bajaj **CLIENT_ADMIN**. The owner does the OTP login.
2. Go to **Admin → Users → Outlets** (`/admin/users/outlets`) and click **"Download Outlet Master"**. Equivalent:
   **Admin → Reports → "Outlet Master"** (`/admin/reports`). Both call
   `GET /api/admin/reports/outlet-master` → `/v1/admin/reports/outlet-master`
   (`api/src/admin-programs/reports.service.ts`, `outletMaster`). About 6,515 rows.
3. The relevant columns are **`Outlet Code`, `Outlet Type`, `Owner Name`, `Address`, `City`, `State`, `Pincode`, `Profile Status`**.
   - `Address` = `addressLine1` + `addressLine2` joined by ", " (blank if both are null). `Pincode` = `Outlet.pincode` (blank if null).
   - **Imported vs native:** imported rows have **8-digit numeric** `Outlet Code`s (e.g. `50063963`). The ~10 native test
     outlets are `BJR…`/`BJW…`/`OUT-2026…`.
   - **Redeemer population:** `Outlet Type` = the WHOLESALER label (**"BSC"**, or "Wholesaler" if renamed) **and**
     `Owner Name` non-blank.
4. Count, for (a) all imported rows and (b) imported BSC rows:
   - **N** = rows
   - **A** = `Address` non-blank **and** ≥ 5 chars **and** not junk (`-`, `.`, `na`, `n/a`, `nil`, case-insensitive)
   - **P** = `Pincode` matches `^[1-9][0-9]{5}$`
   - **C** = `City` non-blank; **S** = `State` non-blank (expect ≈ N for both)
   - **FULL** = A ∧ P ∧ C. **PARTIAL** = (A ∨ P) ∧ ¬FULL. **NONE** = ¬A ∧ ¬P (city/state only)
5. Doing it locally: open the file in Excel/Sheets with filters, or run a throwaway script **from a separate directory**,
   for example `python3 -I count.py ~/Downloads/<file>.xlsx` (pandas `read_excel`, then the boolean masks above). **Delete the
   downloaded file afterwards.** Don't commit it and don't paste rows into chat.
6. Report: `N / FULL / PARTIAL / NONE` for both populations, plus the A and P counts.
   **Interpretation:** FULL ≥ ~80% means the feature mostly "just works" for Bajaj. NONE ≥ ~50% means it mainly pre-fills
   city/state until the last-order source (D3) kicks in after a partner's first redeem. In that case, raise **D6**
   (backfill from the vendor's corrected re-upload). The code is the same either way.
7. (Optional) repeat on Deoleo staging only if the owner chooses D1 = A (always-on).

---

## Task 1: Backend pure helper `pickDeliveryDefaults` (no wiring yet)

**Why a pure helper:** all the selection rules (precedence, pincode validity, blank handling) sit in one tiny function
with exhaustive unit tests. No Prisma mocking is needed to test them.

**Files:** new `api/src/partner/delivery-defaults.helper.ts`, new `api/src/partner/delivery-defaults.helper.spec.ts`.

Shape (export both):
```ts
export type DeliveryDefaultsSource = 'LAST_ORDER' | 'OUTLET';
export interface DeliveryDefaults {
  source: DeliveryDefaultsSource;
  line1: string | null;   // street; outlet = [addressLine1, addressLine2] joined ", "
  city: string | null;
  state: string | null;
  pincode: string | null; // ONLY if /^[1-9]\d{5}$/ (same rule as rewards assertValidPincode), else null
}
export function pickDeliveryDefaults(input: {
  lastOrder: { deliveryAddressLine1: string | null; deliveryAddressLine2: string | null;
               deliveryCity: string | null; deliveryState: string | null; deliveryPincode: string | null } | null;
  outlet: { addressLine1: string | null; addressLine2: string | null;
            city: string | null; state: string | null; pincode: string | null } | null;
}): DeliveryDefaults | null
```
Rules (assuming D3 = A; adjust if the owner picks otherwise):
- Trim every string; `''` and whitespace become `null`.
- **Whole-record precedence. Never mix sources field by field.** Mixing could combine one address's street with another's
  pincode. If `lastOrder` has a non-null line1, use it (`source: 'LAST_ORDER'`). Otherwise use `outlet` (`source: 'OUTLET'`).
- Pincode that fails `/^[1-9]\d{5}$/` becomes `null` (Bajaj had 23 invalid pincodes blanked; legacy data could hold `"0"`/5 digits).
- If the chosen record has **every** field null, return `null` (nothing to pre-fill).

1. **Tests first** (`delivery-defaults.helper.spec.ts`), one `it` each:
   - full outlet address, no order → `{source:'OUTLET', line1:'12 MG Road', city:'Pune', state:'Maharashtra', pincode:'411001'}`
   - outlet `addressLine1` + `addressLine2` → line1 `'Shop 4, Near Bus Stand'` (joined with ", ")
   - **partial**: outlet with pincode `null` → pincode `null`, other fields kept
   - **invalid pincode** `'011001'` / `'41100'` / `'4110011'` → pincode `null`
   - **Bajaj "nothing on file"**: addressLine1 null, pincode null, city `'Pune'`, state `'Maharashtra'` → line1/pincode null,
     city/state kept (still useful)
   - outlet with every field null or blank → returns `null`
   - outlet `null` and order `null` → `null`
   - whitespace-only street `'   '` → `null`
   - last order present → `source:'LAST_ORDER'` with the order's values, **even when the outlet is complete**
   - last order present but its line1 is null (e.g. a voucher/sales-assisted row slipped through) → falls back to outlet
   - **no mixing**: order has a street but pincode `null`, outlet has pincode `'411001'` → result pincode `null`
2. Run (`cd api && npx jest src/partner/delivery-defaults.helper.spec.ts`) → fails (module missing).
3. Implement. Pure function, no Nest/Prisma imports.
4. Green → commit `feat(partner): pickDeliveryDefaults helper for redeem address pre-fill (platform-wide)`.

## Task 2: Surface `deliveryDefaults` on `GET /v1/partner/me`

**Files:** `api/src/partner/partner.service.ts`, `api/src/partner/partner.service.spec.ts`.

1. **Tests first** (in `describe('getMe'`). Add `redemptionOrder: { findFirst: jest.fn() }` to `mockPrisma` and default it
   to `null` in `beforeEach`:
   - **Update** the existing exact `toEqual` ("no channel partner") to include `deliveryDefaults: null`, and assert
     `redemptionOrder.findFirst` is **not** called.
   - Partner with a primary outlet carrying a full address and no orders → `res.deliveryDefaults` equals the OUTLET object.
     Assert the outlet query still uses `orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }]` (same row as `outletName`).
   - **Multi-outlet / switched sibling**: with a valid `x-active-partner-id` selector (copy the existing "reflects the
     SWITCHED sibling identity" test), the outlet and order queries are keyed on the **sibling's** partnerId, and the
     returned address is the sibling's.
   - Last order lookup is **scoped**: `findFirst` called with
     `where: { partnerId: <active>, partner: { clientId: <tenant> }, redemptionMode: 'PHYSICAL_GIFT', deliveryAddressLine1: { not: null } }`,
     `orderBy: { createdAt: 'desc' }`, and a `select` of **only** the five address columns (no name/phone).
   - Last order present → `source: 'LAST_ORDER'`.
   - Partner with no outlet and no order → `deliveryDefaults: null` (and nothing throws).
   - *(only if D1 = B)* tenant flag OFF → `deliveryDefaults: null` **and** `redemptionOrder.findFirst` not called (Deoleo pays
     zero extra queries).
2. Run → fails.
3. Implement (keep it small):
   - In `resolvePartnerActivity`'s existing `outlet.findMany` `select`, add `addressLine1, addressLine2, city, state, pincode`
     (no extra outlet query) and return `primaryOutletAddress: outlets[0] ? {…} : null` alongside `outletName`.
   - In `getMe`, when `partner` exists (and, if D1 = B, `features.deliveryAddressPrefill === true`), run one
     `redemptionOrder.findFirst` (as tested; `RedemptionOrder` has an index on `partnerId`), then
     `deliveryDefaults = pickDeliveryDefaults({ lastOrder, outlet: primaryOutletAddress })`. Otherwise `null`.
   - Add `deliveryDefaults` to the returned object, with a comment: *"the ACTIVE outlet's pre-fill for the physical-gift delivery
     form; the partner's own data, re-authorized via resolveActivePartnerId; never logged."*
4. Run the spec, plus `src/rewards/rewards.service.spec.ts` as a sanity check → green. Commit
   `feat(partner): deliveryDefaults on /partner/me for the redeem address pre-fill (platform-wide)`.

## Task 3 (ONLY if D1 = B): per-tenant flag `deliveryAddressPrefill` (default OFF)

**Files:** mirror `catalogueMrpSlash` exactly. Grep `catalogueMrpSlash` across `platform/src` and `api/src` and add the new key
beside it in each place: `FeatureFlags` type, `DEFAULT_CLIENT_CONFIG.features` (= `false`), `normalizeFeatures`, the two
Gifsy console client pages (toggle + label "Pre-fill delivery address on gift redemption"), and `gifsy.service.ts`
(allowed feature keys).
1. **Tests first:** in the existing `tenant-features` test, `normalizeFeatures({})` → `deliveryAddressPrefill: false`, and
   `{deliveryAddressPrefill:true}` → `true`. Copy the nearest existing console-toggle test, if there is one, for the new toggle.
2. Implement, green, commit `feat(platform): deliveryAddressPrefill per-tenant flag, default OFF (platform-wide)`.
   *(If D1 = B, do this task **before** Task 2 so Task 2 can read the flag.)*

## Task 4: Frontend identity hook carries `deliveryDefaults`

**Files:** `platform/src/lib/partner-identity.ts`; new test `platform/src/lib/__tests__/partner-identity-delivery-defaults.test.tsx`
(copy the fetch-stub setup from `platform/src/lib/__tests__/partner-identity-self-heal.test.tsx`).

1. **Tests first:**
   - `/api/partner/me` returns `deliveryDefaults: {source:'OUTLET', line1:'12 MG Road', city:'Pune', state:'Maharashtra', pincode:'411001'}`
     → `result.current.deliveryDefaults` equals it after loading settles.
   - Response **without** the key (older backend or flag off) → `deliveryDefaults === null`.
   - Malformed value (e.g. a string) → `null`.
   - Fetch error → `null`, `loading` false.
2. Run → fails.
3. Implement: export `DeliveryDefaults` type (same shape as the backend; don't import from `api/`). Add
   `deliveryDefaults: DeliveryDefaults | null` to `PartnerIdentity`, initial state `null`, mapper
   `deliveryDefaults: isDeliveryDefaults(d?.deliveryDefaults) ? d.deliveryDefaults : null` (tiny type guard: object with a
   `source` of `'LAST_ORDER'|'OUTLET'`).
4. Green → commit `feat(partner): expose deliveryDefaults from usePartnerIdentity (platform-wide)`.

## Task 5: Pure FE merge helper `applyAddressPrefill`

**Why:** the hard rule, **"pre-fill never overwrites what the user typed"**, also has to hold when `/partner/me`
resolves *after* the sheet opens. Encode it once, in a pure function, and test it exhaustively.

**Files:** new `platform/src/app/partner/rewards/address-prefill.ts` (a colocated non-route module is fine in the app dir),
new `platform/src/app/partner/rewards/__tests__/address-prefill.test.ts`.

```ts
export type AddressForm = { line1: string; city: string; state: string; pincode: string };
export type TouchedFields = Partial<Record<keyof AddressForm, boolean>>;
/** Fill ONLY fields that are empty AND untouched; returns the same object if nothing changes. */
export function applyAddressPrefill(form: AddressForm, touched: TouchedFields,
                                    defaults: DeliveryDefaults | null | undefined): AddressForm
```
1. **Tests first:**
   - empty form + full defaults → all four filled
   - empty form + `null`/`undefined` defaults → unchanged (same reference)
   - partial defaults (pincode `null`) → pincode stays `''`, others filled
   - a field the partner **typed** (`touched.city = true`, `city:'Mumbai'`) → kept as `'Mumbai'` even though defaults say `'Pune'`
   - a field the partner **cleared** (`touched.line1 = true`, `line1:''`) → stays `''` (a deliberate clear is respected)
   - a non-empty untouched field is not replaced (idempotent on re-run)
2. Run (`npx vitest run src/app/partner/rewards/__tests__/address-prefill.test.ts`) → fails.
3. Implement (pure, no React).
4. Green → commit `feat(partner): applyAddressPrefill merge helper (platform-wide)`.

## Task 6: Wire the pre-fill into the redeem sheet

**Files:** `platform/src/app/partner/rewards/page.tsx`; new test
`platform/src/app/partner/rewards/__tests__/delivery-address-prefill.test.tsx` (copy the whole harness from
`vendor-consent.test.tsx`, including `openGiftForm`, and make the `usePartnerIdentity` mock return a **mutable** object, as
`rewards-redeem.test.tsx` does with `mockIdentity`).

1. **Tests first** (use `PLATFORM_GIFT`, no consent box; query inputs by **label**):
   - **Full address on file** → after *Redeem now*, Street/City/State/Pincode show the defaults. *Send OTP* POSTs
     `deliveryAddress` with exactly those values (`address` = line1).
   - **Partial (pincode missing)** → Pincode is empty, the rest is filled. *Send OTP* shows the existing
     "valid 6-digit pincode" / required-fields toast and does **not** POST. After typing `411001`, it POSTs.
   - **Nothing on file** (`deliveryDefaults` absent from the mock) → all four empty, the form works exactly as today, and no hint is shown.
   - **Multi-outlet**: the FE simply renders what the identity says. Assert the sheet uses `identity.deliveryDefaults`
     (the active outlet's) and **not** anything from `/api/auth/me`. Make the `/api/auth/me` stub return a different
     `channelPartner` and assert those values never appear.
   - **User edits the pre-fill** → clear City, type `Nashik`, *Send OTP* → POST has `city: 'Nashik'`.
   - **Pre-fill never overwrites typing**: mock identity starts with `deliveryDefaults: null`. Open the form, type
     `Mumbai` in City, then `rerender` with defaults (`city:'Pune'`, `pincode:'411001'`) → City still `Mumbai`, Pincode
     becomes `411001`.
   - **Hint copy** (assuming D5 = A): `source:'OUTLET'` → text "Pre-filled from your registered shop address. Please check before
     continuing." `source:'LAST_ORDER'` → "Pre-filled from your last gift delivery. Please check before continuing."
2. Run → fails.
3. Implement:
   - New prop on `GiftDetailSheet`: `deliveryDefaults: DeliveryDefaults | null`. The page passes
     `deliveryDefaults={identity.deliveryDefaults ?? null}`. The `?? null` matters: existing tests mock the hook without the field.
   - Initialise: `useState(() => applyAddressPrefill(EMPTY, {}, deliveryDefaults))`. Add
     `const [touched, setTouched] = useState<TouchedFields>({})`, and on each input's `onChange` set `touched[key] = true`.
   - Late arrival: `useEffect(() => setAddress(a => applyAddressPrefill(a, touched, deliveryDefaults)), [deliveryDefaults])`.
     This is the same idea as the existing `recipientTouched` effect. (Leave `touched` out of the deps; the helper reads it.
     Add a one-line comment explaining why.)
   - Accessibility, and required for the label queries: give each address input an `id` (`addr-line1`, …) and its `<label htmlFor>`.
   - Hint: one `<p className="text-xs text-gray-500">` under the existing "Enter who this is for…" line, rendered only when
     `deliveryDefaults` is non-null **and** at least one field was actually pre-filled.
   - **Do not** change validation, the payload shape, `state || city`, or anything in the OTP/confirm steps.
4. Run the new file **plus** `vendor-consent.test.tsx`, `rewards-redeem.test.tsx` and `mrp-slash.test.tsx` → all green, with the
   **existing ones unmodified**. Commit `feat(partner): pre-fill the gift delivery address from the active outlet (platform-wide)`.

## Task 7: Docs sweep (CLAUDE.md agreement #5)

**Files:** this plan (flip **Status** to BUILT and record the decisions taken), `platform/docs/plans/GO-LIVE-ISSUE-LIST.md`
(one row: what shipped, the classification, the flag state, the Task 0 counts), `platform/docs/plans/BAJAJ-CUSTOMIZATIONS.md`
(only if D1 = B: the flag and its Bajaj state). Fix the stale schema comment
`addressLine1 // captured at KYC, not in the outlet master file` **only** if Task 0 proved the importer populates it.
That is a comment-only edit in `api/prisma/schema.prisma`, with **no** migration. Commit `docs: delivery-address pre-fill plan → built`.

## Task 8: Full gate, then hand back

1. `bash scripts/gates.sh` must end with `GATES: ✅` and exit 0. If a suite flakes, re-run that one file to tell flake from regression.
   Never weaken an assertion to get green.
2. **Do not push.** The orchestrator runs an independent review and re-confirms the owner's platform-wide approval
   (the pre-push hook will prompt). Then it pushes to `develop`, which deploys to staging.

---

## How to verify on staging (orchestrator / owner, real OTP login per role)

1. *(D1 = B)* Gifsy console → Bajaj client → enable **"Pre-fill delivery address on gift redemption"**. Leave Deoleo OFF.
2. `https://uat-bajaj.gifsy.in`: log in as an **imported BSC wholesaler** that Task 0 classed **FULL**. Rewards → a physical gift →
   *Redeem now*. All four fields are pre-filled with the outlet-master values and the "registered shop address" hint shows.
   Edit City, *Send OTP*. Optionally abandon at the OTP step (no points move until confirm).
3. Log in as a wholesaler classed **NONE**. City/State are pre-filled, Street/Pincode are empty, and Send OTP blocks until they are filled.
4. **Last-order source:** for the partner from step 3, complete one physical redemption, then reopen any gift. The form now
   shows that address with the "last gift delivery" hint.
5. **Multi-outlet:** a login with a same-group sibling (picker visible). Switch to the sibling. The pre-fill shows the
   **sibling's** shop address, not the login's own.
6. **Deoleo staging partner** (flag OFF): the form is empty exactly as before, and `/api/partner/me` has `deliveryDefaults: null`.
7. Browser devtools: `/api/rewards/orders` still has **no** delivery fields. Only `/api/partner/me` carries the address.

## Out of scope (YAGNI: do not build)
- An address book / multiple saved addresses / "Use a different address" picker; a `landmark` field; an `addressLine2` input.
- Writing the typed address back to `Outlet` or `ChannelPartner` (see D7). A redemption must not mutate KYC-verified data.
- Pre-filling for vouchers / cash (no address needed) or changing recipient name/mobile behaviour.
- Pincode → city/state lookup service; server-side address validation beyond today's rules.
- Any schema change or migration; changing `RedeemDto` or `GET /rewards/orders`.
- Backfilling Bajaj outlet addresses (a separate, owner-gated data task: D6).
- The sales-assisted physical-redeem address gap (noted above; fixed separately on 2026-11-07).

---

## OWNER DECISIONS (taken 2026-11-06; these override the tasks above where they differ)

- **D1 = A (always ON, every tenant incl. live Deoleo).** No per-tenant flag. **Task 3 is dropped.** The owner approved
  the platform-wide change explicitly.
- **D2 = A.** Extend `GET /partner/me` (active-outlet aware). Never `/auth/me` (wrong outlet after a multi-outlet switch).
- **D3 = C (outlet address ONLY).** The pre-fill is the ACTIVE partner's primary outlet address on file. **No** last-order
  source: no `redemptionOrder.findFirst`, no `LAST_ORDER` source, no "last gift delivery" hint. Because there is only one
  source, the payload drops the `source` discriminator: `deliveryDefaults: { line1, city, state, pincode } | null`.
  The helper takes only the outlet. The Task 1/2/6 test cases about last orders and "no mixing" do not apply.
- **D4 = A.** Fill whatever parts are on file; the existing required-field validation makes the partner complete blanks.
- **D5 = A, simplified copy.** One small grey hint line, "From your outlet address", shown only when at least one field
  was actually pre-filled.
- **D6 = ship regardless** of how empty the Bajaj outlet data is. With nothing on file: no hint, empty fields as today.
  **Task 0 is not part of the build.**
- **D7 = A.** Never write an edited address back to the outlet.
- **Hard rule:** the pre-fill NEVER overwrites anything the partner has typed (or deliberately cleared), including when
  `/partner/me` resolves after they started typing.
- Out of scope here: the sales-assisted physical-redeem address gap (`platform/src/app/sales/catalogue`) — since fixed
  separately (2026-11-07, see the "Adjacent finding" note in §0).
- **As built:** Task 0, Task 3 (flag) and every last-order element were skipped per the above. `BAJAJ-CUSTOMIZATIONS.md`
  is untouched (no flag) and the `addressLine1` schema comment is untouched (Task 0 not run). Staging verify = steps 2, 3,
  5 and 7 of "How to verify on staging", plus: a Deoleo staging partner now ALSO sees its outlet address pre-filled
  (always-on), and `/api/partner/me` carries `deliveryDefaults` for it.

## Original open decisions (for the record; superseded by the section above)

**D1. Rollout scope (the platform-wide gate).**
- A) Always ON for every tenant incl. live Deoleo (simplest, but Deoleo's form changes).
- ★ B) Same shared code behind a per-tenant flag `deliveryAddressPrefill`, **default OFF**. Enable Bajaj on staging; Deoleo
  stays byte-identical and pays no extra query. This follows the `catalogueMrpSlash` / `captureBankAtRedemption` precedent.
  Adds Task 3.
- C) Don't build.

**D2. Where the frontend gets the address.**
- ★ A) Extend the existing `GET /partner/me`. It already resolves the active outlet and its primary-outlet row, and the Rewards
  page already loads it. Cost: one extra indexed query per `/partner/me` call, and only when the flag is on.
- B) New `GET /rewards/delivery-defaults`, fetched only when the delivery form opens (no shell-payload growth, but a new route,
  new proxy path and a duplicated active-outlet resolution).
- C) `/auth/me`. **Not viable**: it ignores the active-outlet switch, so a multi-outlet owner would see the wrong shop.

**D3. Which source wins.**
- ★ A) **Last physical-gift delivery address** of the active outlet, else the **outlet's KYC/master address**. The whole record
  comes from one source and fields are never mixed. This makes the feature useful even when Bajaj outlet addresses are empty:
  after the first redeem, the partner never retypes.
- B) Outlet address first, last order as fallback.
- C) Outlet address only (smallest build; no order query).
- D) Last order only.

**D4. Partial outlet address (e.g. no pincode).**
- ★ A) Pre-fill what we have and leave the rest empty. The existing required-field validation makes the partner complete it.
- B) Pre-fill only when the address is complete (fewer partial forms, but city/state help is lost for most Bajaj outlets if NONE is high).

**D5. Tell the partner where the pre-fill came from?**
- ★ A) Yes, one grey line: "Pre-filled from your registered shop address / your last gift delivery. Please check before continuing."
- B) No hint.

**D6. If Task 0 shows Bajaj street/pincode mostly empty.**
- ★ A) Ship anyway (graceful: city/state now, last-order after the first redeem). **Also** make sure the vendor's corrected
  re-upload (already pending per `BAJAJ-ENROLLMENT-IMPORTER.md` §5b) carries Address + Pin Code into `Outlet` (owner-gated data job).
- B) Hold the feature until the data is backfilled.
- C) Ship without any data follow-up.

**D7. Save a typed/edited address back to the outlet?**
- ★ A) No. The outlet address is KYC-verified; the order keeps its own copy, and D3-A reuses it next time.
- B) Yes, update `Outlet.addressLine1/pincode` from the redemption (mutates verified data; would need its own audit).
