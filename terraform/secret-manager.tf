# ─────────────────────────────────────────────────────────────────────────────
# Secret Manager — declare all secrets.
# Values are populated by: bash api/scripts/push-secrets.sh
# DATABASE_URL is auto-populated by Terraform (cloud-sql.tf) — do NOT run
# push-secrets.sh for it.
#
# Replication: automatic (Google-managed, globally replicated).
# User-managed replication with a single region would be less redundant.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "database_url_staging" {
  secret_id = "DATABASE_URL_STAGING"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# REDIS_URL — RETAINED (not stripped) on purpose. Redis itself is deleted, but the
# running prod revision (e8de31a) still reads this secret at instance startup, so the
# live secret must survive until the next cutover redeploys prod without it (the
# deploy.yml + cloud-run.tf references are already removed). Keeping this container
# resource guarantees `terraform apply` will NOT delete the live secret before then.
# Delete this block AND the live secret only AFTER the post-cutover redeploy.
resource "google_secret_manager_secret" "redis_url" {
  secret_id = "REDIS_URL"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "JWT_SECRET"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret_staging" {
  secret_id = "JWT_SECRET_STAGING"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins" {
  secret_id = "CORS_ORIGINS"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins_staging" {
  secret_id = "CORS_ORIGINS_STAGING"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_auth_key" {
  secret_id = "MSG91_AUTH_KEY"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sender_id" {
  secret_id = "MSG91_SENDER_ID"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_otp_template_id" {
  secret_id = "MSG91_OTP_TEMPLATE_ID"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sms_template_id" {
  secret_id = "MSG91_SMS_TEMPLATE_ID"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcs_bucket" {
  secret_id = "GCS_BUCKET"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcp_project_id" {
  secret_id = "GCP_PROJECT_ID"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
