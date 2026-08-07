# ─────────────────────────────────────────────────────────────────────────────
# Secret Manager — declare all secrets.
# Values are populated by: bash api/scripts/push-secrets.sh
# DATABASE_URL is auto-populated by Terraform (cloud-sql.tf) — do NOT run
# push-secrets.sh for it.
#
# Replication: automatic (Google-managed) — MATCHES the live secrets + Terraform
# state (verified 2026-08-04 via `terraform plan` refresh: state + live = auto {}).
# ⚠️ Replication is IMMUTABLE — do NOT change `auto {}` to user_managed: that forces
# a destroy+recreate of every secret (version loss → prod outage for DATABASE_URL/
# JWT_SECRET). push-secrets.sh passes --replication-policy=user-managed, but that
# applies only on CREATE and these were created by Terraform as auto, so its flag
# is inert (the create fails "already exists" → falls to `versions add`).
# ─────────────────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "database_url_staging" {
  secret_id = "DATABASE_URL_STAGING"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "JWT_SECRET"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret_staging" {
  secret_id = "JWT_SECRET_STAGING"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins" {
  secret_id = "CORS_ORIGINS"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins_staging" {
  secret_id = "CORS_ORIGINS_STAGING"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_auth_key" {
  secret_id = "MSG91_AUTH_KEY"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sender_id" {
  secret_id = "MSG91_SENDER_ID"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_otp_template_id" {
  secret_id = "MSG91_OTP_TEMPLATE_ID"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sms_template_id" {
  secret_id = "MSG91_SMS_TEMPLATE_ID"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcs_bucket" {
  secret_id = "GCS_BUCKET"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcp_project_id" {
  secret_id = "GCP_PROJECT_ID"
  replication {
    # Automatic (Google-managed) replication — this MATCHES the live secrets
    # (confirmed by `terraform plan` refresh: state + live = auto {}). Replication
    # is IMMUTABLE, so do NOT change this to user_managed — that would force a
    # destroy+recreate of every secret (version loss → prod outage). push-secrets.sh
    # passes --replication-policy=user-managed, but that only applies on CREATE and
    # these were created by Terraform as auto, so its flag never took effect.
    auto {}
  }
  depends_on = [google_project_service.apis]
}
