# ─────────────────────────────────────────────────────────────────────────────
# Secret Manager — declare all secrets.
# Values are populated by: bash api/scripts/push-secrets.sh
# DATABASE_URL and REDIS_URL are auto-populated by Terraform (cloud-sql.tf,
# gcs-memorystore.tf) — do NOT run push-secrets.sh for those two.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  # Secrets that exist in both production and staging variants
  dual_secrets = [
    "JWT_SECRET",
    "CORS_ORIGINS",
  ]

  # Secrets shared across environments (same value)
  shared_secrets = [
    "MSG91_AUTH_KEY",
    "MSG91_SENDER_ID",
    "MSG91_OTP_TEMPLATE_ID",
    "MSG91_SMS_TEMPLATE_ID",
    "GCS_BUCKET",
    "GCP_PROJECT_ID",
  ]
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "database_url_staging" {
  secret_id = "DATABASE_URL_STAGING"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "redis_url" {
  secret_id = "REDIS_URL"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "JWT_SECRET"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret_staging" {
  secret_id = "JWT_SECRET_STAGING"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins" {
  secret_id = "CORS_ORIGINS"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins_staging" {
  secret_id = "CORS_ORIGINS_STAGING"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_auth_key" {
  secret_id = "MSG91_AUTH_KEY"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sender_id" {
  secret_id = "MSG91_SENDER_ID"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_otp_template_id" {
  secret_id = "MSG91_OTP_TEMPLATE_ID"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sms_template_id" {
  secret_id = "MSG91_SMS_TEMPLATE_ID"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcs_bucket" {
  secret_id = "GCS_BUCKET"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcp_project_id" {
  secret_id = "GCP_PROJECT_ID"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}
