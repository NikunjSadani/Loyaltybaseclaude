output "dns_instructions" {
  description = "DNS records to create after terraform apply (domain-mappings phase)"
  value       = <<-EOT
    All subdomains use CNAME -> ghs.googlehosted.com. at your registrar.
    Remove the old A records that pointed to the LB IP (8.232.60.239).

      Type   Name                 Value
      CNAME  api.gifsy.in         ghs.googlehosted.com.
      CNAME  platform.gifsy.in    ghs.googlehosted.com.
      CNAME  deoleo.gifsy.in      ghs.googlehosted.com.
      CNAME  clientb.gifsy.in     ghs.googlehosted.com.

    SSL certs auto-provision after DNS propagates (~5-60 min).
    New client: add one more CNAME + google_cloud_run_domain_mapping in domain-mappings.tf.
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
      Redis BASIC 1GB (prod only)     ~$16
      Cloud Run prod (min 1 each)     ~$9
      Cloud Run staging (scale-to-0)  ~$1
      VPC connector (prod)            ~$14
      GCS + Artifact Registry         ~$5
      Secret Manager                  ~$1
      Domain mappings (SSL)           free
      ─────────────────────────────────────
      Total                           ~$58/month (~Rs 4,900)

    Removed: Load Balancer + CDN (was ~$38/month)

    To upgrade Cloud SQL when needed:
      terraform apply -var="db_tier=db-custom-2-3840"   (+$80/month)
  EOT
}
