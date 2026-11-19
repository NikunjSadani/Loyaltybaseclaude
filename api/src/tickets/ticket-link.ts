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
  const env = params.env ?? process.env;
  const path = ticketPath(params.ticketId);
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
