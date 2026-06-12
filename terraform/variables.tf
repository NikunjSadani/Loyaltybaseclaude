variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "gifsy-platform"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "asia-south1"
}

variable "db_password" {
  description = "Cloud SQL gifsy_user password (sensitive — pass via TF_VAR_db_password env var)"
  type        = string
  sensitive   = true
}

# ── Cloud SQL ─────────────────────────────────────────────────────────────────
# Start with db-g1-small. Upgrade later via: terraform apply -var="db_tier=db-custom-2-3840"
# An upgrade takes ~10 min with no data loss (Cloud SQL handles it online).

variable "db_tier" {
  description = "Cloud SQL machine tier"
  type        = string
  default     = "db-g1-small"   # 1 shared vCPU, 1.7 GB — fine for launch
  # Upgrade when: connections > 50, CPU > 70%, or query latency climbs
  # Next tier: db-custom-2-3840 (2 vCPU, 3.75 GB) ~$90/month
}

# ── Memorystore (production only — staging skips Redis) ───────────────────────

variable "redis_memory_gb" {
  description = "Memorystore Redis size in GB (production only)"
  type        = number
  default     = 1
}

# ── Cloud Run — production ────────────────────────────────────────────────────

variable "prod_api_image" {
  description = "Production API Docker image. Defaults to a public placeholder until the first GitHub Actions build+push."
  type        = string
  # Placeholder — GitHub Actions will deploy the real image via `gcloud run deploy`.
  # After first real deploy, update this to the actual digest if you want Terraform to pin it.
  default = "us-docker.pkg.dev/cloudrun/container/hello:latest"
}

variable "prod_frontend_image" {
  description = "Production frontend Docker image. Defaults to a public placeholder until the first GitHub Actions build+push."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello:latest"
}

# ── Cloud Run — staging ───────────────────────────────────────────────────────

variable "staging_api_image" {
  description = "Staging API Docker image. Defaults to a public placeholder until the first GitHub Actions build+push."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello:latest"
}

variable "staging_frontend_image" {
  description = "Staging frontend Docker image. Defaults to a public placeholder until the first GitHub Actions build+push."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello:latest"
}
