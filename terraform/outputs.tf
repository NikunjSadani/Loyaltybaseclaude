output "lb_ip_address" {
  description = "Point *.gifsy.in A records here"
  value       = google_compute_global_address.lb_ip.address
}

output "dns_instructions" {
  description = "DNS records to create after terraform apply"
  value       = <<-EOT
    Create these 2 A records at your domain registrar:

      Type  Name       Value
      A     gifsy.in   ${google_compute_global_address.lb_ip.address}
      A     *.gifsy.in ${google_compute_global_address.lb_ip.address}

    After DNS propagates (~15 min), Google auto-provisions the managed SSL cert.
    Check: gcloud compute ssl-certificates describe gifsy-ssl-cert --global
  EOT
}

# Production URLs (custom domain after LB setup)
output "prod_api_url" {
  value = try(
    "https://api.gifsy.in (Cloud Run: ${google_cloud_run_v2_service.api_prod.uri})",
    "https://api.gifsy.in (Cloud Run: not deployed yet)"
  )
  description = "Production API"
}

output "prod_frontend_url" {
  value = try(
    "https://platform.gifsy.in (Cloud Run: ${google_cloud_run_v2_service.frontend_prod.uri})",
    "https://platform.gifsy.in (Cloud Run: not deployed yet)"
  )
  description = "Production frontend"
}

# Staging URLs — use Cloud Run default .run.app URLs (no LB for staging)
output "staging_api_url" {
  value       = try(google_cloud_run_v2_service.api_staging.uri, "not deployed yet")
  description = "Staging API — use this URL directly or set up staging.gifsy.in DNS manually"
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
    Estimated monthly cost (asia-south1):

      Cloud SQL ${var.db_tier}        ~$12
      Redis BASIC 1GB (prod only)     ~$30
      Cloud Run prod (min 1 each)     ~$20
      Cloud Run staging (scale-to-0)  ~$1
      Load Balancer + CDN             ~$25
      VPC connector (prod)            ~$5
      GCS + Artifact Registry         ~$2
      ─────────────────────────────────────
      Total                           ~$95/month (~₹8,000)

    To upgrade Cloud SQL when needed:
      terraform apply -var="db_tier=db-custom-2-3840"   (+$80/month)
  EOT
}
