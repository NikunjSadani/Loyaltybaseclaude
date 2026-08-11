# Plan — Free a deactivated user's phone; block reactivation when the phone is taken

**Status:** DRAFT — awaiting owner sign-off. No code written yet.
**Owner requirement (2026-08-11):** "When a user is DEACTIVATED, their phone number should be freed up so it can be used by other users in the same tenant. When a deactivated user is REACTIVATED, re-check the phone: if that phone is now in use by an ACTIVE user, block the reactivation and throw a clear plain-English error."
**Governance:** identity/auth-sensitive → mandatory dual adversarial audit + full gates + staging runtime-verify before any prod cutover. No prod DB op without the owner.

---

## ⚠️ Decisions needing your sign-off before I build

1. **Reservation predicate.** Recommend "**only an ACTIVE user reserves a phone**" (index `WHERE status = 'ACTIVE'`). This also means **SUSPENDED** and **PENDING_VERIFICATION** users release their number. If you want *suspension* to keep the number reserved (only full deactivation frees it), we use `WHERE status <> 'INACTIVE'` instead. → **Confirm: ACTIVE-only, or keep SUSPENDED reserved?**
2. **Reactivating a soft-deleted user.** Recommend that reactivation also clears `deletedAt` so the account is fully restored (today it doesn't, which would leave a "reactivated but still deleted" row that can't log in). → **Confirm: allow reactivating a soft-deleted account, and clear `deletedAt` when doing so?**
3. **Deactivated sales employees.** A deactivated sales employee's number is checked in the KYC path too. Recommend aligning it to the same "ACTIVE-only reserves" rule for consistency. → **Confirm: a deactivated employee's number becomes reusable?**
4. **Email symmetry.** The `(clientId, email)` unique has the same "inactive still reserves" behaviour. Recommend **OUT OF SCOPE** here (separate change) to keep this focused on phone/login. → **Confirm: leave email out for now?**

---

## 0. Verified ground truth (today's code)

- `User` model — `api/prisma/schema.prisma:487-542`. `status UserStatus @default(PENDING_VERIFICATION)` (:495), `phone` (:490), `deletedAt DateTime?` (:503).
- Phone uniqueness is a **plain** unique — `schema.prisma:533` `@@unique([clientId, phone])`; baseline `api/prisma/migrations/00000000000000_baseline/migration.sql:1550` (`users_clientId_phone_key`, **no WHERE**). So an INACTIVE / soft-deleted row **still reserves** the phone.
- `UserStatus` enum — `schema.prisma:27-32`: `ACTIVE`, `INACTIVE`, `SUSPENDED`, `PENDING_VERIFICATION`.
- Deactivate = `AdminCoreService.updateUser` writing `status:'INACTIVE'` (`api/src/admin-core/admin-core.service.ts:295-381`, status at :347) — does **not** set `deletedAt`. Soft delete = `deleteUser` (:383-409) writes `status:'INACTIVE'` + `deletedAt` (:394).
- Partial-index precedent to mirror: `20260723120000_partner_group_uniqueness/migration.sql:40-48` and `20260630130000_point_expiry_default_unique/migration.sql:10-12`; schema-comment pattern at `schema.prisma:765-768`.
- Migrations run via the **in-VPC Cloud Run Job** (`gifsy-migrate-staging` auto on `develop`; gated `gifsy-migrate` for prod). Partial indexes are hand-written in the migration SQL, never expressible in Prisma `@@unique`. Never run from a laptop (private-IP DB).

---

## 1. Predicate decision (see sign-off #1)

**Recommended:** partial unique index `WHERE "status" = 'ACTIVE'` — maps 1:1 to "deactivate frees / reactivate re-checks against ACTIVE."

| Predicate | Behaviour | Verdict |
|---|---|---|
| `status = 'ACTIVE'` | Only ACTIVE reserves. Deactivate frees immediately; SUSPENDED & PENDING also don't reserve. | **RECOMMENDED** |
| `deletedAt IS NULL` | Only *soft-delete* frees; a plain deactivation (no `deletedAt`) would **still reserve** → fails the requirement. | REJECTED |
| `status <> 'INACTIVE'` | INACTIVE frees; SUSPENDED/PENDING keep reserving. | Viable if you want suspension to hold the number |

Note under ACTIVE-only: PENDING_VERIFICATION is the default state a KYC owner sits in pre-approval — DB no longer reserves it, but the KYC flow already guards phones at the app level (`kyc.service.ts assertPhoneAvailable`), so this is acceptable (called out for the audit).

---

## 2. The migration

**Schema:** remove `@@unique([clientId, phone])` (`schema.prisma:533`), replace with a comment (mirroring `:765-768`) documenting that phone uniqueness is a partial index defined in the migration. Keep the non-unique `@@index([phone])`.

**New migration** `api/prisma/migrations/20260811120000_user_phone_active_partial/migration.sql`:
```sql
-- Only ACTIVE users reserve (clientId, phone). Prisma @@unique can't express a partial
-- predicate, so this is raw SQL (same pattern as 20260723120000_partner_group_uniqueness).
DROP INDEX IF EXISTS "users_clientId_phone_key";

CREATE UNIQUE INDEX IF NOT EXISTS "users_clientId_phone_active_key"
  ON "users" ("clientId", "phone")
  WHERE "status" = 'ACTIVE';
```

**MANDATORY pre-migration duplicate check** (read-only, in-VPC, with a `current_database()` guard). If two ACTIVE rows already share `(clientId, phone)` the `CREATE UNIQUE` fails and aborts the deploy:
```sql
SELECT "clientId", "phone", COUNT(*) AS n
FROM "users" WHERE "status" = 'ACTIVE'
GROUP BY "clientId", "phone" HAVING COUNT(*) > 1;
```
Expected 0 rows (the old plain unique guaranteed it). If any row returns → stop, resolve with owner.

**Apply:** staging auto via `gifsy-migrate-staging` on the `develop` push (fails deploy if the migration fails); prod via the gated `gifsy-migrate` job only, backup/PITR confirmed, owner-run.

---

## 3. App-level checks that must become status-aware

The DB index enforces the invariant; every app gate must agree, and — critically — every **login-by-phone** lookup must deterministically pick the ACTIVE user now that ACTIVE + INACTIVE duplicates can coexist.

| # | Location | Change |
|---|----------|--------|
| 3.1 | `createUser` phone check — `admin-core.service.ts:256` | add `status:'ACTIVE'` to the `where` (only collide with an ACTIVE holder) |
| 3.2 | `updateUser` phone-clash — `admin-core.service.ts:327` | add `status:'ACTIVE'` |
| 3.3 | `persistHierarchy` phone-in guard — `hierarchy-persistence.ts:194` | add `status:'ACTIVE'` (freed phone no longer blocks a hierarchy upload) |
| **3.4a** | `sendOtp` gate — `auth.service.ts:151` | key on `status:'ACTIVE'` instead of `deletedAt:null` |
| **3.4b** | **`verifyOtp` resolution — `auth.service.ts:273` (HIGHEST RISK)** | **two-step resolve** (below) |
| 3.5 | KYC lookups — `kyc.service.ts:1537, 3917, 4001`, and `assertPhoneAvailable:358` | add `status:'ACTIVE'` (companion change — see note) |

**3.4b — the critical one.** Today `verifyOtp` does `findFirst({ phone, clientId, deletedAt:null })` with **no `orderBy`**. Deactivation leaves `deletedAt=null`, so an INACTIVE duplicate still matches and a nondeterministic `findFirst` could return it and wrongly reject a valid ACTIVE login. Fix = **two-step resolve** that preserves today's error messages:
1. `findFirst({ where:{ phone, clientId, status:'ACTIVE' } })` → if found, that's the login (partial index guarantees ≤1).
2. If not found, fall back to `findFirst({ phone, clientId, deletedAt:null })` **only to pick the right message** (INACTIVE → "account is inactive", PENDING → "pending activation", none → "no account found"). Never mint tokens on this branch.

id-keyed lookups (`auth.service.ts:57,411`, refresh path :446-486) need no change.

**§3.5 scope note:** required for the invariant to hold end-to-end, but it's a larger blast radius (KYC + partner groups). Implement 3.1–3.4 as the core; treat 3.5 as a tightly-scoped companion reviewed in the same PR, since a nondeterministic KYC `findFirst` over an ACTIVE+INACTIVE duplicate becomes a latent bug the moment the index ships.

---

## 4. The reactivation re-check

In `updateUser`, add a branch symmetric to the existing `deactivating` block (`admin-core.service.ts:305-324`), placed before the phone-clash guard (:327):

- Trigger: `dto.status === 'ACTIVE' && target.status !== 'ACTIVE'`.
- Query + error:
```ts
const phoneToActivate = dto.phone ?? target.phone;
const activeHolder = await this.prisma.user.count({
  where: { clientId, phone: phoneToActivate, status: 'ACTIVE', id: { not: id } },
});
if (activeHolder > 0) {
  throw new BadRequestException(
    'This phone number is already in use by another active user. Change the phone number before reactivating this account.',
  );
}
```
- **Belt-and-suspenders:** the partial index is the real guard — wrap the `updateMany` (:353) in a try/catch mapping Prisma **P2002** on `users_clientId_phone_active_key` to the same `BadRequestException` message (so a race surfaces as clean English, not a 500).
- **`deletedAt`:** on reactivation, also set `deletedAt:null` (see sign-off #2) so a soft-deleted account is fully restored.

---

## 5. Edge cases (handled)

1. Two INACTIVE users share a phone, both reactivated → first wins; second gets the English error (or P2002-mapped on a race).
2. Reactivating a soft-deleted user → clear `deletedAt` + the §3.4b ACTIVE-first login makes it work (see sign-off #2).
3. Phone reused by a new ACTIVE user, then old owner reactivates → blocked with the error (the core requirement).
4. Multiple INACTIVE rows can share a phone → by design (predicate only constrains ACTIVE).
5. `(clientId, email)` unique → deactivated user still reserves email → **out of scope** (sign-off #4).
6. KYC `endsWith` last-10 matching → §3.5 must add the status filter to those queries too.

---

## 6. Test plan (jest)

- **`admin-core.service.spec.ts`:** createUser/updateUser phone checks now carry `status:'ACTIVE'`; reactivation blocked (exact error string) when an ACTIVE holder exists; reactivation allowed + `deletedAt:null` set when free; P2002 on the partial index maps to the same message; deactivate path unchanged.
- **`auth.service.spec.ts`:** verifyOtp resolves to the ACTIVE user when an ACTIVE+INACTIVE duplicate share a phone (assert resolved id + that the ACTIVE query runs first); single-INACTIVE still returns "account is inactive"; sendOtp gate keys on ACTIVE.
- **`kyc.service.spec.ts`:** the three User lookups + assertPhoneAvailable carry `status:'ACTIVE'`.
- **Integration (if DB-backed):** deactivate A(phone P) → create B on P (ok) → reactivate A (blocked) → hierarchy upload on P no longer collides.

---

## 7. Gate + governance

- **Dual adversarial audit** of §3.4b (login resolution) + §4 (reactivation) before merge.
- **Full gates green before every push:** `api jest` · `api nest build` · `platform vitest` · `platform tsc` (red suite silently skips staging deploy).
- **Pre-migration duplicate check** (read-only, in-VPC, `current_database()` guard).
- **Staging first:** migration auto-applies on `develop`; runtime-verify with real OTP logins (deactivate → reuse → reactivate-blocked; and an ACTIVE user with an INACTIVE duplicate logs in correctly).
- **Prod:** gated `gifsy-migrate` job, backup/PITR confirmed, SQL shown, owner-run. Never from a laptop.
- **Docs sweep** (schema comment, MIGRATIONS.md) in the same pass.

---

## Critical files for implementation
- `api/prisma/schema.prisma` (:533 comment; email note)
- `api/prisma/migrations/20260811120000_user_phone_active_partial/migration.sql` (NEW)
- `api/src/admin-core/admin-core.service.ts` (createUser :256, updateUser :327, reactivation + P2002 map ~:305/:353)
- `api/src/auth/auth.service.ts` (sendOtp :151, **verifyOtp :273 — highest risk**)
- `api/src/admin-core/hierarchy-persistence.ts` (:194) and `api/src/kyc/kyc.service.ts` (:1537, :3917, :4001, assertPhoneAvailable :358)
