/**
 * Builds the absolute link to a ticket on the ticket TENANT's own admin host, for emails.
 *
 * The recipient is the tenant's CLIENT_ADMIN, who signs in on the tenant host
 * (`<primary domain>` or `<slug>.gifsy.in`). WHICH environment's host is decided from SERVER
 * config, never from the caller's host (an operator request can arrive via localhost or a raw
 * `*.run.app` origin, which says nothing about staging vs prod):
 *   1. TENANT_LINK_ENV = staging | production | local (explicit override);
 *   2. Cloud Run's K_SERVICE: a service name containing "staging" (gifsy-api-staging) → staging,
 *      any other Cloud Run service → production;
 *   3. the database name in DATABASE_URL: gifsy_staging → staging, gifsy_prod → production
 *      (the same positive DB check the fixed-OTP gate uses);
 *   4. NODE_ENV !== 'production' → local; otherwise production.
 * Staging links use the `uat-` host form (the edge worker's staging marker); a custom
 * (non-platform) primary domain has no staging twin, so staging falls back to `uat-<slug>.<domain>`.
 * Local uses the caller's own origin (a single local FE).
 */

export type LinkEnvironment = 'staging' | 'production' | 'local';

type Env = Record<string, string | undefined>;

/** The platform's own domain (env PLATFORM_DOMAIN — "gifsy.in" on staging and prod). */
function platformDomain(env: Env): string {
  return (env.PLATFORM_DOMAIN ?? '').replace(/^﻿/, '').trim().toLowerCase() || 'gifsy.in';
}

export function linkEnvironment(env: Env = process.env): LinkEnvironment {
  const explicit = (env.TENANT_LINK_ENV ?? '').trim().toLowerCase();
  if (explicit === 'staging' || explicit === 'production' || explicit === 'local') return explicit;
  const service = (env.K_SERVICE ?? '').trim().toLowerCase();
  if (service) return service.includes('staging') ? 'staging' : 'production';
  const db = env.DATABASE_URL ?? '';
  if (/\/gifsy_staging\b/.test(db)) return 'staging';
  if (/\/gifsy_prod\b/.test(db)) return 'production';
  return env.NODE_ENV === 'production' ? 'production' : 'local';
}

/** The in-app path of a ticket (also used as the bell deep-link). */
export function ticketPath(ticketId: string): string {
  return `/admin/tickets?ticket=${encodeURIComponent(ticketId)}`;
}

export function ticketEmailLink(params: {
  /** `proto://host[:port]` the caller reached the platform on — used ONLY in a local environment. */
  callerOrigin: string;
  /** The tenant's primary domain, if it has one registered. */
  tenantPrimaryDomain?: string | null;
  clientId: string;
  ticketId: string;
  /** Server env (defaults to process.env); injectable for tests. */
  env?: Env;
}): string {
  return tenantPortalLink({ ...params, path: ticketPath(params.ticketId) });
}

/**
 * An absolute link to ANY in-app path on the tenant's own portal host (same environment rules as the ticket email
 * link above). Used by the ticket email and the Visibility report's photo links.
 */
export function tenantPortalLink(params: {
  callerOrigin: string;
  tenantPrimaryDomain?: string | null;
  clientId: string;
  /** In-app path incl. query, starting with "/". */
  path: string;
  env?: Env;
}): string {
  const env = params.env ?? process.env;
  const path = params.path;
  const where = linkEnvironment(env);
  const domain = platformDomain(env);
  const primary = (params.tenantPrimaryDomain ?? '').trim().toLowerCase();
  const slugHost = `${params.clientId}.${domain}`;

  if (where === 'local') {
    try {
      return `${new URL(params.callerOrigin).origin}${path}`;
    } catch {
      return `http://localhost:3000${path}`;
    }
  }
  if (where === 'production') return `https://${primary || slugHost}${path}`;
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

/** A hostname that is a staging / UAT form (never valid for a production link). */
function isNonProdHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.startsWith('uat-') || h.startsWith('uat.') || h.includes('staging') || h.includes('localhost');
}

/**
 * Which registered tenant domain the email link may use. STRICTLY the row flagged isPrimary, and in
 * production never a staging / UAT-looking hostname. Returns null (→ the caller falls back to
 * `<slug>.<platform domain>`) plus a human note saying why, so the outcome is never silent.
 */
export function pickTenantDomain(
  rows: { domain: string; isPrimary: boolean }[],
  clientId: string,
  env: Env = process.env,
): { domain: string | null; note: string | null } {
  const slugHost = `${clientId}.${platformDomain(env)}`;
  const primary = rows.find((r) => r.isPrimary)?.domain?.trim().toLowerCase() ?? '';
  if (!primary) return { domain: null, note: `no primary domain is registered for this programme — the link uses ${slugHost}` };
  if (linkEnvironment(env) === 'production' && isNonProdHost(primary)) {
    return { domain: null, note: `the primary domain ${primary} looks like a staging host — the link uses ${slugHost}` };
  }
  return { domain: primary, note: null };
}
