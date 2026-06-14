# ─────────────────────────────────────────────────────────────────────────────
# ARCHIVED — Load Balancer removed 2026-06-13
#
# All traffic is now routed through Cloudflare Workers (cloudflare-worker/).
# The Worker intercepts api/platform/deoleo/clientb subdomains at the edge
# and proxies to Cloud Run .run.app URLs, eliminating the need for the GCP
# Global HTTPS Load Balancer (~$36/month saving).
#
# Resources destroyed:
#   google_compute_global_forwarding_rule.https
#   google_compute_global_forwarding_rule.http
#   google_compute_target_https_proxy.gifsy_https_proxy
#   google_compute_target_http_proxy.gifsy_http_proxy
#   google_compute_url_map.gifsy_lb
#   google_compute_url_map.http_redirect
#   google_compute_backend_service.api_backend
#   google_compute_backend_service.frontend_backend
#   google_compute_region_network_endpoint_group.api_neg
#   google_compute_region_network_endpoint_group.frontend_neg
#   google_compute_managed_ssl_certificate.gifsy_cert
#   google_compute_global_address.lb_ip  (was 8.232.60.239)
#
# To add a new tenant subdomain:
#   1. Add its route to cloudflare-worker/wrangler.toml
#   2. Run: cd cloudflare-worker && npx wrangler deploy
#   3. Add its slug to platform/src/lib/platform/client-registry.ts
# ─────────────────────────────────────────────────────────────────────────────
