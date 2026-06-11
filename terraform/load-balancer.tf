# ─────────────────────────────────────────────────────────────────────────────
# Load Balancer + Cloud CDN + Managed SSL
#
# Routing:
#   api.gifsy.in          → gifsy-api (Cloud Run)
#   platform.gifsy.in     → gifsy-frontend (Cloud Run)
#   *.gifsy.in            → gifsy-frontend (Cloud Run)  ← tenant subdomains
#
# NOTE: Production LB only. Staging services are accessed via their Cloud Run
# default URLs (*.run.app) or via separate staging LB if needed.
#
# IMPORTANT: DNS step required after `terraform apply` —
#   Point *.gifsy.in and gifsy.in A record → google_compute_global_address.lb_ip
# ─────────────────────────────────────────────────────────────────────────────

# Static global IP for the LB
resource "google_compute_global_address" "lb_ip" {
  name = "gifsy-lb-ip"
}

# ── Managed SSL certificates ──────────────────────────────────────────────────
# Google provisions and auto-renews these once DNS points to lb_ip

resource "google_compute_managed_ssl_certificate" "gifsy_cert" {
  name = "gifsy-ssl-cert"
  managed {
    domains = [
      "gifsy.in",
      "platform.gifsy.in",
      "api.gifsy.in",
      "*.gifsy.in",        # covers all tenant subdomains
    ]
  }
}

# ── Serverless NEGs (one per Cloud Run service) ───────────────────────────────

resource "google_compute_region_network_endpoint_group" "api_neg" {
  name                  = "gifsy-api-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.api_prod.name
  }
}

resource "google_compute_region_network_endpoint_group" "frontend_neg" {
  name                  = "gifsy-frontend-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.frontend_prod.name
  }
}

# ── Backend services ──────────────────────────────────────────────────────────

resource "google_compute_backend_service" "api_backend" {
  name                  = "gifsy-api-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.api_neg.id
  }

  # No CDN on API (dynamic content, auth required)
  enable_cdn = false

  log_config {
    enable      = true
    sample_rate = 0.1
  }
}

resource "google_compute_backend_service" "frontend_backend" {
  name                  = "gifsy-frontend-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.frontend_neg.id
  }

  # CDN on frontend — caches static assets (_next/static)
  enable_cdn = true
  cdn_policy {
    cache_mode        = "CACHE_ALL_STATIC"
    default_ttl       = 3600
    max_ttl           = 86400
    client_ttl        = 3600
    serve_while_stale = 86400
    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = false
    }
  }

  log_config {
    enable      = true
    sample_rate = 0.05
  }
}

# ── URL map — routing rules ───────────────────────────────────────────────────

resource "google_compute_url_map" "gifsy_lb" {
  name            = "gifsy-url-map"
  default_service = google_compute_backend_service.frontend_backend.id

  host_rule {
    hosts        = ["api.gifsy.in"]
    path_matcher = "api-paths"
  }

  host_rule {
    hosts        = ["platform.gifsy.in", "*.gifsy.in", "gifsy.in"]
    path_matcher = "frontend-paths"
  }

  path_matcher {
    name            = "api-paths"
    default_service = google_compute_backend_service.api_backend.id
  }

  path_matcher {
    name            = "frontend-paths"
    default_service = google_compute_backend_service.frontend_backend.id
  }
}

# HTTP → HTTPS redirect
resource "google_compute_url_map" "http_redirect" {
  name = "gifsy-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

# ── HTTPS proxy ───────────────────────────────────────────────────────────────

resource "google_compute_target_https_proxy" "gifsy_https_proxy" {
  name             = "gifsy-https-proxy"
  url_map          = google_compute_url_map.gifsy_lb.id
  ssl_certificates = [google_compute_managed_ssl_certificate.gifsy_cert.id]
}

resource "google_compute_target_http_proxy" "gifsy_http_proxy" {
  name    = "gifsy-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

# ── Forwarding rules ──────────────────────────────────────────────────────────

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "gifsy-https-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.gifsy_https_proxy.id
  ip_address            = google_compute_global_address.lb_ip.id
  port_range            = "443"
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "gifsy-http-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.gifsy_http_proxy.id
  ip_address            = google_compute_global_address.lb_ip.id
  port_range            = "80"
}
