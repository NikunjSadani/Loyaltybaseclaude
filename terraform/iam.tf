# ─────────────────────────────────────────────────────────────────────────────
# IAM — Service Accounts and Role Bindings
#
# Three service accounts:
#   gifsy-deployer     — used by GitHub Actions (push images, deploy Cloud Run)
#   gifsy-api-sa       — identity of the NestJS API Cloud Run service
#   gifsy-frontend-sa  — identity of the Next.js frontend Cloud Run service
# ─────────────────────────────────────────────────────────────────────────────

# ── GitHub Actions deployer ───────────────────────────────────────────────────

resource "google_service_account" "deployer" {
  account_id   = "gifsy-deployer"
  display_name = "Gifsy GitHub Actions Deployer"
  description  = "Used by GitHub Actions to push Docker images and deploy Cloud Run services"
}

resource "google_project_iam_member" "deployer_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_storage_admin" {
  project = var.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# Required for terraform apply to enable GCP APIs via google_project_service resources.
# Grant this once manually before first apply:
#   gcloud projects add-iam-policy-binding gifsy-platform \
#     --member="serviceAccount:gifsy-deployer@gifsy-platform.iam.gserviceaccount.com" \
#     --role="roles/serviceusage.serviceUsageAdmin"
resource "google_project_iam_member" "deployer_service_usage_admin" {
  project = var.project_id
  role    = "roles/serviceusage.serviceUsageAdmin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# ── API Cloud Run service account ────────────────────────────────────────────

resource "google_service_account" "api_sa" {
  account_id   = "gifsy-api-sa"
  display_name = "Gifsy API (Cloud Run)"
  description  = "Runtime identity for the NestJS gifsy-api Cloud Run service"
}

resource "google_project_iam_member" "api_sa_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api_sa.email}"
}

resource "google_project_iam_member" "api_sa_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.api_sa.email}"
}

resource "google_project_iam_member" "api_sa_storage_object_admin" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.api_sa.email}"
}

# ── Frontend Cloud Run service account ───────────────────────────────────────

resource "google_service_account" "frontend_sa" {
  account_id   = "gifsy-frontend-sa"
  display_name = "Gifsy Frontend (Cloud Run)"
  description  = "Runtime identity for the Next.js gifsy-frontend Cloud Run service"
}

resource "google_project_iam_member" "frontend_sa_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.frontend_sa.email}"
}

# Next.js API routes (running in this Cloud Run service) upload files to GCS
# and generate signed GET URLs — objectAdmin covers read/write/delete.
resource "google_project_iam_member" "frontend_sa_storage_object_admin" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.frontend_sa.email}"
}

# Required for GCS V4 signed URL generation via Application Default Credentials.
# The service account must be able to sign blobs on behalf of itself.
resource "google_service_account_iam_member" "frontend_sa_token_creator" {
  service_account_id = google_service_account.frontend_sa.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.frontend_sa.email}"
}

# Same signed-URL permission for the API SA (NestJS may generate download links too)
resource "google_service_account_iam_member" "api_sa_token_creator" {
  service_account_id = google_service_account.api_sa.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api_sa.email}"
}
