# ─────────────────────────────────────────────────────────────────────────────
# VPC — private networking
#
# The VPC connector is REQUIRED: gifsy-db is a PRIVATE-IP-ONLY Cloud SQL instance
# (ipv4Enabled=false, 10.49.0.3 on gifsy-vpc), so Cloud Run — BOTH prod and staging
# (verified on the live services) — reaches the DB THROUGH this connector. The
# --add-cloudsql-instances socket supplies the Auth Proxy, but the proxy needs a VPC
# route to a private-IP instance, which is this connector. It formerly ALSO carried
# Redis traffic (Redis deleted 2026-07-21); the DB purpose remains, so it stays.
# The ONLY way to drop the connector cost (~₹1,445/mo) is to migrate Cloud Run to
# Direct VPC egress (replaces the connector) — a tested change, not a delete.
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

# VPC Access Connector — REQUIRED for Cloud Run → private-IP Cloud SQL (both prod
# and staging). Already at the minimum size (min_instances=2). See header note.
resource "google_vpc_access_connector" "gifsy_connector" {
  name           = "gifsy-connector"
  region         = var.region
  network        = google_compute_network.gifsy_vpc.name
  ip_cidr_range  = "10.8.0.0/28"
  min_instances  = 2
  max_instances  = 10  # GCP default when connector was first created
  min_throughput = 200
  max_throughput = 1000 # 100 Mbps × max_instances; must match GCP value
  depends_on     = [google_project_service.apis]
}
