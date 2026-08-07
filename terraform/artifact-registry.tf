# ─────────────────────────────────────────────────────────────────────────────
# Artifact Registry — Docker image repository
# All builds push here; Cloud Run pulls from here.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "gifsy_images" {
  location      = var.region
  repository_id = "gifsy-images"
  format        = "DOCKER"
  description   = "Gifsy platform Docker images (api + frontend)"

  # Cleanup policies — MATCHES the live repo (applied out-of-band 2026-07-22 via
  # gcloud; see [[infra-cost-reduction]]). KEEP rules override DELETE rules. Do NOT
  # collapse these to a single keep-last-10 — that has no DELETE rule (bloat returns)
  # and no prod-latest anchor (a >30d prod image could be pruned). Order: keeps first.
  cleanup_policies {
    id     = "keep-prod-latest" # anchor current prod (tag `latest`) unconditionally
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["latest"]
    }
  }
  cleanup_policies {
    id     = "keep-recent-30" # rollback floor + current staging (newest 30)
    action = "KEEP"
    most_recent_versions {
      keep_count = 30
    }
  }
  cleanup_policies {
    id     = "delete-untagged" # drop untagged layers older than 7d
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }
  cleanup_policies {
    id     = "delete-old" # 30-day retention window (self-adapting)
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s"
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
