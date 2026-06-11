# ─────────────────────────────────────────────────────────────────────────────
# VPC — private networking
#
# The VPC connector is only needed for production Cloud Run → Memorystore Redis
# (private IP).  Staging Cloud Run skips Redis entirely, so no connector needed
# for staging.  Cloud SQL is reached via Unix socket (--add-cloudsql-instances)
# which doesn't require a VPC connector on either environment.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_compute_network" "gifsy_vpc" {
  name                    = "gifsy-vpc"
  auto_create_subnetworks = false
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
  name          = "gifsy-connector"
  region        = var.region
  network       = google_compute_network.gifsy_vpc.name
  ip_cidr_range = "10.8.0.0/28"
  min_instances = 2
  max_instances = 3
  depends_on    = [google_project_service.apis]
}
