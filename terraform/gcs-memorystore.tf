# ─────────────────────────────────────────────────────────────────────────────
# GCS — upload bucket (shared between prod and staging via folder prefix)
# ─────────────────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "uploads" {
  name          = "gifsy-platform-files"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  cors {
    # MATCHES the live bucket (verified 2026-08-04 via `gcloud storage buckets
    # describe`). Media is served through the API (StreamableFile proxy), not
    # browser→bucket, so this CORS is effectively vestigial today. An earlier
    # explicit-origins list was authored here but NEVER applied (live stayed
    # wildcard + working). If you ever want explicit origins, apply it deliberately
    # AND include the real tenant host(s) (e.g. deoleoloyalty.gifsy.in), not just
    # <slug>.gifsy.in.
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

  # Visibility (POSM) photo retention (owner-decided 2026-07-27): visibility-media/ prefix ONLY.
  # Standard until ARCHIVE at 120d (note: the whole-bucket NEARLINE@90d rule above also applies,
  # so these objects sit Standard→NEARLINE@90d→ARCHIVE@120d — cheaper, still instant-access), then
  # deleted at 7y. Archive's 365d min-duration is satisfied (120d→2555d). See VISIBILITY-POSM-DESIGN.md.
  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
    condition {
      age            = 120
      matches_prefix = ["visibility-media/"]
    }
  }

  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age            = 2555
      matches_prefix = ["visibility-media/"]
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
