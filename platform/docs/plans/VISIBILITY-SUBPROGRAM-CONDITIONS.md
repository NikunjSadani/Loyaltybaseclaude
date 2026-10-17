# Visibility capture — sub-program-driven conditional photos (Design B)

**Goal (owner, 2026-10-17):** in the Visibility (POSM) capture, one kind of Bajaj outlet must capture
**2 photos**, another **1 photo**, with the split driven by the outlet's **Sub-Program**
(`Outlet.programCategory`) — automatically, from the outlet master, not rep-entered.

## Why it isn't possible today (grounded in the code)
- Visibility SCOPE is by **OutletType.code** only (`visibilityConfig.outletScope`); every scope query is
  `outletType.code ∈ outletScope` (visibility-admin/capture/notify/report services). No program/sub-program axis.
- There is **one visibility form per tenant** (`VisibilityForm.clientId @unique`); photos = `CAMERA` fields.
- Form fields can be conditional (`visibleWhen` / `requiredWhen`), **but** `validateFormSchema` (Pass 2,
  visibility-form.helper.ts:216) rejects any clause whose `fieldId` is not another **form field**, and
  `evaluateClause` (…:254) only reads `submittedValues[fieldId]` — i.e. rep-entered form values. The
  outlet's sub-program is never in that map, so a condition can't key on it.

## The design — "outlet-attribute condition sources"
Introduce a tiny, reserved set of **synthetic condition fieldIds** that resolve from the outlet (not the
form), so a `requiredWhen` / `visibleWhen` clause can key on the outlet's Sub-Program. Ship `__subProgram__`
now; `__program__` and `__outletType__` are the same mechanism and can be enabled later at ~zero cost.

The engine is unchanged in spirit — we just **merge the outlet's real attributes into the values map**
before evaluating clauses, and **whitelist** the reserved ids in validation. The BE merges the authoritative
value server-side (so a client can't spoof away a required photo); the FE merges it only for live show/hide.

### Shared types (both `api/src/visibility/visibility-types.ts` and `platform/src/lib/visibility-types.ts`)
```ts
export const OUTLET_CONTEXT_FIELD_IDS = ['__subProgram__'] as const; // extensible: __program__, __outletType__
export type OutletContextFieldId = (typeof OUTLET_CONTEXT_FIELD_IDS)[number];
/** The outlet attributes exposed to conditional clauses, keyed by reserved id. */
export function outletContextValues(o: { programCategory?: string | null }): Record<string, string> {
  return { __subProgram__: (o.programCategory ?? '').trim() };
}
```

### Backend
1. **`visibility-form.helper.ts`**
   - `validateFormSchema` Pass 2 (:216): accept a clause `fieldId` that is a form field **or** in
     `OUTLET_CONTEXT_FIELD_IDS`. (Keeps the self-reference + op/value checks.)
   - No change to `evaluateClause` / `evaluateVisibleWhen` / `isFieldRequired` — they already take a values map.
2. **`visibility-capture.service.ts`** (submit + resubmit validation; it already loads the outlet and checks
   `outletType.code`): also select `programCategory`, build `ctx = outletContextValues(outlet)`, and pass
   `{ ...submittedValues, ...ctx }` into the required/visible projection (the loop at helper.ts:377/385).
   **Strip** any `__…__` keys the client sent from the stored `formValues` and re-inject the SERVER ctx for
   evaluation only (authoritative — the enforced photo requirement can't be spoofed by a crafted payload).

### Frontend
3. **`VisibilityCaptureForm.tsx`** — add an `outletContext?: { subProgram?: string }` prop; build the reserved
   values from it and merge into the `values` passed to `evaluateVisibleWhen` / `isFieldRequired` (live
   show/hide + required-marker). Keep stripping hidden + reserved keys from the submit payload (:250).
4. **Capture call sites** (sales Tasks capture sheet + the outlet-view capture redirect) — pass the outlet's
   `programCategory` as `outletContext.subProgram` (already present on the sales outlet payloads).
5. **`VisibilityFormBuilder.tsx`** — the ConditionEditor (`otherFields` source dropdown): prepend the
   outlet-attribute source(s) ("Outlet Sub-Program" → `__subProgram__`); offer the tenant's configured
   `outletCategories` as the value options. Update the builder's local schema validation (:108) to accept the
   reserved id. This lets a Gifsy admin configure: *2nd CAMERA, `requiredWhen` Outlet Sub-Program = `<X>`.*

### Resulting Bajaj configuration (no further code — a Gifsy-admin form edit)
One visibility form with two CAMERA fields: Photo 1 `required: true`; Photo 2
`requiredWhen: { fieldId: '__subProgram__', op: 'eq', value: '<2-photo sub-program>' }` (and the same clause as
`visibleWhen` so the 1-photo outlets never see it). Everything else (scope by outlet type, frequency,
geo-fence) is unchanged.

## Backward-compat / Deoleo-safety
Purely additive. Reserved ids do nothing unless a form's clause references them → every existing form
(incl. Deoleo's, and Bajaj's current one) behaves identically. The feature is **config-driven, tenant-agnostic**
— not even gated in code; it only "turns on" when a tenant's form uses the new condition source.

## Edge cases
- Outlet with blank Sub-Program → clause false → 2nd photo not shown/required (acceptable; or model the
  common case as the default and hide only for the 1-photo sub-program).
- Reserved-id ↔ real field-id collision → `validateFormSchema` forbids a real field declaring a reserved id.
- Client spoofing the context value → BE re-derives from the outlet; the client value is ignored for enforcement.
- Resubmit of a rejected capture → context re-derived from the outlet each time (not from stale formValues).

## Tests
- Helper: `validateFormSchema` accepts a clause on `__subProgram__`; `evaluateClause` with an injected
  `__subProgram__` toggles true/false.
- Capture submit (BE): 2nd photo required ONLY when the outlet's sub-program matches; a payload omitting it is
  rejected for the 2-photo sub-program and accepted for the 1-photo one; a spoofed context key is ignored.
- FE capture render: 2nd CAMERA shows/requires for sub-program X, hidden for Y.
- Form builder: the Outlet Sub-Program source is selectable and round-trips; schema with the reserved id validates.

## Estimate
**~0.5 day (4–6h) to staging-verified.** Change set ≈ 6 files + tests (2 shared type copies, BE helper, BE
capture service, FE capture form, FE form builder) — the engine seam is small; most effort is the builder UI
source + wiring context through the two capture call sites + BE submit enforcement.
Loop: contract → 2 parallel streams (BE engine+service / FE capture+builder) → integrate → FULL gates →
**independent adversarial audit** (this is a compliance/evidence path — the key invariant to attack is
"the required photo can't be dropped by a crafted payload or a blank/mismatched sub-program") → runtime-verify.
⚠️ **Platform-wide shared visibility code** → needs explicit owner go before build (though additive +
Deoleo byte-identical). After ship: a Gifsy-admin edits Bajaj's visibility form to add the conditional 2nd camera.
</content>
