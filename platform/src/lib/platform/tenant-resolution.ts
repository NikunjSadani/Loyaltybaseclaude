/**
 * Tenant resolution — maps an incoming hostname to a ClientConfig.
 *
 * Flow:
 *   hostname  →  resolveSlugFromHostname()  →  slug
 *   slug      →  resolveClientConfig()      →  ClientConfig | null
 *
 * §A-DOMAIN Phase 2: the domain→slug decision and the branding overlay are now
 * DB-aware. The pure core (`resolveSlugFromDomainMap`, `applyDbBranding`) takes
 * its data as arguments so it stays fully unit-testable; the DB map/branding come
 * from the in-memory `tenant-routing-cache` snapshot (fetched from
 * `GET /v1/tenants/routing`), with `CLIENT_REGISTRY` as the rollout fallback.
 *
 * The Next.js proxy calls these and sets x-tenant-slug on each request. It reads
 * the sync snapshot only (never blocks) and triggers a background refresh — see
 * tenant-routing-cache.ts.
 */

import { CLIENT_REGISTRY } from './client-registry';
import { DEFAULT_CLIENT_CONFIG } from './default-client-config';
import type { BrandingConfig, ClientConfig } from './client-config';
import {
  ensureWarm,
  getRoutingSnapshot,
  type PublicBranding,
} from './tenant-routing-cache';

/**
 * The slug served when running on localhost / no subdomain detected.
 * Points to Deoleo for all local development.
 */
export const DEFAULT_DEV_SLUG = 'deoleo';

/**
 * Top-level domains / subdomains that are reserved for the platform itself
 * and should NOT be treated as client slugs.
 */
const PLATFORM_RESERVED = new Set(['www', 'app', 'api', 'admin', 'status', 'mail', 'platform']);

/**
 * The GIFSY platform-operator console. The operator user lives under clientId
 * `gifsy` (NOT a tenant in CLIENT_REGISTRY), so these exact hostnames must resolve
 * to the `gifsy` slug — otherwise `app.gifsy.in` falls into PLATFORM_RESERVED → null
 * (→ default tenant) and `uat.app.gifsy.in` would yield the `uat` label. Matched as
 * full hosts ahead of every other rule. The staging build runs the same code, so
 * the staging host resolves natively (no Worker host-alias needed).
 *   app.gifsy.in      → gifsy   (prod operator console)
 *   uat.app.gifsy.in  → gifsy   (staging operator console)
 */
const OPERATOR_HOSTS = new Set(['app.gifsy.in', 'uat.app.gifsy.in']);

/**
 * Registry-derived custom-hostname → slug map, built from each tenant's `domains`
 * (a branded domain that differs from the slug, e.g. `deoleoloyalty.gifsy.in` →
 * `deoleo`). Used as the fallback when the DB routing map lacks the host (or the
 * DB source is disabled). The DB map is layered OVER this (DB wins per-host).
 */
const DOMAIN_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.values(CLIENT_REGISTRY).flatMap((cfg) =>
    (cfg.domains ?? []).map((d) => [d.toLowerCase(), cfg.slug] as const),
  ),
);

/** The registry map as a Map, precomputed once (the pure resolver takes a Map). */
const REGISTRY_DOMAIN_TO_SLUG: ReadonlyMap<string, string> = new Map(
  Object.entries(DOMAIN_TO_SLUG),
);

/**
 * PURE domain→slug decision. Fed a single `domainToSlug` map (the caller merges
 * the DB map over the registry map so DB wins). Preserves ALL rules IN ORDER:
 *   1. OPERATOR_HOSTS (full-host)      → 'gifsy'
 *   2. localhost / empty               → DEFAULT_DEV_SLUG
 *   3. strip a leading `uat.` prefix (staging)
 *   4. domainToSlug lookup (DB-over-registry) → slug
 *   5. bare domain (≤2 labels)         → null
 *   6. PLATFORM_RESERVED first label   → null
 *   7. subdomain-label heuristic       → that label
 */
export function resolveSlugFromDomainMap(
  hostname: string,
  domainToSlug: ReadonlyMap<string, string>,
): string | null {
  // Strip port
  const host = hostname.toLowerCase().split(':')[0].trim();

  // GIFSY operator console — explicit full-host match → `gifsy` (overrides the
  // reserved/subdomain heuristics below). Checked first so neither the `app`
  // reserved-label nor the `uat` first-label intercepts it.
  if (OPERATOR_HOSTS.has(host)) return 'gifsy';

  // Localhost / empty → dev default
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return DEFAULT_DEV_SLUG;
  }

  // Staging serves every TENANT under a `uat.` prefix (uat.deoleoloyalty.gifsy.in,
  // uat.clientb.app.gifsy.in, …). Strip it so the prod-shaped custom-domain map and the
  // subdomain heuristic match. Without this, uat.deoleoloyalty.gifsy.in resolves to the
  // bogus slug `uat` (parts[0]) and EVERY direct tenant login on staging is rejected with
  // a wrong clientId. The operator host (uat.app.gifsy.in) is matched above before this,
  // so it is never stripped.
  const resolveHost = host.startsWith('uat.') ? host.slice(4) : host;

  // Custom branded domain (full-hostname match) wins over the subdomain heuristic.
  const mapped = domainToSlug.get(resolveHost);
  if (mapped) return mapped;

  const parts = resolveHost.split('.');

  // Bare domain (e.g. "gifsy.in") — 2 parts or fewer
  if (parts.length <= 2) return null;

  const subdomain = parts[0];

  // Reserved platform subdomains
  if (PLATFORM_RESERVED.has(subdomain)) return null;

  return subdomain;
}

/**
 * Extracts the tenant slug from an incoming hostname using the REGISTRY map only
 * (pure/sync, no DB). Kept for backward compatibility with existing importers and
 * tests. The DB-aware path is `resolveTenant` / `resolveTenantSync` below.
 *
 * Examples:
 *   deoleoloyalty.gifsy.in → "deoleo"   (custom domain map — branded ≠ slug)
 *   deoleo.gifsy.in        → "deoleo"
 *   clientb.app.gifsy.in   → "clientb"
 *   gifsy.in               → null   (bare domain — platform root)
 *   www.gifsy.in           → null   (reserved)
 *   localhost                    → DEFAULT_DEV_SLUG
 *   localhost:3000               → DEFAULT_DEV_SLUG
 *   ""                           → DEFAULT_DEV_SLUG
 */
export function resolveSlugFromHostname(hostname: string): string | null {
  return resolveSlugFromDomainMap(hostname, REGISTRY_DOMAIN_TO_SLUG);
}

/**
 * Merge the DB domain→slug map OVER the registry map so a DB entry wins per-host,
 * while registry-only hosts still resolve during rollout. Called on the hot path,
 * so it stays a cheap allocation (a handful of entries).
 */
function mergedDomainMap(): ReadonlyMap<string, string> {
  const snap = getRoutingSnapshot();
  if (!snap || snap.domainToSlug.size === 0) return REGISTRY_DOMAIN_TO_SLUG;
  const merged = new Map(REGISTRY_DOMAIN_TO_SLUG);
  for (const [domain, slug] of snap.domainToSlug) merged.set(domain, slug);
  return merged;
}

/**
 * PURE branding overlay. Given the registry config (or null) and the DB branding
 * (or undefined), returns the ClientConfig to render:
 *   - registry present + DB branding → registry OVERLAID with NON-EMPTY DB fields
 *     (DB wins per-field only when non-empty; empty/missing → keep registry, so a
 *     staging tenant whose DB branding is all "" is never clobbered).
 *   - registry present + no DB branding → the registry config unchanged.
 *   - NO registry entry + DB branding → a synthesised minimal ClientConfig (so a
 *     new DB-provisioned tenant still renders — see synthesizeConfig).
 *   - NO registry entry + no DB branding → null (unknown tenant → fail-closed).
 */
export function applyDbBranding(
  slug: string,
  registryConfig: ClientConfig | null,
  dbBranding: PublicBranding | undefined,
): ClientConfig | null {
  const overlay = pickNonEmptyBranding(dbBranding);

  if (!registryConfig) {
    // DB-only tenant (not in the registry). Synthesise a config from the DB
    // branding + safe defaults so it renders; null if there is nothing to show.
    if (Object.keys(overlay).length === 0) return null;
    return synthesizeConfig(slug, overlay);
  }

  if (Object.keys(overlay).length === 0) return registryConfig;

  const branding: BrandingConfig = { ...registryConfig.branding, ...overlay };
  return { ...registryConfig, branding };
}

/** A 6-digit hex color — the only shape `primaryColor` is allowed to take. */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Keep only the non-empty public branding fields (empty "" → dropped). */
function pickNonEmptyBranding(b: PublicBranding | undefined): Partial<BrandingConfig> {
  const out: Partial<BrandingConfig> = {};
  if (!b) return out;
  if (b.displayName && b.displayName.trim() !== '') out.displayName = b.displayName;
  // primaryColor is DB-influenced and feeds a CSS var / the x-tenant-color header —
  // only accept a strict 6-hex value, else keep the registry color (the CSS sink is
  // separately hard-sanitized, but rejecting junk here avoids a broken theme too).
  if (b.primaryColor && HEX6.test(b.primaryColor.trim())) out.primaryColor = b.primaryColor.trim();
  if (b.logoUrl && b.logoUrl.trim() !== '') out.logoUrl = b.logoUrl;
  if (b.wordmarkWhiteUrl && b.wordmarkWhiteUrl.trim() !== '') out.wordmarkWhiteUrl = b.wordmarkWhiteUrl;
  if (b.wordmarkColorUrl && b.wordmarkColorUrl.trim() !== '') out.wordmarkColorUrl = b.wordmarkColorUrl;
  if (b.faviconUrl && b.faviconUrl.trim() !== '') out.faviconUrl = b.faviconUrl;
  return out;
}

/**
 * Synthesise a minimal, SAFE ClientConfig for a DB-only tenant (one with routing
 * branding but no CLIENT_REGISTRY entry — a tenant provisioned after the registry
 * is frozen). This exists so such a tenant still RENDERS pre-login branding; it is
 * NOT a substitute for a full registry/config entry. Feature flags are deliberately
 * conservative (visibility/referral/RBAC OFF). Note that runtime feature/RBAC
 * enforcement comes from the BACKEND (per §A-DOMAIN D-1), not this FE config, so
 * these defaults only affect FE tab/visibility rendering.
 */
function synthesizeConfig(slug: string, branding: Partial<BrandingConfig>): ClientConfig {
  const displayName = branding.displayName ?? slug;
  // Spread DEFAULT_CLIENT_CONFIG so the safe feature/partnerClass/invoicing/wallet
  // defaults live in ONE place; override only identity + the DB-supplied branding.
  return {
    ...DEFAULT_CLIENT_CONFIG,
    slug,
    internalName: displayName,
    onboardedAt: new Date().toISOString().slice(0, 10),
    branding: {
      ...DEFAULT_CLIENT_CONFIG.branding,
      displayName,
      primaryColor: branding.primaryColor ?? DEFAULT_CLIENT_CONFIG.branding.primaryColor,
      logoUrl: branding.logoUrl ?? '',
      wordmarkWhiteUrl: branding.wordmarkWhiteUrl,
      wordmarkColorUrl: branding.wordmarkColorUrl,
      faviconUrl: branding.faviconUrl ?? '',
    },
  };
}

/**
 * Looks up a ClientConfig by slug, DB-branding-aware.
 * Returns the registry config OVERLAID with any non-empty DB branding fields, a
 * synthesised config for a DB-only tenant, or null if the slug is unknown
 * everywhere (show 404 / redirect to platform home).
 */
export function resolveClientConfig(slug: string): ClientConfig | null {
  if (!slug) return null;
  const key = slug.toLowerCase();
  const registryConfig = CLIENT_REGISTRY[key] ?? null;
  const dbBranding = getRoutingSnapshot()?.slugToBranding.get(key);
  return applyDbBranding(key, registryConfig, dbBranding);
}

/** The DB-aware resolution result. */
export interface ResolvedTenant {
  slug: string | null;
  config: ClientConfig | null;
}

/**
 * SYNC DB-aware resolution: reads the in-memory routing snapshot (DB map merged
 * over registry) and resolves the config with branding overlay. Never does I/O —
 * safe for the proxy hot path. On cold start (null snapshot) this is exactly the
 * registry behaviour.
 */
export function resolveTenantSync(hostname: string): ResolvedTenant {
  const slug = resolveSlugFromDomainMap(hostname, mergedDomainMap());
  if (slug === null) return { slug: null, config: null };
  return { slug, config: resolveClientConfig(slug) };
}

/**
 * ASYNC DB-aware resolver for NON-hot-path consumers (login actions, SSR helpers).
 * Triggers a background stale-while-revalidate refresh (never awaited → never
 * blocks) and returns the current sync snapshot result. Degrades to the registry
 * when the DB path yields nothing. The proxy does NOT use this — it reads
 * `resolveTenantSync` and drives the refresh via `waitUntil` instead.
 */
export async function resolveTenant(hostname: string): Promise<ResolvedTenant> {
  // Block ONLY on a genuine cold start (null snapshot) so a DB-only branded host
  // resolves to the right slug on the very first login/SSR of a fresh instance
  // instead of the bare label. Once warm this is instant; ensureWarm swallows its
  // own errors (registry fallback), so this can't reject.
  await ensureWarm();
  return resolveTenantSync(hostname);
}
