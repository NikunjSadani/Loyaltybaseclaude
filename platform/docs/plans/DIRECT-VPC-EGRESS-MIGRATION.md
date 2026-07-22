# Project Plan — Migrate Cloud Run: VPC Connector → Direct VPC egress

**Goal:** eliminate the always-on Serverless VPC Access connector (`gifsy-connector`, ~₹1,445/mo)
by moving all Cloud Run DB-connected workloads to **Direct VPC egress**, **without changing the
private-IP database security posture and with zero production DB disruption.**

**Feasibility verdict: ✅ DOABLE, low risk** via a staging-first canary. One item is resolved
empirically in staging (see the DB-connection decision, §Risks R1). Savings (~₹1,445/mo) are realized
only at the final step (connector deletion).

> Owner-gated: the prod cutover and the connector deletion touch production's path to its database.
> Nothing here executes without explicit go. Audit basis: 2 research streams (Google-docs-cited) + a
> live GCP infra audit, 2026-07-22.

---

## 0. Why this is safe in principle
- **Security posture unchanged.** The DB stays **private-IP-only** (`gifsy-db`, `ipv4Enabled=false`,
  `10.49.0.3`). Direct VPC egress reaches it over the **same VPC + servicenetworking peering** the
  connector uses today — it only swaps *how* Cloud Run enters the VPC (a direct subnet interface vs a
  connector VM fleet). This is **not** the "switch to public IP" trade.
- **Both are GA and per-service.** Direct VPC egress is GA in all Cloud Run regions incl. asia-south1.
  Egress method is chosen per-service, so a phased cutover (staging first, then prod) is supported;
  connector-based and direct-egress services coexist on the same VPC/subnet/DB with no conflict.
- **Reversible until the last step.** Every cutover is a new revision; rollback = shift traffic back to
  the connector-based revision (or redeploy with `--vpc-connector`). The **only** irreversible action is
  deleting the connector — deliberately the final, decoupled step.

## 0.1 Confirmed current state (live audit)
| Fact | Value |
|---|---|
| DB | `gifsy-db` private-IP-only, `10.49.0.3:5432`, `sslMode=ENCRYPTED_ONLY`, peered range `10.49.0.0/16` |
| Subnet for egress | `gifsy-subnet-asia-south1` = `10.0.0.0/20`, PRIVATE, `privateIpGoogleAccess=true` |
| Network | `gifsy-vpc` (auto-mode) |
| Firewall | **No custom rules on `gifsy-vpc`; no egress-DENY rules anywhere** → implied-allow-egress carries DB traffic |
| DB connection | `/cloudsql` **unix socket** (`DATABASE_URL=…@localhost/db?host=/cloudsql/…`) via `--set-cloudsql-instances` + `/cloudsql` volume |
| Connector consumers | **2 services** (`gifsy-api`, `gifsy-api-staging`) + **7 jobs** (`gifsy-migrate`, `gifsy-migrate-staging`, `gifsy-bootstrap`, `gifsy-activate-deoleo`, `gifsy-oneoff-prodcheck`, `gifsy-oneoff-staging`, `gifsy-seed-staging`) |
| Frontends | **No VPC** (`gifsy-frontend`, `gifsy-frontend-staging`) — untouched |
| terraform | services have `ignore_changes=[template]` → **the gcloud deploys in the workflows are load-bearing; terraform edits are drift-documentation only.** The 7 jobs aren't in terraform. |
| IP headroom | /20 = 4,096 IPs; direct egress uses ~2×/instance steady (~4× peak). Ceiling ~1,000 instances vs current cap 40 → non-issue. |

---

## ⭐ AS-RUN FINDINGS (Phase 1 executed on staging 2026-07-22 — apply to prod)
1. **R1 RESOLVED — the `/cloudsql` socket works over Direct VPC egress.** Runtime-proven on
   staging: the migrate job (`prisma migrate deploy`) reached the private-IP DB and succeeded
   (13.97s), and the API service did a full OTP login round-trip (send-otp WRITE + verify-otp READ →
   valid CLIENT_ADMIN token). **No `DATABASE_URL` change, no SSL rework** — the happy path holds.
2. **CRITICAL flag gotcha (differs by command type):**
   - `gcloud run deploy` / `gcloud run services update` (the **API services**) **DO** support
     `--clear-vpc-connector` → keep it: `--clear-vpc-connector --network=… --subnet=… --vpc-egress=private-ranges-only`.
   - `gcloud run jobs deploy` (the **migrate jobs**) does **NOT** support `--clear-vpc-connector`
     (only `--vpc-connector`/`--network`/`--subnet`). Its command uses **`--network/--subnet/--vpc-egress` only (NO `--clear`)**.
   - A resource that **already has a connector** rejects a bare `--network` swap
     (`"VPC connector and direct VPC can not be used together"`). So each **connector-bearing job**
     needs a **one-time** `gcloud run jobs update <job> --clear-vpc-connector --network=gifsy-vpc --subnet=gifsy-subnet-asia-south1 --vpc-egress=private-ranges-only`
     BEFORE the workflow's `jobs deploy --network …` will succeed. (Services auto-clear via `--clear-vpc-connector`, so no separate step for them.)
   - **Prod (deploy.yml) must therefore:** API deploy → keep `--clear-vpc-connector`; migrate-job deploy → `--network/--subnet` only; AND run the one-time `jobs update --clear-vpc-connector` on `gifsy-migrate` (+ the 5 ad-hoc prod/shared jobs) before/at cutover.

## The exact change-set (the swap, everywhere)
Everywhere a workload attaches the connector, replace `--vpc-connector=gifsy-connector` with
`--network=gifsy-vpc --subnet=gifsy-subnet-asia-south1 --vpc-egress=private-ranges-only`
(keeping `--set-cloudsql-instances` / the `/cloudsql` volume unchanged) — **plus `--clear-vpc-connector`
ONLY on the `run deploy`/services commands, NOT on `jobs deploy` (see AS-RUN FINDINGS #2).**
Terraform equivalent inside `template.vpc_access`:
```hcl
vpc_access {
  egress = "PRIVATE_RANGES_ONLY"
  network_interfaces {
    network    = google_compute_network.gifsy_vpc.name
    subnetwork = google_compute_subnetwork.gifsy_subnet.name
  }
}
```
Files: `.github/workflows/deploy.yml` (migrate job L128 + api deploy L148), `.github/workflows/deploy-staging.yml`
(migrate job L104 + api deploy L124), `terraform/cloud-run.tf` (prod-api `vpc_access` + `depends_on`;
staging-api block absent = optional add), `terraform/vpc.tf` (connector resource — delete LAST).

---

## Phases (with what can run in parallel)

### Phase 0 — Pre-flight ✅ DONE (this audit)
GA/region, firewall, consumer inventory, DB-connection method, IP headroom — all confirmed above.

### Phase 1 — STAGING cutover = the canary  *(the critical de-risking phase)*
Staging shares the same VPC / subnet / DB, so it proves the whole thing before prod is touched.
1. Edit `deploy-staging.yml`: swap the connector flags on the `gifsy-api-staging` deploy **and** the
   `gifsy-migrate-staging` job (the change-set above). *(Parallelizable with the doc + terraform edits.)*
2. Push → staging auto-deploys.
3. **Validate DB connectivity end-to-end** (runtime, not just boot):
   - staging API `/health` 200; a real OTP login; a DB-backed read (e.g. `/api/sales/me`) and a write.
   - the `gifsy-migrate-staging` job runs `prisma migrate deploy` successfully.
   - **cold-start check** — scale staging to zero, hit it cold, confirm the first DB query succeeds
     (watch for the direct-egress "connection delay of a minute+ on startup" gotcha, §Risks R2).
   - `gcloud run services describe gifsy-api-staging` shows `Network/Subnet/Egress`, not `Connector`.
4. **DB-connection decision point (R1):** if the `/cloudsql` socket works over direct egress → keep it
   (no DATABASE_URL change — preferred). If it does **not** → switch staging `DATABASE_URL` to direct
   TCP `…@10.49.0.3:5432/gifsy_staging?sslmode=require`, drop `--set-cloudsql-instances` + the `/cloudsql`
   volume, re-validate. Whatever staging proves is what prod uses.
5. **Soak 2–3 days** on staging (catch cold-start / intermittent issues).

### Phase 2 — Migrate the standing jobs  *(parallel with Phase 1 soak)*
The 5 ad-hoc jobs pin the connector; they must not be orphaned when it's deleted.
- Re-deploy each still-used job (`gifsy-oneoff-prodcheck`, `gifsy-oneoff-staging`, `gifsy-seed-staging`,
  `gifsy-migrate*`) with the new flags, **or** retire the obsolete one-time jobs (`gifsy-bootstrap`,
  `gifsy-activate-deoleo` — historical). Update the runbook command templates
  (`CUTOVER-RUNBOOK.md`, `PROD-DATA-LOAD.md`, `MIGRATIONS.md`) so future ad-hoc jobs use direct egress.

### Phase 3 — PROD cutover  *(owner-gated; low-traffic window)*
1. Edit `deploy.yml`: swap the connector flags on the `gifsy-api` deploy + the `gifsy-migrate` job.
2. *(Extra safety)* optionally deploy a `--no-traffic` canary revision on `gifsy-api` first, validate its
   DB path, then ramp traffic 10→50→100 via `update-traffic`.
3. Push/cutover → validate prod exactly as Phase 1.3 (real login, `/health`, a DB-backed endpoint, the
   migrate job). Keep the connector **alive** throughout.
4. Rollback if anything fails: `update-traffic` back to the prior (connector) revision — instant.

### Phase 4 — Decommission + cleanup  *(after prod soaks clean)*
1. Delete the connector: `gcloud compute networks vpc-access connectors delete gifsy-connector --region asia-south1`. **← the savings step, and the only irreversible one.**
2. Terraform (drift-doc, `terraform validate`): replace the prod-api `vpc_access` block, remove the
   connector `depends_on` + the `google_vpc_access_connector` resource, update comments + the cost line
   in `outputs.tf`, optionally drop `vpcaccess.googleapis.com` from `main.tf`.
3. Sweep docs + memory (RESUME, `infra-cost-reduction`, runbooks) → connector RETIRED.
4. Confirm the ~₹1,445/mo drop on the next bill.

**Parallelization summary:** the 4 file-edit workstreams (deploy.yml · deploy-staging.yml · terraform ·
docs) are independent and authored simultaneously (sub-agents write, I integrate + gate). Phase 2 runs
during the Phase 1 soak. The only hard sequential gates are **staging-validated → prod cutover →
soak → connector deletion** (each proves the next is safe).

---

## Risks & mitigations
| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| **R1** | `/cloudsql` socket may not ride Direct VPC egress for a private-IP-only instance (docs don't explicitly confirm) | Med | **Resolved in the staging canary.** Fallback fully scoped: direct TCP `10.49.0.3:5432?sslmode=require` + drop the socket. No prod exposure — staging decides. |
| **R2** | Direct egress can add "connection delay of a minute+ on instance startup" (cold start) | Low–Med | prod `min-instances=1` rarely cold-starts; add an HTTP **startup probe** hitting the DB before serving; staging soak surfaces it. |
| **R3** | Subnet→Cloud SQL reachability not proven by an explicit firewall rule | Low | Audit found **no connector-range-scoped rules** + implied-allow-egress → expected to just work; **proven empirically on staging** before prod. Fallback: add `allow 10.0.0.0/20 → 10.49.0.0/16 tcp:5432`. |
| **R4** | 5 standing jobs pin the connector → break on deletion | Med | Phase 2 re-deploys/retires them **before** Phase 4. |
| **R5** | terraform `ignore_changes=[template]` means terraform edits don't migrate live services (workflow edits do) | — | Documented; workflow edits are the load-bearing ones; terraform kept honest for drift. |
| **R6** | Connector still bills during the phased window | Certain (minor) | Expected — savings realized only at Phase 4 deletion; the phase is short. |

## Rollback
Per-phase, non-destructive: shift traffic to the previous connector-based revision, or redeploy with
`--clear-network --vpc-connector=gifsy-connector --vpc-egress=private-ranges-only`. The connector stays
provisioned until Phase 4, so rollback is always available until we deliberately delete it.

## Effort & savings
- Active work ≈ **half a day** total (Phase 1 ~1–2h, Phase 2 ~1h, Phase 3 ~1h, Phase 4 ~1h), spread over
  **~1 week** of calendar time (the staging soak).
- Savings: **~₹1,445/mo (~$17)**, realized at Phase 4.
- Also gains: lower DB-path latency (one fewer hop), fewer moving parts, no connector to scale/maintain.

## Decision needed to start
Go for **Phase 1 (staging)** — it's non-prod, fully reversible, and is what proves the R1/R2/R3 questions.
Prod (Phase 3) and the connector deletion (Phase 4) are separately owner-gated after staging soaks clean.
