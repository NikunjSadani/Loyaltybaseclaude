# Milestone A · Warm-up cleanups (low risk)

> **✅ DONE in P0.** A1 domain rename → 0.4a, A2 dead `ROLES` → 0.4b, messaging path → 0.4c.
> Kept as reference for the test→commit loop; do not re-run the find-replace.

Goal: learn the branch → test → commit → PR loop on changes that can't break money or auth.
Small, safe, high-confidence. Do these first.

## Task A1 — Fix stale domain references (Gap #1)

**Context:** the product domain is **`gifsy.in`** (with per-tenant subdomains), but the code
still says `loyaltybase.in` in comments and some values.

**Steps**
1. Find them: `grep -rn "loyaltybase.in" src` (look especially at
   [`src/lib/tenant.ts`](../../src/lib/tenant.ts) and
   [`src/lib/platform/client-registry.ts`](../../src/lib/platform/client-registry.ts)).
2. **Think before replacing** (DRY ≠ blind find-replace): a comment like `deoleo.loyaltybase.in`
   becomes `deoleo.gifsy.in`. But a **tenant's support email** (`support@deoleo.loyaltybase.in`)
   is tenant data — confirm the correct value with the product owner before changing; don't
   invent one. List anything you're unsure about in the PR description.
3. **RED:** add `src/lib/__tests__/domain-refs.test.ts` that reads those files and asserts
   `expect(src).not.toMatch(/loyaltybase\.in/)`. It fails now.
4. **GREEN:** make the corrections. Re-run.

**Commit:** `chore(config): use gifsy.in domain instead of loyaltybase.in`
**DoD:** test green; `tsc` clean; no behavioral code touched.

## Task A2 — Remove the dead `ROLES` constant (cleanup)

**Context:** [`src/lib/auth.ts`](../../src/lib/auth.ts) exports a `ROLES` object listing roles
(`SALES_MANAGER`, `AREA_SALES_MANAGER`, …) that **don't exist** in the `UserRole` enum
(`SALES_HO`, `SALES_STATE_HEAD`, …). It's misleading dead code.

**Steps**
1. **Verify it's unused** (never delete blind). ⚠️ Naive `grep "ROLES"` is a **trap** — it matches
   `ADMIN_ROLES`/`ALLOWED_ROLES` (~48 hits) and *looks* heavily used. Search for the **standalone
   symbol**:
   ```bash
   grep -rnE "\bROLES\b" src | grep -vE "_ROLES|ROLES_"   # → only the definition in auth.ts
   grep -rnE "\bRole\b" src                                  # the exported `Role` type
   ```
   You'll see `ROLES`/`Role` are defined in `auth.ts` and imported **nowhere** → safe to delete.
2. If unused → delete `ROLES` and the `Role` type. If **used**, stop: you've found a real bug
   (code referencing non-existent roles) — write it up and ask before proceeding.
3. `npx tsc --noEmit` is your test here (removal must not break types). Add a one-line note to
   the gap register "Also noted" section that this is done.

**Commit:** `chore(auth): remove dead ROLES constant that didn't match UserRole`
**DoD:** `tsc` + `npm test` clean; grep proves no usages.

## Task A3 — Decide the canonical messaging path (Gap #21)

**Context:** there are two messaging integrations: [`src/lib/msg91.ts`](../../src/lib/msg91.ts)
and the generic gateway in [`src/lib/notifications.ts`](../../src/lib/notifications.ts). Two paths
= confusion.

**Steps (investigation, minimal code)**
1. `grep -rn "from '@/lib/msg91'" src` and `grep -rn "from '@/lib/notifications'" src` — see which
   is actually used by routes today.
2. Write findings into a short note in `docs/spec/04-architecture.md` §5 (which is canonical, what
   the other is used for). **Don't delete anything yet** — that's a follow-up once the owner
   confirms. YAGNI: scope is "document the decision," not "migrate."

**Commit:** `docs(arch): record canonical messaging path (msg91 vs notifications)`
**DoD:** architecture doc updated; no risky code change.
