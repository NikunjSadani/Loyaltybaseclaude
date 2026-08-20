# Infrastructure Architecture — canonical INFRA reference

> **This is the single source of truth for the GCP INFRASTRUCTURE** — the current cloud topology and the
> change log for how it got there. For the **software/system architecture** (C4/arc42 — services, data
> model, auth, multi-tenancy) see [`../spec/04-architecture.md`](../spec/04-architecture.md); its §6
> Deployment is a one-line summary that defers here for infra detail. For the deep as-run runbook of the
> VPC change see [`DIRECT-VPC-EGRESS-MIGRATION.md`](DIRECT-VPC-EGRESS-MIGRATION.md). (No overlap by design:
> 04 owns the app design, this owns the infra, the migration doc owns the VPC how-to.)
>
> **Summary:** three cost-reduction changes landed 2026-07-22 (idle GCP bill was ~₹17.5k/mo ≈ $210):
> **(1)** Redis removed, **(2)** the Serverless VPC Access connector replaced by **Direct VPC egress**,
> **(3)** an Artifact Registry cleanup policy made live. Combined saving ≈ **₹10k/mo (~57%)**, zero prod
> impact. All three DONE + verified. Live state also tracked in memory `[[infra-cost-reduction]]`.

---

## Current infra topology (2026-07-22)

```
Consumers (browser / PWA)
        │
Cloudflare worker  (gifsy-proxy — edge; subdomain → origin, x-forwarded-host carries tenant)
        │
Cloud Run  (asia-south1)
  ├─ gifsy-api            (prod backend, NestJS; min-1)          ─┐
  ├─ gifsy-frontend       (prod thin Next.js; no VPC)             │  Direct VPC egress
  ├─ gifsy-api-staging    (staging backend; min-0 scale-to-zero) ─┤  (network interfaces on
  ├─ gifsy-frontend-staging (staging thin Next.js; no VPC)        │   gifsy-vpc / gifsy-subnet-asia-south1)
  └─ Jobs: gifsy-migrate, gifsy-migrate-staging,                  │
           gifsy-oneoff-prodcheck, gifsy-oneoff-staging,          │
           gifsy-seed-staging (+ historical gifsy-bootstrap,     ─┘
           gifsy-activate-deoleo)
        │  (backend/jobs only — frontends never touch the VPC/DB)
        ▼
Cloud SQL  gifsy-db  — Postgres 15, PRIVATE-IP-ONLY (ipv4Enabled=false, 10.49.0.3:5432)
                       two databases: gifsy_prod + gifsy_staging (same physical instance)
                       reached over the /cloudsql unix socket
           gifsy-db-dev — separate PUBLIC-IP instance for local dev only (Auth Proxy)

Supporting services:
  • GCS               — uploads/docs/images bucket (ADC on Cloud Run, signed URLs)
  • Artifact Registry — gifsy-images repo (Docker images) + durable cleanup policy
  • Secret Manager    — DATABASE_URL, JWT_SECRET, MSG91_* , GCS_BUCKET, GCP_PROJECT_ID, CORS_ORIGINS
  • MSG91             — SMS / WhatsApp / OTP

  ✗ NO Redis / Memorystore anywhere
  ✗ NO Serverless VPC Access connector anywhere
```

**How the backend reaches the DB:** Cloud Run services + jobs attach a **direct network interface** on
`gifsy-vpc` / `gifsy-subnet-asia-south1` (`--vpc-egress=private-ranges-only`) and connect to the
private-IP Cloud SQL over the unchanged `/cloudsql` unix socket. `DATABASE_URL` is unchanged
(`…@localhost/<db>?host=/cloudsql/gifsy-platform:asia-south1:gifsy-db`). The frontends have no VPC
attachment (they proxy `/api/*` → the backend and never touch the DB).

---

## Change 1 — Redis removed

| | |
|---|---|
| **Before** | Two Cloud Memorystore Redis instances provisioned (`gifsy-redis` prod, `gifsy-redis-prod`), a `REDIS_URL` Secret Manager secret, and a `REDIS_URL` env var on the prod backend. **~₹8,500/mo (52% of the bill).** |
| **After** | Both Redis instances **DELETED**. The `REDIS_URL` secret + the prod env var **DELETED**. No Redis / Memorystore anywhere. |
| **Why** | Redis was scaffold left over from the original infra template — it was **never wired into the NestJS backend**. Rate limiting is in-memory (`@nestjs/throttler`); OTP is stored in Postgres; there is **no** `CacheModule` / `ioredis` / `cache-manager` usage anywhere in `api/src`. It was pure idle cost. |
| **Config** | Removed the Redis instances (`gcloud redis instances delete`), the `REDIS_URL` secret, and every `REDIS_URL` reference in `deploy.yml` / `deploy-staging.yml` / `terraform` (owned by the infra-code agent). |
| **Cost saved** | **~₹8,500/mo** — permanent. |
| **Verified** | No code path connects to Redis (grep-confirmed: no `ioredis`/`cache-manager`/`CacheModule` in `api/src`); prod logs showed zero Redis activity; deletion had zero runtime impact (backend + OTP + throttling unaffected). |

> **Residual (tracked, not a blocker):** the in-memory `@nestjs/throttler` is **per-instance**, so
> rate-limit counters do not aggregate across multiple Cloud Run instances. This is a known limitation
> (GO-LIVE-ISSUE-LIST `GLm-5`), **not** a regression from removing Redis — Redis was never backing the
> throttler. If cross-instance limits become necessary, back the throttler with the DB or another shared
> store; that is a *new* build, not a restoration.
>
> **Residual cleanup — ✅ DONE (2026-07-22):** the dead `ioredis` / `@nestjs/cache-manager` /
> `cache-manager` / `@types/ioredis` deps were removed from `api/package.json`, lockfile regenerated,
> full gate green (api jest 1557 · nest 0 · FE vitest 1924 · tsc 0).

---

## Change 2 — VPC connector → Direct VPC egress

| | |
|---|---|
| **Before** | A Serverless VPC Access connector `gifsy-connector` (an always-on VM fleet, ~₹1,445/mo) carried all Cloud Run → private-IP Cloud SQL traffic. Every DB-connected service/job attached `--vpc-connector=gifsy-connector`. |
| **After** | Connector **DELETED**. All DB-connected Cloud Run services (`gifsy-api`, `gifsy-api-staging`) and jobs use **Direct VPC egress** — a direct subnet network interface — to reach the *same* private-IP DB over the *same* `/cloudsql` socket. |
| **Why** | Direct VPC egress is GA and reaches the VPC over the same servicenetworking peering the connector used; it removes the connector VM fleet (fewer moving parts, one less hop, lower latency) while keeping the DB **private-IP-only** — this is **not** a "switch to public IP". |
| **Config (services)** | `--clear-vpc-connector --network=gifsy-vpc --subnet=gifsy-subnet-asia-south1 --vpc-egress=private-ranges-only` (`--set-cloudsql-instances` / the `/cloudsql` volume unchanged; `DATABASE_URL` unchanged). A `/health/ready` **startup probe** gates cold-start DB readiness so a new instance is never served traffic before its DB is reachable. |
| **Config (jobs)** | `gcloud run jobs deploy` does **not** support `--clear-vpc-connector` — the migrate jobs use **`--network/--subnet/--vpc-egress` only**. Each connector-bearing job needed a one-time `gcloud run jobs update <job> --clear-vpc-connector --network=gifsy-vpc --subnet=gifsy-subnet-asia-south1 --vpc-egress=private-ranges-only` before a bare `--network` deploy would succeed. |
| **Terraform** | `template.vpc_access { egress = "PRIVATE_RANGES_ONLY"; network_interfaces { network = …gifsy_vpc; subnetwork = …gifsy_subnet } }`; the `google_vpc_access_connector` resource removed. |
| **Cost saved** | **~₹1,445/mo** — realized at connector deletion. |
| **Verified** | Staging canary first (migrate job + API OTP round-trip over direct egress). Prod: a `--no-traffic` canary revision (`00026-hap`, image `e8de31a`) validated its DB path, then traffic ramped 10→50→100% with `/health/ready` 200 (live `SELECT 1` over direct egress) throughout and zero error logs. All 7 jobs migrated off the connector. Connector then **DELETED**; post-delete prod + staging `/health/ready` returned 200 `{db:up}`, zero errors. See [`DIRECT-VPC-EGRESS-MIGRATION.md`](DIRECT-VPC-EGRESS-MIGRATION.md) for the full phased as-run log. |

---

## Change 3 — Artifact Registry cleanup policy

| | |
|---|---|
| **Before** | The `gifsy-images` repo had only a KEEP-style `keep-last-10` rule that **deleted nothing** → unbounded image growth (~94 GB / ~699 images, all recent build churn). A stray empty `gifsy-repo` repo also existed. |
| **After** | `gifsy-images` has a **durable cleanup policy**: KEEP the image tagged `latest` (current prod) + KEEP the most-recent-30 per package + DELETE untagged > 7 days + DELETE anything > 30 days. The empty `gifsy-repo` repo was deleted. |
| **Why** | Stop unbounded storage growth as staging images age out and build cadence slows — a self-adapting steady-state retention rather than a fixed keep-N that never prunes. |
| **Config** | Cleanup policy on `gifsy-images`: `keep-prod-latest` (anchors the `latest`-tagged prod image) + `keep-recent-30` + `delete-untagged` (older than 7d) + `delete-old` (older than 30d). |
| **Cost saved** | Prevents future unbounded storage cost (the ~353% Artifact Registry growth trend); immediate reclaim modest, self-reduces over time. |
| **Verified** | Independent-audited SAFE, dry-run-verified before enabling; the 4 serving/prod images confirmed intact (untagged count was 0, disproving multi-arch outage risk); policy enabled live. |

---

## Leftover / open infra items (pick-up list)
The three cost-reduction changes above are DONE and stay. **The cost-reduction thread is now CLOSED (owner
2026-08-20): Deoleo is LIVE, so the freeze/downgrade levers in items 0–1 below will NOT be pulled — a live
tenant needs the always-on posture.** Items 0–1 are retained as the analysis-of-record (decided-against, not
deferred); nothing here is open or half-built.

0. **Cloud SQL cost analysis — DECISION: KEEP AS-IS (2026-07-22, reaffirmed 2026-08-20 now that we are LIVE — no downgrade).** After the Redis/connector/LB cuts, the
   **~₹4,500/mo Cloud SQL forecast is the single biggest line** — owner asked whether to reduce it. Reconciled
   (est., no live billing access — SA lacks perms, Billing API disabled): the ₹4,500 is the WHOLE Cloud SQL
   category = **both** instances + storage + backups, NOT `db-g1-small` alone: `gifsy-db` all-in ≈ ₹2,700–2,900
   (g1-small compute ~₹2,400 + 20GB SSD ~₹340 + backups/PITR ~₹300–500), `gifsy-db-dev` ≈ ₹1,000
   (f1-micro ~₹800 + 10GB ~₹170). Already at the structural floor: **Enterprise edition** (not Plus), **ZONAL**
   (not HA), **shared instance** (prod+staging on one), SSD-only, disk can't shrink. Levers considered:
   (i) drop `gifsy-db` to **db-f1-micro** (only tier below g1-small) → saves ~₹1,500–1,800/mo compute, but 0.6GB
   RAM running two DBs is "not for production" → OOM/thrash under load; viable ONLY pre-launch, reversible
   (~1–2 min restart); (ii) stop `gifsy-db-dev` (~₹1,000/mo, zero prod impact if dev idle); (iii) CUD — likely
   **NOT eligible** for shared-core tiers. **OWNER DECISION 2026-07-22: keep everything as-is — no client update
   received yet, so not pausing/downgrading.** **→ Launch did NOT slip; Deoleo is LIVE (2026-08-20) → the downgrade
   is now permanently off the table (a live prod DB is not put on f1-micro / not stopped).**
   Free micro-win still available (independent of the freeze decision): `gifsy-db` `storageAutoResizeLimit=0`
   (uncapped) — could set a 50GB ceiling to avoid a runaway-growth bill; zero downside.
1. **Idle-cost "pause levers" — ❌ DECIDED-AGAINST (owner 2026-08-20). NOT an open item.** These only ever made
   sense for a *pre-launch postponement*; Deoleo is now in production, so none will be pulled — the always-on
   posture (warm instances, running schedulers, live DB) is required. Retained here only as the record of what
   was considered:
   - Prod Cloud Run `min-instances 1→0` + pausing the prod schedulers (`push-drain-prod`, `expire-sweep-prod`)
     → **rejected** (cold-start latency for live users; the crons must keep running push-drain/expire-sweep/reports).
   - Stop `gifsy-db-dev` (~₹1,000/mo) → **rejected** (dev continuing).
   - Stop/downsize `gifsy-db` (prod+staging shared) → **rejected** (prod DB must stay up).
   - Detail: memory `[[infra-cost-reduction]]`.
2. **✅ Cutover #12 + #13 DONE (2026-07-22)** — the KYC address-proof waiver (semantics-corrected) + the
   per-outlet payout mandate are LIVE in prod (`2187498`), incl. the prod `kycAddressProofWaiver` flag. Both
   migrations applied; the Direct-VPC-egress deploy.yml carried prod cleanly. (Was the pending item here.)
3. **Minor posture note (optional, low priority):** `gifsy-db-dev` is a PUBLIC-IP instance (dev-only, lower
   stakes) while prod/staging are private-IP. Tightening dev to private-IP would add connector/proxy
   complexity for local dev — not worth it unless a policy requires it. Left as-is intentionally.
4. **Cosmetic (no action):** ~354 old Cloud Run revisions still tag the deleted connector — zero running
   instances, zero cost, un-startable; Cloud Run auto-prunes them. Not a doc/code reference.

## Cross-references
- **[`DIRECT-VPC-EGRESS-MIGRATION.md`](DIRECT-VPC-EGRESS-MIGRATION.md)** — full phased plan + as-run findings for change 2 (the flag gotchas per command type, the `/cloudsql`-socket-over-direct-egress proof, the startup-probe R2 fix, rollback).
- **`terraform/README.md`** — cost table + provisioning notes (already reflects Redis removal + Direct VPC egress).
- **`RESUME.md`** (OPEN THREADS → infra cost-reduction) and memory **`[[infra-cost-reduction]]`** — live state + remaining owner-gated cost levers.
- **`MIGRATIONS.md`**, **`runbooks/CUTOVER-RUNBOOK.md`**, **`runbooks/PROD-DATA-LOAD.md`** — the migrate/bootstrap job command templates (now Direct VPC egress).
