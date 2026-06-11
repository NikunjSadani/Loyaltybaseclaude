# ─────────────────────────────────────────────────────────────────────────────
# Artifact Registry — Docker image repository
# All builds push here; Cloud Run pulls from here.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "gifsy_images" {
  location      = var.region
  repository_id = "gifsy-images"
  format        = "DOCKER"
  description   = "Gifsy platform Docker images (api + frontend)"

  cleanup_policies {
    id     = "keep-last-10"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  depends_on = [google_project_service.apis]
}

# Allow GitHub Actions deployer SA to push images
resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.gifsy_images.location
  repository = google_artifact_registry_repository.gifsy_images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Allow Cloud Run service accounts to pull images
resource "google_artifact_registry_repository_iam_member" "api_sa_reader" {
  location   = google_artifact_registry_repository.gifsy_images.location
  repository = google_artifact_registry_repository.gifsy_images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.api_sa.email}"
}

resource "google_artifact_registry_repository_iam_member" "frontend_sa_reader" {
  location   = google_artifact_registry_repository.gifsy_images.location
  repository = google_artifact_registry_repository.gifsy_images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.frontend_sa.email}"
}
