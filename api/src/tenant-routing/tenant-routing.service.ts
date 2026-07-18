import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class TenantRoutingService {
  constructor(private readonly prisma: PrismaService) {}

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

    const branding: PublicBranding = {
      displayName: asString(b.displayName) ?? '',
      primaryColor: asString(b.primaryColor) ?? '',
    };

    const logoUrl = asString(b.logoUrl);
    if (logoUrl !== undefined) branding.logoUrl = logoUrl;
    const wordmarkWhiteUrl = asString(b.wordmarkWhiteUrl);
    if (wordmarkWhiteUrl !== undefined) branding.wordmarkWhiteUrl = wordmarkWhiteUrl;
    const wordmarkColorUrl = asString(b.wordmarkColorUrl);
    if (wordmarkColorUrl !== undefined) branding.wordmarkColorUrl = wordmarkColorUrl;
    const faviconUrl = asString(b.faviconUrl);
    if (faviconUrl !== undefined) branding.faviconUrl = faviconUrl;

    return branding;
  }
}
