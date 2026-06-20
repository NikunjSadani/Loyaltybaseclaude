# Runbook: PROD / Staging Tenant-Data Wipe (A-10)

> **Destructive. Irreversible without a restore.** This runbook clears all
> seed/UAT data for a set of tenants from a database so that **real client data**
> can be loaded onto a clean slate. It runs at the **Deoleo cutover**: after
> staging UAT, after the minimal prod real-OTP smoke, **before** loading real
> Deoleo data.

Script: [`api/prisma/wipe-tenant-data.ts`](../../../../api/prisma/wipe-tenant-data.ts)

---

## 1. Purpose & when this runs

Data lifecycle (D-e / O-5):

```
seed staging  →  UAT on staging (bulk bug-fixing)  →  minimal real-OTP smoke on prod
              →  CLEAN-WIPE (this runbook)          →  load real Deoleo client data
```

The wipe deletes **only** rows owned by the named tenant `clientId`s (default
`deoleo,clientb`). It never touches:

- the **GIFSY platform** admin user / the `gifsy` client row (the script hard-refuses
  if `gifsy` is listed as a target),
- **global / master / config tables** with no per-tenant owner: `Client` (the tenant
  registry itself), `OutletType`,
- any **other tenant's** rows,
- `TdsDeposit` rows with a **null** `clientId` (those are GIFSY/194C platform rows).

---

## 2. HARD PRECONDITION — backups + PITR first (O-4)

> 🛑 **DO NOT RUN THE REAL WIPE UNTIL THIS IS TRUE.** The script's *only* rollback
> is a point-in-time restore. If backups/PITR are not enabled, a mistake is
> unrecoverable.

- [ ] **Cloud SQL automated backups are ENABLED** on the target instance
      (`gifsy_db` — shared by staging + prod).
- [ ] **Point-in-time recovery (PITR) is ENABLED.**
- [ ] You have **noted the current timestamp** (and ideally taken an **on-demand
      backup**) immediately before the wipe, so a restore target is unambiguous.

(Owner task O-4. This blocks A-5 and A-10.)

---

## 3. Safety guards built into the script

All four must pass before a single row is deleted:

| Guard | Env / arg | Behaviour on failure |
|------|-----------|----------------------|
| **1. Positive DB-name assertion** | `WIPE_TARGET_DB` must EXACTLY equal `SELECT current_database()` | prints error, `exit 1` |
| **2. Confirmation token** | `WIPE_CONFIRM` must EXACTLY equal `WIPE <db> <clientIds>` | prints the expected token, `exit 1` |
| **3. Tenant scope** | `WIPE_CLIENT_IDS` (default `deoleo,clientb`); `gifsy` is rejected | prints error, `exit 1` |
| **4. Dry-run by DEFAULT** | real wipe requires `WIPE_DRY_RUN=false` (or `--no-dry-run`) | does counts only, no deletes |

The whole wipe runs inside a **single transaction**, so any failure rolls back the
entire operation — it can never leave the DB half-wiped.

---

## 4. Environment variables

| Var | Required | Example | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | `postgresql://…/gifsy_staging` | the connection (same as the app). Determines which DB you actually connect to. |
| `WIPE_TARGET_DB` | yes | `gifsy_staging` | must match `current_database()` of `DATABASE_URL` exactly. The deliberate "name the DB" guard. |
| `WIPE_CLIENT_IDS` | no | `deoleo,clientb` | comma-separated tenant slugs. Defaults to `deoleo,clientb`. |
| `WIPE_DRY_RUN` | no | `false` | **omit / `true` = dry-run (default, safe).** Only `false` performs deletes. |
| `WIPE_CONFIRM` | for real wipe | `WIPE gifsy_staging deoleo,clientb` | format = `WIPE ` + DB name + ` ` + the client ids joined by comma, in the same order as `WIPE_CLIENT_IDS`. |

### Confirmation-token format

```
WIPE <WIPE_TARGET_DB> <clientId,clientId,…>
```

The client-id list must be **byte-for-byte** what the script computes from
`WIPE_CLIENT_IDS` (trimmed, comma-joined, same order). If you mistype it, the
script prints the exact expected string — copy it verbatim.

---

## 5. Mandatory sequence — dry-run on staging, then prod

> Never skip a dry-run. The dry-run is the audit: it proves the scope and counts
> before anything is destroyed.

### Step A — DRY-RUN on **staging**

```bash
# DATABASE_URL points at staging
WIPE_TARGET_DB=gifsy_staging \
WIPE_CLIENT_IDS=deoleo,clientb \
npx ts-node api/prisma/wipe-tenant-data.ts
```

- Confirm `mode: DRY-RUN (no deletes)` in the header.
- **Read the count table** (see §6). Sanity-check the numbers.

### Step B — REAL wipe on **staging** (validate the path end-to-end)

```bash
WIPE_TARGET_DB=gifsy_staging \
WIPE_CLIENT_IDS=deoleo,clientb \
WIPE_DRY_RUN=false \
WIPE_CONFIRM="WIPE gifsy_staging deoleo,clientb" \
npx ts-node api/prisma/wipe-tenant-data.ts
```

- Re-run the dry-run afterwards → every count should now be **0**.

### Step C — confirm O-4 backups/PITR on **prod**, take an on-demand backup, note the timestamp.

### Step D — DRY-RUN on **prod**

```bash
# DATABASE_URL points at prod
WIPE_TARGET_DB=gifsy_prod \
WIPE_CLIENT_IDS=deoleo \
npx ts-node api/prisma/wipe-tenant-data.ts
```

- For prod you likely target **only `deoleo`** (no `clientb` — that's an E2E
  fixture). Adjust `WIPE_CLIENT_IDS` accordingly and update the token to match.

### Step E — REAL wipe on **prod** (owner-supervised)

```bash
WIPE_TARGET_DB=gifsy_prod \
WIPE_CLIENT_IDS=deoleo \
WIPE_DRY_RUN=false \
WIPE_CONFIRM="WIPE gifsy_prod deoleo" \
npx ts-node api/prisma/wipe-tenant-data.ts
```

### Step F — load real Deoleo data, then run prod smoke (login → earn/view → redeem → OTP → confirm + leaderboard).

---

## 6. How to read the count output

The script prints one line per table, in **FK-safe (children-before-parents)** order:

```
   ┌─ WOULD DELETE (FK-safe order) ─────────────
   │ KycDocument                       12   [kycSubmission.user.clientId in tenants]
   │ ...
   │ User                              34   [clientId in tenants (direct)]
   └─ total rows: 487
```

Sanity checks before the **real** prod run:

- **`User`, `ChannelPartner`, `Outlet` counts** should match what you expect from
  the seed/UAT dataset for those tenants — not 0 (would mean wrong DB/scope) and
  not surprisingly huge (would mean scope leak).
- **Global tables are absent** from the list entirely (`Client`, `OutletType` are
  never deleted — confirm they're not printed).
- After a real wipe, a **second dry-run must show all 0s.**
- If any count looks wrong, **STOP** — do not pass `WIPE_DRY_RUN=false`.

---

## 7. Rollback

There is **no in-script undo.** The transaction protects against a *partial* wipe
(all-or-nothing), not against wiping the *wrong* data.

If the wrong data was wiped (or the wrong DB hit despite the guards):

1. **Stop the app** / block writes to the affected DB.
2. **Restore from PITR** to the timestamp you noted in §2 / Step C (or restore the
   on-demand backup taken just before the wipe).
3. Verify row counts against the pre-wipe expectation.
4. Resume.

This is why **O-4 (backups + PITR) is a hard precondition** and why the prod wipe
is **owner-supervised**.

---

## 8. Pre-flight checklist

- [ ] O-4: Cloud SQL backups + PITR enabled on the target instance.
- [ ] On-demand backup taken + timestamp noted.
- [ ] Dry-run on staging reviewed; counts sane.
- [ ] Real wipe on staging done; re-dry-run shows 0s.
- [ ] Dry-run on prod reviewed with the owner; counts sane; **only the intended
      tenants** in `WIPE_CLIENT_IDS`.
- [ ] `WIPE_TARGET_DB` matches the prod DB; `WIPE_CONFIRM` token copied verbatim.
- [ ] Owner present for the real prod run.
- [ ] Real Deoleo data file ready to load immediately after.
