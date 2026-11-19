/**
 * Builds the absolute link to a ticket on the ticket TENANT's own admin host, for emails.
 *
 * The request that triggers the email comes from a Gifsy operator (e.g. `app.gifsy.in`, or
 * `uat-app.gifsy.in` on staging). The recipient is the tenant's CLIENT_ADMIN, who signs in on
 * the tenant host (`<primary domain>` or `<slug>.gifsy.in`). So:
 *   - the tenant host = its primary ClientDomain, else `<clientId>.<PLATFORM_DOMAIN>`;
 *   - staging is detected from the caller's origin carrying the `uat` marker (`uat-<x>` or
 *     `uat.<x>`, the same rule the edge worker routes on) → the tenant host gets `uat-`;
 *   - a local dev origin (localhost / 127.0.0.1) is used as-is (single local FE).
 */

/** The platform's own domain (env PLATFORM_DOMAIN — "gifsy.in" on staging and prod). */
function platformDomain(): string {
  return (process.env.PLATFORM_DOMAIN ?? '').replace(/^﻿/, '').trim().toLowerCase() || 'gifsy.in';
}

/** The in-app path of a ticket (also used as the bell deep-link). */
export function ticketPath(ticketId: string): string {
  return `/admin/tickets?ticket=${encodeURIComponent(ticketId)}`;
}

export function ticketEmailLink(params: {
  /** `proto://host[:port]` the caller reached the platform on (externalOrigin(req)). */
  callerOrigin: string;
  /** The tenant's primary domain, if it has one registered. */
  tenantPrimaryDomain?: string | null;
  clientId: string;
  ticketId: string;
}): string {
  const path = ticketPath(params.ticketId);
  let host = '';
  try {
    host = new URL(params.callerOrigin).host.toLowerCase();
  } catch {
    host = '';
  }
  const name = host.replace(/:\d+$/, '');
  // Local dev only: a deployed API whose origin fell back to 'localhost' (externalOrigin's last
  // resort) must still produce the real tenant link.
  if ((name === 'localhost' || name === '127.0.0.1') && process.env.NODE_ENV !== 'production') {
    return `${params.callerOrigin.replace(/\/+$/, '')}${path}`;
  }
  const staging = name.startsWith('uat-') || name.startsWith('uat.');
  const domain = platformDomain();
  const primary = (params.tenantPrimaryDomain ?? '').trim().toLowerCase();
  const slugHost = `${params.clientId}.${domain}`;
  if (!staging) return `https://${primary || slugHost}${path}`;
  // Staging: the `uat-` marker only exists on single-label *.<platform domain> hosts. A custom
  // (non-platform) primary domain has no staging twin → use the slug host's staging form.
  const base = primary && primary.endsWith(`.${domain}`) ? primary : slugHost;
  const finalHost = base.startsWith('uat-') || base.startsWith('uat.') ? base : `uat-${base}`;
  return `https://${finalHost}${path}`;
}

/** Minimal HTML escaping for user-authored text placed into an email body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
