# ─────────────────────────────────────────────────────────────────────────────
# VPC — private networking
#
# gifsy-db is a PRIVATE-IP-ONLY Cloud SQL instance (ipv4Enabled=false, 10.49.0.3 on
# gifsy-vpc). Cloud Run reaches it over the VPC. As of 2026-07-22 both prod and
# staging use **Direct VPC egress** (Cloud Run `vpc_access { network_interfaces }`
# on gifsy-subnet-asia-south1, egress=private-ranges-only) — the Serverless VPC
# Access connector (`gifsy-connector`) it replaced has been DELETED (~₹1,445/mo
# saved). Do NOT re-add the connector resource — the live services + workflows use
# network_interfaces; a startup probe on /health/ready gates cold-start DB readiness.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_compute_network" "gifsy_vpc" {
  name = "gifsy-vpc"
  # GCP created this as auto-mode (auto_create_subnetworks = true) before Terraform
  # managed it. Keeping auto-mode to avoid VPC replacement (which would fail because
  # VPC Access Connector firewall rules are still attached).
  # The gifsy-subnet we create below coexists fine alongside the auto-mode subnets.
  auto_create_subnetworks = true
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "gifsy_subnet" {
  name                     = "gifsy-subnet-${var.region}"
  ip_cidr_range            = "10.0.0.0/20"
  region                   = var.region
  network                  = google_compute_network.gifsy_vpc.id
  private_ip_google_access = true
}

# Private services range — needed for Cloud SQL private IP
resource "google_compute_global_address" "private_ip_range" {
  name          = "gifsy-private-ip-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.gifsy_vpc.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.gifsy_vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]
  depends_on              = [google_project_service.apis]
}

# VPC Access Connector — REMOVED 2026-07-22. Migrated to Cloud Run Direct VPC egress
# (see cloud-run.tf `vpc_access { network_interfaces }` + the deploy workflows). The
# connector was deleted via `gcloud compute networks vpc-access connectors delete
# gifsy-connector`. Do NOT re-add it.
