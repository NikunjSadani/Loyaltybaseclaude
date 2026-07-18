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
});
