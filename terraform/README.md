# Gifsy Infrastructure — Deployment Guide

## Architecture

```
Internet
   │
   ▼
Cloud Load Balancer (static IP: see terraform output lb_ip_address)
   │  *.gifsy.in  →  gifsy-frontend (Cloud Run, port 3000)
   │  api.gifsy.in → gifsy-api     (Cloud Run, port 4000)
   │
   ├── gifsy-api     ──[VPC connector]──► Cloud SQL (gifsy_prod / gifsy_staging)
   │                                  ──► Memorystore Redis
   │                                  ──► GCS bucket (gifsy-platform-files)
   │
   └── gifsy-frontend ─────────────────► (stateless; calls gifsy-api)
```

**Staging** = `develop` branch → auto-deploy to `gifsy-api-staging` + `gifsy-frontend-staging`  
**Production** = `main` branch → requires manual approval → deploy to `gifsy-api` + `gifsy-frontend`

---

## One-Time Setup (do this once, in order)

### Step 0 — Prerequisites

```bash
# Install Terraform
brew install terraform        # macOS
# or: https://developer.hashicorp.com/terraform/install

# Authenticate gcloud
gcloud auth login
gcloud auth application-default login
gcloud config set project gifsy-platform
```

### Step 1 — Create Terraform state bucket (chicken-and-egg — must exist before terraform init)

```bash
gsutil mb -p gifsy-platform -c STANDARD -l asia-south1 gs://gifsy-terraform-state
gsutil versioning set on gs://gifsy-terraform-state
```

### Step 2 — Initialise Terraform

```bash
cd terraform
terraform init
```

### Step 3 — Provision all infrastructure (single apply)

```bash
terraform apply \
  -var-file=environments/gifsy.tfvars \
  -var="db_password=YOUR_STRONG_PASSWORD_HERE"
```

> One apply creates everything: VPC, Cloud SQL (shared), Redis (prod only),
> GCS, Artifact Registry, Cloud Run × 4 services, Load Balancer, IAM, Secret Manager.
> Note the outputs — you'll need `lb_ip_address` and `deployer_sa_email`.
>
> **First apply note**: Cloud Run services need a Docker image to exist.
> If Artifact Registry is empty, the Cloud Run resources will fail.
> Solution: apply with `-target` to create everything except Cloud Run first,
> push images via a manual Docker build, then apply the rest:
>
> ```bash
> # First pass — everything except Cloud Run services
> terraform apply -var-file=environments/gifsy.tfvars -var="db_password=XXX" \
>   -target=google_project_service.apis \
>   -target=google_artifact_registry_repository.gifsy_images \
>   -target=google_compute_network.gifsy_vpc \
>   -target=google_sql_database_instance.gifsy_db \
>   -target=google_service_account.deployer
>
> # Push first images manually (or trigger GitHub Actions once)
> gcloud auth configure-docker asia-south1-docker.pkg.dev
> docker build -t asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/api:latest ./api && docker push ...
> docker build -t asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/frontend:latest ./platform && docker push ...
>
> # Second pass — everything including Cloud Run
> terraform apply -var-file=environments/gifsy.tfvars -var="db_password=XXX"
> ```

### Step 4 — Push secrets to Secret Manager

```bash
# Production
bash api/scripts/push-secrets.sh production

# Staging
bash api/scripts/push-secrets.sh staging
```

> DATABASE_URL and REDIS_URL are already set by Terraform. The script handles:
> JWT_SECRET, MSG91_*, CORS_ORIGINS, GCS_BUCKET, GCP_PROJECT_ID.

**⚠️ CORS_ORIGINS values to enter:**
- Production: `https://platform.gifsy.in,https://deoleo.gifsy.in,https://YOURCLIENT.gifsy.in`
- Staging: `https://staging.platform.gifsy.in`

### Step 5 — Run database migrations

```bash
# Install Cloud SQL Auth Proxy
curl -L https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.8.1/cloud-sql-proxy.linux.amd64 -o cloud-sql-proxy
chmod +x cloud-sql-proxy

# Start proxy in background
./cloud-sql-proxy gifsy-platform:asia-south1:gifsy-db &

# Run migrations (production)
cd api
DATABASE_URL="postgresql://gifsy_user:YOUR_PASSWORD@127.0.0.1:5432/gifsy_prod" \
  npx prisma migrate deploy

# Run migrations (staging)
DATABASE_URL="postgresql://gifsy_user:YOUR_PASSWORD@127.0.0.1:5432/gifsy_staging" \
  npx prisma migrate deploy

kill %1  # stop the proxy
```

### Step 6 — Set GitHub Actions secrets

In GitHub → Repository Settings → Secrets and variables → Actions → New repository secret:

| Secret name | Value |
|---|---|
| `GCP_SA_KEY` | Full JSON content of the deployer service account key (see below) |
| `NEXT_PUBLIC_API_URL` | `https://api.gifsy.in` |
| `NEXT_PUBLIC_API_URL_STAGING` | `https://api.staging.gifsy.in` |

**Create the deployer SA key:**
```bash
gcloud iam service-accounts keys create deployer-key.json \
  --iam-account=$(terraform output -raw deployer_sa_email) \
  --project=gifsy-platform

# Copy the contents of deployer-key.json into the GCP_SA_KEY GitHub secret
cat deployer-key.json

# Delete the local file immediately after
rm deployer-key.json
```

### Step 7 — Set up GitHub Environment protection rule

1. GitHub → Repository → Settings → Environments → New environment
2. Name: `production`
3. Required reviewers: add yourself (and any other approvers)
4. This makes every `main` push pause for approval before deploying to production.

### Step 8 — Configure DNS

After `terraform apply`, run:
```bash
terraform output dns_instructions
```

Add the two A records at your domain registrar:
- `gifsy.in` → `<lb_ip_address>`
- `*.gifsy.in` → `<lb_ip_address>`

Wait ~15 minutes for DNS propagation. Google then auto-provisions the managed SSL certificate.

Check cert status:
```bash
gcloud compute ssl-certificates describe gifsy-ssl-cert --global
```

### Step 9 — First deployment

```bash
# Push to develop → triggers staging deploy
git checkout develop && git push origin develop

# After verifying staging works, merge to main
# GitHub Actions will pause for your approval before deploying to production
git checkout main && git merge develop && git push origin main
```

---

## Day-to-Day Operations

### Deploy to staging
```bash
git checkout develop
# make changes, commit, push
git push origin develop
# GitHub Actions automatically deploys to staging
```

### Deploy to production
```bash
git checkout main
git merge develop
git push origin main
# GitHub Actions runs tests → waits for your approval → deploys
```

### Run database migrations in production
```bash
./cloud-sql-proxy gifsy-platform:asia-south1:gifsy-db &
DATABASE_URL="postgresql://gifsy_user:PASS@127.0.0.1:5432/gifsy_prod" \
  npx prisma migrate deploy --schema=api/prisma/schema.prisma
kill %1
```

### Add a new tenant (client subdomain)
1. Add the client config in `platform/src/lib/platform/client-registry.ts`
2. DNS: `newclient.gifsy.in` is already covered by the `*.gifsy.in` wildcard A record
3. The Load Balancer wildcard rule routes it to `gifsy-frontend` automatically
4. No infrastructure changes needed for new tenants ✅

### Update a GCP secret value
```bash
echo -n "new-value" | gcloud secrets versions add SECRET_NAME \
  --data-file=- --project=gifsy-platform
# Cloud Run picks it up on next request (secrets are read at startup)
# Force a new revision: gcloud run services update gifsy-api --region=asia-south1 --no-traffic
```

---

## Cost Estimate (asia-south1)

One `terraform apply` creates all infrastructure. Staging is lean by design:
no Redis, no Load Balancer, scale-to-zero Cloud Run.

| Service | Notes | $/month |
|---|---|---|
| Cloud SQL db-g1-small (shared) | One instance, two databases | ~$12 |
| Memorystore Redis 1GB (prod only) | Staging has no Redis | ~$30 |
| Cloud Run prod (2 services, min-1) | API + frontend always warm | ~$20 |
| Cloud Run staging (2 services, min-0) | Scale-to-zero, ~$0 when idle | ~$1 |
| Load Balancer + CDN (prod only) | Staging uses .run.app URLs | ~$25 |
| VPC connector (prod only) | Required for Cloud Run → Redis | ~$12 |
| GCS + Artifact Registry | Uploads bucket + Docker images | ~$2 |
| **Total** | | **~$102/month (~₹8,500)** |

**Upgrade Cloud SQL when traffic grows:**
```bash
terraform apply -var="db_tier=db-custom-2-3840"   # +$80/month, online upgrade
```

Staging never costs more than ~$2–3/month because it has no Redis, no LB,
no VPC connector, and Cloud Run scales to zero between test runs.

---

## Troubleshooting

**Cloud Run can't connect to Cloud SQL:**
```bash
gcloud run services describe gifsy-api --region=asia-south1
# Check: cloudsql-instances annotation, VPC connector
```

**Secrets not loading:**
```bash
gcloud secrets list --project=gifsy-platform
gcloud secrets versions access latest --secret=DATABASE_URL
```

**SSL cert not provisioning:**
- DNS must be pointing to lb_ip BEFORE cert can provision
- Run: `gcloud compute ssl-certificates describe gifsy-ssl-cert --global`
- Status should change from PROVISIONING → ACTIVE within ~60 minutes of DNS propagation
