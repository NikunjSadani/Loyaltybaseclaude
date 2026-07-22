output "dns_instructions" {
  description = "Cloudflare Worker routing — how to add new tenant subdomains"
  value       = <<-EOT
    Traffic routes through Cloudflare Workers (no GCP Load Balancer).
    NS records for gifsy.in point to Cloudflare.

    To add a new tenant subdomain (e.g. newclient.gifsy.in):
      1. Add route to cloudflare-worker/wrangler.toml
      2. Run: cd cloudflare-worker && npx wrangler deploy
      3. Add slug+config to platform/src/lib/platform/client-registry.ts

    Worker file: cloudflare-worker/worker.js
    Routes active: api / platform / deoleo / clientb (all *.gifsy.in)

    Wildcard A record (*.gifsy.in) in Cloudflare dashboard still exists —
    update or delete it (was pointing to released LB IP 8.232.60.239).
  EOT
}

# Production URLs
output "prod_api_url" {
  value       = "https://api.gifsy.in (Cloud Run: ${google_cloud_run_v2_service.api_prod.uri})"
  description = "Production API"
}

output "prod_frontend_url" {
  value       = "https://platform.gifsy.in (Cloud Run: ${google_cloud_run_v2_service.frontend_prod.uri})"
  description = "Production frontend"
}

# Staging URLs — use Cloud Run default .run.app URLs (no LB for staging)
output "staging_api_url" {
  value       = try(google_cloud_run_v2_service.api_staging.uri, "not deployed yet")
  description = "Staging API"
}

output "staging_frontend_url" {
  value       = try(google_cloud_run_v2_service.frontend_staging.uri, "not deployed yet")
  description = "Staging frontend"
}

output "cloud_sql_connection_name" {
  value       = try(google_sql_database_instance.gifsy_db.connection_name, "not deployed yet")
  description = "Used in --add-cloudsql-instances and for running migrations via proxy"
}

output "artifact_registry_url" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.gifsy_images.repository_id}"
  description = "Docker image URL prefix"
}

output "deployer_sa_email" {
  value       = google_service_account.deployer.email
  description = "Create a JSON key for this SA and add it as the GCP_SA_KEY GitHub secret"
}

output "monthly_cost_estimate" {
  value = <<-EOT
    Estimated monthly cost (asia-south1, no Load Balancer):

      Cloud SQL ${var.db_tier}        ~$12
      Cloud Run prod (min 1 each)     ~$9
      Cloud Run staging (scale-to-0)  ~$1
      Direct VPC egress               ~$0 (replaced the connector)
      GCS + Artifact Registry         ~$5
      Secret Manager                  ~$1
      Domain mappings (SSL)           free
      ─────────────────────────────────────
      Total                           ~$42/month (~Rs 3,500)

    Removed: Load Balancer + CDN (was ~$38/month)

    To upgrade Cloud SQL when needed:
      terraform apply -var="db_tier=db-custom-2-3840"   (+$80/month)
  EOT
}
