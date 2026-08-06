# ─────────────────────────────────────────────────────────────────────────────
# Secret Manager — declare all secrets.
# Values are populated by: bash api/scripts/push-secrets.sh
# DATABASE_URL is auto-populated by Terraform (cloud-sql.tf) — do NOT run
# push-secrets.sh for it.
#
# Replication: user-managed, single region (asia-south1) — MATCHES the live
# secrets created by push-secrets.sh (--replication-policy=user-managed). Do NOT
# switch to `auto {}`: replication is immutable, so the change would force a
# destroy+recreate of every secret (version loss → prod outage).
# ─────────────────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "database_url_staging" {
  secret_id = "DATABASE_URL_STAGING"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "JWT_SECRET"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "jwt_secret_staging" {
  secret_id = "JWT_SECRET_STAGING"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins" {
  secret_id = "CORS_ORIGINS"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "cors_origins_staging" {
  secret_id = "CORS_ORIGINS_STAGING"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_auth_key" {
  secret_id = "MSG91_AUTH_KEY"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sender_id" {
  secret_id = "MSG91_SENDER_ID"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_otp_template_id" {
  secret_id = "MSG91_OTP_TEMPLATE_ID"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "msg91_sms_template_id" {
  secret_id = "MSG91_SMS_TEMPLATE_ID"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcs_bucket" {
  secret_id = "GCS_BUCKET"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gcp_project_id" {
  secret_id = "GCP_PROJECT_ID"
  replication {
    # Reality: these secrets were created user-managed / single-region
    # (api/scripts/push-secrets.sh uses --replication-policy=user-managed
    # --locations=asia-south1). Replication is IMMUTABLE in GCP, so declaring
    # `auto {}` here would make `terraform apply` destroy+recreate the secret
    # (version loss → prod outage for DATABASE_URL/JWT_SECRET). Match reality.
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  depends_on = [google_project_service.apis]
}
