# ─────────────────────────────────────────────────────────────────────────────
# Cloud SQL — PostgreSQL 15
#
# ONE instance shared between production and staging (different databases).
# Cost: ~$12/month for db-g1-small at launch.
# Upgrade the tier when needed: terraform apply -var="db_tier=db-custom-2-3840"
# ─────────────────────────────────────────────────────────────────────────────

resource "google_sql_database_instance" "gifsy_db" {
  name             = local.db_instance_name
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"   # upgrade to REGIONAL when production traffic warrants HA

    ip_configuration {
      ipv4_enabled    = false      # no public IP
      private_network = google_compute_network.gifsy_vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "20:30"  # 2 AM IST
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }

    maintenance_window {
      day          = 7    # Sunday
      hour         = 3
      update_track = "stable"
    }

    database_flags {
      name  = "max_connections"
      value = "100"     # db-g1-small: safe limit; raise when upgrading tier
    }

    insights_config {
      query_insights_enabled = true
      query_string_length    = 1024
      record_application_tags = true
      record_client_address  = false
    }
  }

  deletion_protection = true

  depends_on = [
    google_service_networking_connection.private_vpc_connection,
    google_project_service.apis,
  ]
}

# ── Databases ─────────────────────────────────────────────────────────────────

resource "google_sql_database" "prod_db" {
  name     = "gifsy_prod"
  instance = google_sql_database_instance.gifsy_db.name
}

resource "google_sql_database" "staging_db" {
  name     = "gifsy_staging"
  instance = google_sql_database_instance.gifsy_db.name
}

# ── User ──────────────────────────────────────────────────────────────────────

resource "google_sql_user" "gifsy_user" {
  name     = "gifsy_user"
  instance = google_sql_database_instance.gifsy_db.name
  password = var.db_password
}

# ── Auto-populate DATABASE_URL secrets (Unix socket format for Cloud Run) ─────

resource "google_secret_manager_secret_version" "database_url_prod" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://gifsy_user:${urlencode(var.db_password)}@localhost/gifsy_prod?host=/cloudsql/${local.sql_connection}"
  depends_on  = [google_sql_database_instance.gifsy_db]
}

resource "google_secret_manager_secret_version" "database_url_staging" {
  secret      = google_secret_manager_secret.database_url_staging.id
  secret_data = "postgresql://gifsy_user:${urlencode(var.db_password)}@localhost/gifsy_staging?host=/cloudsql/${local.sql_connection}"
  depends_on  = [google_sql_database_instance.gifsy_db]
}
