# ─────────────────────────────────────────────────────────────────────────────
# GCS — upload bucket (shared between prod and staging via folder prefix)
# ─────────────────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "uploads" {
  name          = "gifsy-platform-files"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  cors {
    origin          = ["https://*.gifsy.in"]
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
# Memorystore Redis — PRODUCTION ONLY
#
# Staging skips Redis entirely (OTP/session falls back to DB).
# This saves ~$30/month on staging.
# Redis is used in production for: OTP cache, session store, leaderboard cache.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_redis_instance" "gifsy_redis_prod" {
  name           = "gifsy-redis-prod"
  tier           = "BASIC"        # upgrade to STANDARD_HA when uptime SLA is needed
  memory_size_gb = var.redis_memory_gb
  region         = var.region

  redis_version      = "REDIS_7_0"
  authorized_network = google_compute_network.gifsy_vpc.id
  auth_enabled       = true

  display_name = "Gifsy Redis — Production"

  depends_on = [
    google_project_service.apis,
    google_compute_network.gifsy_vpc,
  ]
}

resource "google_secret_manager_secret_version" "redis_url" {
  secret      = google_secret_manager_secret.redis_url.id
  secret_data = "redis://:${google_redis_instance.gifsy_redis_prod.auth_string}@${google_redis_instance.gifsy_redis_prod.host}:${google_redis_instance.gifsy_redis_prod.port}"
}
