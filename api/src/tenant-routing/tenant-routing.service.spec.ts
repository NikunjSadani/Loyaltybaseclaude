import { TenantRoutingService } from './tenant-routing.service';

type ClientRow = { id: string; status: string; branding: unknown };
type DomainRow = { clientId: string; domain: string; isPrimary: boolean };

/**
 * Prisma mock. `client.findMany` honours the status `in` filter (so INACTIVE
 * exclusion is exercised for real). `clientDomain.findMany` honours the
 * clientId `in` filter — matching how the service groups in memory.
 */
function makePrisma(clients: ClientRow[], domains: DomainRow[]) {
  const clientFindMany = jest.fn(({ where }: any) => {
    const allowed: string[] = where?.status?.in ?? [];
    return Promise.resolve(clients.filter((c) => allowed.includes(c.status)));
  });
  const domainFindMany = jest.fn(({ where }: any) => {
    const ids: string[] = where?.clientId?.in ?? [];
    return Promise.resolve(domains.filter((d) => ids.includes(d.clientId)));
  });
  return {
    prisma: { client: { findMany: clientFindMany }, clientDomain: { findMany: domainFindMany } } as any,
    clientFindMany,
    domainFindMany,
  };
}

describe('TenantRoutingService', () => {
  it('includes ACTIVE and ONBOARDING tenants and EXCLUDES INACTIVE', async () => {
    const { prisma, clientFindMany } = makePrisma(
      [
        { id: 'deoleo', status: 'ACTIVE', branding: { displayName: 'Deoleo', primaryColor: '#123' } },
        { id: 'acme', status: 'ONBOARDING', branding: { displayName: 'Acme', primaryColor: '#456' } },
        { id: 'ghost', status: 'INACTIVE', branding: { displayName: 'Ghost', primaryColor: '#000' } },
      ],
      [],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();

    const slugs = res.tenants.map((t) => t.slug);
    expect(slugs).toEqual(['acme', 'deoleo']); // alphabetical, INACTIVE dropped
    expect(slugs).not.toContain('ghost');

    // Query only ever asks for ACTIVE + ONBOARDING at the DB layer.
    expect(clientFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['ACTIVE', 'ONBOARDING'] } } }),
    );
  });

  it('groups domains per tenant, primary-first then alphabetical', async () => {
    const { prisma } = makePrisma(
      [{ id: 'deoleo', status: 'ACTIVE', branding: { displayName: 'Deoleo', primaryColor: '#123' } }],
      [
        { clientId: 'deoleo', domain: 'zeta.example.com', isPrimary: false },
        { clientId: 'deoleo', domain: 'alpha.example.com', isPrimary: false },
        { clientId: 'deoleo', domain: 'canonical.example.com', isPrimary: true },
      ],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();

    expect(res.tenants).toHaveLength(1);
    // primary first, then the rest alphabetically
    expect(res.tenants[0].domains).toEqual([
      'canonical.example.com',
      'alpha.example.com',
      'zeta.example.com',
    ]);
  });

  it('does not cross-assign domains between tenants', async () => {
    const { prisma } = makePrisma(
      [
        { id: 'deoleo', status: 'ACTIVE', branding: { displayName: 'Deoleo', primaryColor: '#123' } },
        { id: 'acme', status: 'ONBOARDING', branding: { displayName: 'Acme', primaryColor: '#456' } },
      ],
      [
        { clientId: 'deoleo', domain: 'deoleo.example.com', isPrimary: true },
        { clientId: 'acme', domain: 'acme.example.com', isPrimary: true },
      ],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();

    const byslug = Object.fromEntries(res.tenants.map((t) => [t.slug, t.domains]));
    expect(byslug.deoleo).toEqual(['deoleo.example.com']);
    expect(byslug.acme).toEqual(['acme.example.com']);
  });

  it('returns a tenant with NO domains as domains: []', async () => {
    const { prisma } = makePrisma(
      [{ id: 'deoleo', status: 'ACTIVE', branding: { displayName: 'Deoleo', primaryColor: '#123' } }],
      [],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();

    expect(res.tenants[0].domains).toEqual([]);
  });

  it('whitelists ONLY the public branding subset and STRIPS any non-public / secret keys', async () => {
    const { prisma } = makePrisma(
      [
        {
          id: 'deoleo',
          status: 'ACTIVE',
          branding: {
            displayName: 'Deoleo',
            primaryColor: '#123456',
            logoUrl: 'https://cdn/logo.png',
            wordmarkWhiteUrl: 'https://cdn/w-white.png',
            wordmarkColorUrl: 'https://cdn/w-color.png',
            faviconUrl: 'https://cdn/favicon.ico',
            // Everything below MUST be stripped — never leaked pre-login.
            msg91AuthKey: 'SECRET-KEY',
            features: { visibilityEnabled: true },
            invoicing: { gstin: '29ABCDE1234F1Z5' },
            approvalHierarchy: [{ role: 'ASM' }],
            wallet: { conversionRate: 1 },
            notifications: { whatsappTemplate: 'x' },
          },
        },
      ],
      [],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();
    const branding = res.tenants[0].branding;

    expect(branding).toEqual({
      displayName: 'Deoleo',
      primaryColor: '#123456',
      logoUrl: 'https://cdn/logo.png',
      wordmarkWhiteUrl: 'https://cdn/w-white.png',
      wordmarkColorUrl: 'https://cdn/w-color.png',
      faviconUrl: 'https://cdn/favicon.ico',
    });

    // Belt-and-braces: assert each forbidden key is absent from the serialized blob.
    const serialized = JSON.stringify(res);
    for (const secret of ['msg91AuthKey', 'SECRET-KEY', 'features', 'invoicing', 'gstin', 'approvalHierarchy', 'wallet', 'notifications', 'conversionRate']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('omits optional URL branding keys when absent, keeping required keys as strings', async () => {
    const { prisma } = makePrisma(
      [{ id: 'deoleo', status: 'ACTIVE', branding: { displayName: 'Deoleo', primaryColor: '#123' } }],
      [],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();
    const branding = res.tenants[0].branding;

    expect(branding).toEqual({ displayName: 'Deoleo', primaryColor: '#123' });
    expect(branding).not.toHaveProperty('logoUrl');
    expect(branding).not.toHaveProperty('faviconUrl');
  });

  it('tolerates a missing / non-object branding blob (defaults to empty strings)', async () => {
    const { prisma } = makePrisma(
      [{ id: 'deoleo', status: 'ACTIVE', branding: null }],
      [],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();

    expect(res.tenants[0].branding).toEqual({ displayName: '', primaryColor: '' });
  });

  it('exposes a set appName (trimmed) alongside displayName, and never other keys', async () => {
    const { prisma } = makePrisma(
      [{ id: 'bajaj', status: 'ACTIVE', branding: {
        displayName: 'Bajaj Consumer Care Ltd', primaryColor: '#430441',
        appName: '  Bajaj Loyalty Club ', msg91AuthKey: 'SECRET-KEY', features: { x: true },
      } }],
      [],
    );
    const res = await new TenantRoutingService(prisma).getRouting();
    expect(res.tenants[0].branding).toEqual({
      displayName: 'Bajaj Consumer Care Ltd',
      primaryColor: '#430441',
      appName: 'Bajaj Loyalty Club',
    });
  });

  it('omits appName when blank / whitespace / non-string', async () => {
    for (const appName of ['', '   ', 42, null]) {
      const { prisma } = makePrisma(
        [{ id: 'acme', status: 'ACTIVE', branding: { displayName: 'Acme', primaryColor: '#456', appName } }],
        [],
      );
      const res = await new TenantRoutingService(prisma).getRouting();
      expect(res.tenants[0].branding).not.toHaveProperty('appName');
    }
  });

  it('skips the domain query entirely when there are no eligible tenants', async () => {
    const { prisma, domainFindMany } = makePrisma(
      [{ id: 'ghost', status: 'INACTIVE', branding: {} }],
      [{ clientId: 'ghost', domain: 'ghost.example.com', isPrimary: true }],
    );
    const svc = new TenantRoutingService(prisma);
    const res = await svc.getRouting();

    expect(res.tenants).toEqual([]);
    expect(domainFindMany).not.toHaveBeenCalled();
  });

  describe('branding asset URLs (private-bucket → public route, read-time)', () => {
    const DEOLEO_BRANDING = {
      displayName: 'Deoleo',
      primaryColor: '#16a34a',
      logoUrl: '/logos/deoleo.svg',
      wordmarkWhiteUrl: '/brand/deoleo-wordmark-white.png',
      wordmarkColorUrl: '/brand/deoleo-wordmark-color.png',
      faviconUrl: '/favicons/deoleo.ico',
    };
    const G = 'https://storage.googleapis.com/gifsy-platform-files/';
    const LOGO = 'branding/bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-bajaj-logo.png';
    const WM = 'branding/bajaj/2026-11/3c151c05-c912-4a86-a24c-ae1b270826c4-bajaj-wordmark-white.png';

    let prevBucket: string | undefined;
    beforeEach(() => {
      prevBucket = process.env.GCS_BUCKET;
      delete process.env.GCS_BUCKET;
    });
    afterEach(() => {
      if (prevBucket === undefined) delete process.env.GCS_BUCKET;
      else process.env.GCS_BUCKET = prevBucket;
    });

    it('maps stored storage.googleapis.com/<bucket>/branding/... URLs to the public route (Bajaj prod rows)', async () => {
      const { prisma } = makePrisma(
        [{ id: 'bajaj', status: 'ACTIVE', branding: {
          displayName: 'Bajaj Consumer Care Ltd', primaryColor: '#430441',
          logoUrl: G + LOGO, wordmarkWhiteUrl: G + WM,
        } }],
        [],
      );
      const res = await new TenantRoutingService(prisma).getRouting();
      expect(res.tenants[0].branding).toEqual({
        displayName: 'Bajaj Consumer Care Ltd',
        primaryColor: '#430441',
        logoUrl: `/api/public/branding-assets?key=${encodeURIComponent(LOGO)}`,
        wordmarkWhiteUrl: `/api/public/branding-assets?key=${encodeURIComponent(WM)}`,
      });
    });

    it('Deoleo static branding is returned BYTE-FOR-BYTE unchanged', async () => {
      const { prisma } = makePrisma(
        [{ id: 'deoleo', status: 'ACTIVE', branding: { ...DEOLEO_BRANDING } }],
        [{ clientId: 'deoleo', domain: 'deoleoloyalty.gifsy.in', isPrimary: true }],
      );
      const res = await new TenantRoutingService(prisma).getRouting();
      expect(JSON.stringify(res.tenants[0].branding)).toBe(JSON.stringify(DEOLEO_BRANDING));
    });

    it('leaves a non-branding prefix on the same bucket untouched (never re-pointed at the public route)', async () => {
      const kyc = G + 'kyc/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-pan.png';
      const { prisma } = makePrisma(
        [{ id: 'acme', status: 'ACTIVE', branding: { displayName: 'A', primaryColor: '#000000', logoUrl: kyc } }],
        [],
      );
      const res = await new TenantRoutingService(prisma).getRouting();
      expect(res.tenants[0].branding.logoUrl).toBe(kyc);
    });
  });

  describe('isKnownTenantSlug (branding-asset load shedding)', () => {
    function svcWith(idsSeq: Array<string[] | Error>) {
      const findMany = jest.fn();
      for (const ids of idsSeq) {
        if (ids instanceof Error) findMany.mockRejectedValueOnce(ids);
        else findMany.mockResolvedValueOnce(ids.map((id) => ({ id })));
      }
      let t = 1_000_000;
      const svc = new TenantRoutingService({ client: { findMany } } as any, () => t);
      return { svc, findMany, advance: (ms: number) => (t += ms) };
    }

    it('answers from ONE cached query of every Client id (any status: the console previews INACTIVE too)', async () => {
      const { svc, findMany } = svcWith([['bajaj', 'deoleo']]);
      await expect(svc.isKnownTenantSlug('bajaj')).resolves.toBe(true);
      await expect(svc.isKnownTenantSlug('deoleo')).resolves.toBe(true);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany.mock.calls[0][0]).toEqual({ select: { id: true } });
    });

    it('an unknown slug re-queries once (a tenant created moments ago) when the set is > 5s old, else 404s', async () => {
      const { svc, findMany, advance } = svcWith([['deoleo'], ['deoleo', 'fresh']]);
      await expect(svc.isKnownTenantSlug('ghost')).resolves.toBe(false); // just loaded: no re-query
      expect(findMany).toHaveBeenCalledTimes(1);
      advance(6_000);
      await expect(svc.isKnownTenantSlug('fresh')).resolves.toBe(true);
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('refreshes the set after its 60s TTL', async () => {
      const { svc, findMany, advance } = svcWith([['deoleo'], ['deoleo']]);
      await svc.isKnownTenantSlug('deoleo');
      advance(61_000);
      await svc.isKnownTenantSlug('deoleo');
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('fails OPEN when the slug set cannot be loaded (a load filter, not the security boundary)', async () => {
      const { svc } = svcWith([new Error('db down')]);
      await expect(svc.isKnownTenantSlug('bajaj')).resolves.toBe(true);
    });

    it('coalesces concurrent loads onto one query', async () => {
      const { svc, findMany } = svcWith([['bajaj']]);
      await Promise.all([svc.isKnownTenantSlug('bajaj'), svc.isKnownTenantSlug('bajaj')]);
      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });
});
