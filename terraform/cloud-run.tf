# ─────────────────────────────────────────────────────────────────────────────
# Cloud Run — 4 services total
#
#   gifsy-api               production NestJS API         port 4000
#   gifsy-frontend          production Next.js frontend   port 3000
#   gifsy-api-staging       staging NestJS API            port 4000
#   gifsy-frontend-staging  staging Next.js frontend      port 3000
#
# Cost difference:
#   Production: min-instances=1, VPC connector (→ Redis), full secrets
#   Staging:    scale-to-zero, no VPC connector, no Redis, FIXED_OTP active
# ─────────────────────────────────────────────────────────────────────────────

# ── PRODUCTION — NestJS API ───────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "api_prod" {
  name     = "gifsy-api"
  location = var.region

  template {
    service_account = google_service_account.api_sa.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    # VPC connector required to reach Memorystore Redis (private IP only)
    vpc_access {
      connector = google_vpc_access_connector.gifsy_connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.sql_connection]
      }
    }

    containers {
      image = var.prod_api_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = false # keep CPU allocated between requests — paid service, avoids cold-start penalty
      }

      ports {
        container_port = 4000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CORS_ORIGINS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cors_origins.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_AUTH_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_auth_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_SENDER_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_sender_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_OTP_TEMPLATE_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_otp_template_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_SMS_TEMPLATE_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_sms_template_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GCS_BUCKET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gcs_bucket.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GCP_PROJECT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gcp_project_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.redis_url.secret_id
            version = "latest"
          }
        }
      }

      # ── Business config — not sensitive, stored as plain env vars ─────────────
      env {
        name  = "PLATFORM_DOMAIN"
        value = "gifsy.in"
      }
      env {
        name  = "JWT_EXPIRES_IN"
        value = "7d"
      }
      env {
        name  = "JWT_REFRESH_EXPIRES_IN"
        value = "30d"
      }
      env {
        name  = "POINTS_TO_INR_RATE"
        value = "1"
      }
      env {
        name  = "MIN_PAYOUT_AMOUNT_PAISE"
        value = "10000"
      }
      env {
        name  = "TDS_SINGLE_TRANSACTION_THRESHOLD_PAISE"
        value = "3000000"
      }
      env {
        name  = "TDS_ANNUAL_THRESHOLD_PAISE"
        value = "10000000"
      }
      env {
        name  = "TDS_RATE_WITH_PAN"
        value = "1"
      }
      env {
        name  = "TDS_RATE_WITHOUT_PAN"
        value = "2"
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_vpc_access_connector.gifsy_connector,
    google_sql_database_instance.gifsy_db,
    google_redis_instance.gifsy_redis_prod,
  ]

  # GitHub Actions deploys real images via `gcloud run deploy`.
  # Ignore template changes so subsequent `terraform apply` runs don't revert the image.
  lifecycle {
    ignore_changes = [template]
  }
}

resource "google_cloud_run_v2_service_iam_member" "api_prod_public" {
  location = google_cloud_run_v2_service.api_prod.location
  name     = google_cloud_run_v2_service.api_prod.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── PRODUCTION — Next.js Frontend ────────────────────────────────────────────

resource "google_cloud_run_v2_service" "frontend_prod" {
  name     = "gifsy-frontend"
  location = var.region

  template {
    service_account = google_service_account.frontend_sa.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      image = var.prod_frontend_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = false
      }

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
    }
  }

  depends_on = [google_project_service.apis]

  lifecycle {
    ignore_changes = [template]
  }
}

resource "google_cloud_run_v2_service_iam_member" "frontend_prod_public" {
  location = google_cloud_run_v2_service.frontend_prod.location
  name     = google_cloud_run_v2_service.frontend_prod.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── STAGING — NestJS API ──────────────────────────────────────────────────────
# Lean: scale-to-zero, no Redis (no VPC connector needed), FIXED_OTP active.
# ~$0/month when idle; wakes in ~3 seconds on first request.

resource "google_cloud_run_v2_service" "api_staging" {
  name     = "gifsy-api-staging"
  location = var.region

  template {
    service_account = google_service_account.api_sa.email

    scaling {
      min_instance_count = 0 # scale-to-zero — costs nothing when idle
      max_instance_count = 3
    }

    # No VPC connector — staging has no Redis instance
    # Cloud SQL reached via unix socket (cloud_sql_instance volume, no public IP needed)

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.sql_connection]
      }
    }

    containers {
      image = var.staging_api_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true # throttle CPU between requests — saves cost on staging
      }

      ports {
        container_port = 4000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "FIXED_OTP"
        value = "123456" # NEVER set this in production Secret Manager
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url_staging.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret_staging.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CORS_ORIGINS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cors_origins_staging.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_AUTH_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_auth_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_SENDER_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_sender_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_OTP_TEMPLATE_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_otp_template_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MSG91_SMS_TEMPLATE_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.msg91_sms_template_id.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GCS_BUCKET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gcs_bucket.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GCP_PROJECT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gcp_project_id.secret_id
            version = "latest"
          }
        }
      }
      # No REDIS_URL on staging — staging has no Redis instance

      # ── Business config — same values as production ───────────────────────────
      env {
        name  = "PLATFORM_DOMAIN"
        value = "gifsy.in"
      }
      env {
        name  = "JWT_EXPIRES_IN"
        value = "7d"
      }
      env {
        name  = "JWT_REFRESH_EXPIRES_IN"
        value = "30d"
      }
      env {
        name  = "POINTS_TO_INR_RATE"
        value = "1"
      }
      env {
        name  = "MIN_PAYOUT_AMOUNT_PAISE"
        value = "10000"
      }
      env {
        name  = "TDS_SINGLE_TRANSACTION_THRESHOLD_PAISE"
        value = "3000000"
      }
      env {
        name  = "TDS_ANNUAL_THRESHOLD_PAISE"
        value = "10000000"
      }
      env {
        name  = "TDS_RATE_WITH_PAN"
        value = "1"
      }
      env {
        name  = "TDS_RATE_WITHOUT_PAN"
        value = "2"
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_sql_database_instance.gifsy_db,
  ]

  lifecycle {
    ignore_changes = [template]
  }
}

resource "google_cloud_run_v2_service_iam_member" "api_staging_public" {
  location = google_cloud_run_v2_service.api_staging.location
  name     = google_cloud_run_v2_service.api_staging.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── STAGING — Next.js Frontend ────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "frontend_staging" {
  name     = "gifsy-frontend-staging"
  location = var.region

  template {
    service_account = google_service_account.frontend_sa.email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.staging_frontend_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
    }
  }

  depends_on = [google_project_service.apis]

  lifecycle {
    ignore_changes = [template]
  }
}

resource "google_cloud_run_v2_service_iam_member" "frontend_staging_public" {
  location = google_cloud_run_v2_service.frontend_staging.location
  name     = google_cloud_run_v2_service.frontend_staging.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
