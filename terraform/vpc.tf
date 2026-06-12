# ─────────────────────────────────────────────────────────────────────────────
# VPC — private networking
#
# The VPC connector is only needed for production Cloud Run → Memorystore Redis
# (private IP).  Staging Cloud Run skips Redis entirely, so no connector needed
# for staging.  Cloud SQL is reached via Unix socket (--add-cloudsql-instances)
# which doesn't require a VPC connector on either environment.
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

# Private services range — needed for Cloud SQL private IP and Memorystore
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

# VPC Access Connector — production Cloud Run → Memorystore Redis (private IP)
# Staging Cloud Run does NOT use this (no Redis on staging).
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
