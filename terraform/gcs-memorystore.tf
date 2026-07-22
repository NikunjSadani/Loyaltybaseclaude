# ─────────────────────────────────────────────────────────────────────────────
# GCS — upload bucket (shared between prod and staging via folder prefix)
# ─────────────────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "uploads" {
  name          = "gifsy-platform-files"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  cors {
    # Explicit domains required — wildcard certs/origins are not used after LB removal.
    # Add new client subdomain here when onboarding: "https://<slug>.gifsy.in"
    origin = [
      "https://platform.gifsy.in",
      "https://api.gifsy.in",
      "https://deoleo.gifsy.in",
      "https://clientb.gifsy.in",
    ]
    method          = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    response_header = ["Content-Type", "x-goog-resumable"]
    max_age_seconds = 3600
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
    condition {
      age = 90
    }
  }

  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age            = 730
      matches_prefix = ["tmp/"]
    }
  }

  depends_on = [google_project_service.apis]
}

# Terraform state bucket (must exist BEFORE terraform init — see README)
resource "google_storage_bucket" "terraform_state" {
  name          = "gifsy-terraform-state"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  versioning { enabled = true }

  depends_on = [google_project_service.apis]
}

# ─────────────────────────────────────────────────────────────────────────────
# Memorystore Redis — REMOVED 2026-07-21.
#
# Both instances (gifsy-redis, gifsy-redis-prod) were provisioned by the original
# platform scaffold but NEVER wired into the NestJS backend (throttling is
# in-memory; no CacheModule/ioredis/REDIS_URL usage in api/src). Deleted via
# `gcloud redis instances delete` — ~₹8,500/mo saved, zero runtime impact.
# If a real global-rate-limit / shared-cache need ever appears, re-provision AND
# actually wire it (see api app.module.ts ThrottlerModule).
#
# The `REDIS_URL` Secret Manager secret has also been deleted (2026-07-22); its
# declaration was removed from secret-manager.tf.
# ─────────────────────────────────────────────────────────────────────────────
