import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toServableBrandingUrl } from '../storage/branding-asset';

/** Tenant routing/status values exposed publicly (INACTIVE is never returned). */
export type PublicTenantStatus = 'ACTIVE' | 'ONBOARDING';

/**
 * The ONLY branding keys exposed pre-login. This is an explicit allow-list —
 * the `Client.branding` JSON blob may hold arbitrary extra keys (present or
 * future), and none of them must leak. Never spread the raw blob.
 */
export interface PublicBranding {
  displayName: string;
  primaryColor: string;
  /**
   * Optional short product/app name (e.g. "Bajaj Loyalty Club") shown under the
   * installed-app icon, the tab title, sign-in heading and app headers. Absent /
   * blank → the frontend falls back to displayName (the legal company name).
   */
  appName?: string;
  logoUrl?: string;
  wordmarkWhiteUrl?: string;
  wordmarkColorUrl?: string;
  faviconUrl?: string;
}

export interface PublicTenantRoute {
  slug: string;
  status: PublicTenantStatus;
  domains: string[];
  branding: PublicBranding;
}

export interface TenantRoutingResponse {
  tenants: PublicTenantRoute[];
}

/** How long the known-slug set (isKnownTenantSlug) is reused before a re-query. */
const SLUG_SET_TTL_MS = 60_000;
/** An unknown slug triggers one re-query only if the set is at least this old. */
const SLUG_SET_MISS_REQUERY_MS = 5_000;

@Injectable()
export class TenantRoutingService {
  private slugSet: { slugs: Set<string>; at: number } | null = null;
  private slugLoad: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    // Test seam only (no provider registers this token → Nest injects undefined → Date.now).
    @Optional() @Inject('TENANT_ROUTING_CLOCK') private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether `slug` is an existing tenant (ANY status — the Gifsy console previews an
   * INACTIVE tenant's uploaded branding too). Used by the public branding-asset route to
   * 404 keys for non-existent tenants BEFORE any storage call. One cached `select id` query
   * (60s TTL, coalesced); an unknown slug re-queries once if the set is > 5s old so a tenant
   * created moments ago is found. FAILS OPEN (true) when the set cannot be loaded: this is a
   * load-shedding filter — the key-shape validation is the security boundary.
   */
  async isKnownTenantSlug(slug: string): Promise<boolean> {
    if (!this.slugSet || this.now() - this.slugSet.at > SLUG_SET_TTL_MS) await this.loadSlugs();
    if (!this.slugSet) return true; // could not load → fail open
    if (this.slugSet.slugs.has(slug)) return true;
    if (this.now() - this.slugSet.at >= SLUG_SET_MISS_REQUERY_MS) {
      await this.loadSlugs();
      return this.slugSet?.slugs.has(slug) ?? true;
    }
    return false;
  }

  private loadSlugs(): Promise<void> {
    if (this.slugLoad) return this.slugLoad;
    this.slugLoad = this.prisma.client
      .findMany({ select: { id: true } })
      .then((rows) => {
        this.slugSet = { slugs: new Set(rows.map((r) => r.id)), at: this.now() };
      })
      .catch(() => {
        // Keep any last-good set; with none, isKnownTenantSlug fails open.
      })
      .finally(() => {
        this.slugLoad = null;
      });
    return this.slugLoad;
  }

  /**
   * Public, unauthenticated tenant-routing table. The Next.js edge proxy calls
   * this pre-login to resolve any request host → tenant slug + the public
   * branding subset it needs to paint the sign-in screen.
   *
   * Returns ONLY ACTIVE + ONBOARDING tenants (INACTIVE excluded). Two queries,
   * grouped in memory (there is no FK relation between Client and ClientDomain,
   * so no Prisma include is possible) — never N+1.
   */
  async getRouting(): Promise<TenantRoutingResponse> {
    const clients = await this.prisma.client.findMany({
      where: { status: { in: ['ACTIVE', 'ONBOARDING'] } },
      select: { id: true, status: true, branding: true },
    });

    const slugs = clients.map((c) => c.id);

    // Single query for every domain of the eligible tenants (empty `in` → skip).
    const domains = slugs.length
      ? await this.prisma.clientDomain.findMany({
          where: { clientId: { in: slugs } },
          select: { clientId: true, domain: true, isPrimary: true },
        })
      : [];

    // Group the domain rows by tenant, then sort each tenant's list primary-first,
    // then alphabetically. Tenants with no domains still get an empty array.
    const domainsByClient = new Map<string, { domain: string; isPrimary: boolean }[]>();
    for (const c of clients) domainsByClient.set(c.id, []);
    for (const d of domains) {
      domainsByClient.get(d.clientId)?.push({ domain: d.domain, isPrimary: d.isPrimary });
    }

    const sortedDomainsFor = (slug: string): string[] =>
      (domainsByClient.get(slug) ?? [])
        .slice()
        .sort((a, b) => {
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          return a.domain.localeCompare(b.domain);
        })
        .map((d) => d.domain);

    const tenants: PublicTenantRoute[] = clients
      .map((c) => ({
        slug: c.id,
        status: c.status as PublicTenantStatus,
        domains: sortedDomainsFor(c.id),
        branding: this.pickPublicBranding(c.branding),
      }))
      // Stable, deterministic (cacheable) ordering of the tenants themselves.
      .sort((a, b) => a.slug.localeCompare(b.slug));

    return { tenants };
  }

  /**
   * Whitelist the public branding subset. Explicitly picks named keys — NEVER
   * spreads the raw blob — so secrets or non-public config that happen to live
   * alongside branding cannot leak. Optional URL keys are included only when
   * present as a string.
   */
  private pickPublicBranding(raw: unknown): PublicBranding {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const asString = (v: unknown): string | undefined =>
      typeof v === 'string' ? v : undefined;
    // Image URLs: a stored private-bucket `branding/` object URL (403 in a browser) is
    // re-pointed at the public branding-asset route at READ time (no data migration).
    // Static paths (`/brand/…`, `/logos/…`, `/favicons/…` — Deoleo) pass through unchanged.
    const asAssetUrl = (v: unknown): string | undefined => {
      const s = asString(v);
      return s === undefined ? undefined : toServableBrandingUrl(s);
    };

    const branding: PublicBranding = {
      displayName: asString(b.displayName) ?? '',
      primaryColor: asString(b.primaryColor) ?? '',
    };

    // Only a non-blank appName is exposed (blank = "not set" → key omitted, so a
    // tenant without one gets a byte-identical snapshot to before).
    // Capped at 40 here too, so a value written outside the console (script / direct DB edit) can't grow unbounded.
    const appName = asString(b.appName)?.trim().slice(0, 40);
    if (appName) branding.appName = appName;

    const logoUrl = asAssetUrl(b.logoUrl);
    if (logoUrl !== undefined) branding.logoUrl = logoUrl;
    const wordmarkWhiteUrl = asAssetUrl(b.wordmarkWhiteUrl);
    if (wordmarkWhiteUrl !== undefined) branding.wordmarkWhiteUrl = wordmarkWhiteUrl;
    const wordmarkColorUrl = asAssetUrl(b.wordmarkColorUrl);
    if (wordmarkColorUrl !== undefined) branding.wordmarkColorUrl = wordmarkColorUrl;
    const faviconUrl = asAssetUrl(b.faviconUrl);
    if (faviconUrl !== undefined) branding.faviconUrl = faviconUrl;

    return branding;
  }
}
