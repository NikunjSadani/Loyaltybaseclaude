# ─────────────────────────────────────────────────────────────────────────────
# gifsy.tfvars — single apply for all infrastructure
#
# Run: terraform apply -var-file=environments/gifsy.tfvars -var="db_password=XXX"
# Or:  TF_VAR_db_password=XXX terraform apply -var-file=environments/gifsy.tfvars
# ─────────────────────────────────────────────────────────────────────────────

project_id = "gifsy-platform"
region     = "asia-south1"

# Cloud SQL — start small, upgrade via terraform apply when needed
# db_tier = "db-g1-small"   ← default, ~$12/month
# db_tier = "db-custom-2-3840"  ← upgrade when traffic grows, ~$90/month

# Redis — 1GB is plenty for launch
redis_memory_gb = 1

# Images — GitHub Actions updates these on each deploy.
# For the very first apply (before any deploy has run), the images below
# need to exist in Artifact Registry. Run the first CI/CD push before applying
# cloud-run.tf, or set these to a public placeholder image temporarily.
prod_api_image      = "asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/api:latest"
prod_frontend_image = "asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/frontend:latest"
staging_api_image      = "asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/api:staging"
staging_frontend_image = "asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/frontend:staging"
