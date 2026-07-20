import { test, expect } from '@playwright/test';
import { authHeader } from '../helpers/write';

/**
 * §A-DOMAIN Phase 6 — DB-driven tenant routing, end-to-end against the running stack.
 *
 * Proves the acceptance criterion (A-DOMAIN-PLAN.md §4 phase 6) at the BACKEND layer:
 * `GET /v1/tenants/routing` (the public table the Next edge proxy reads pre-login to
 * map host → slug + branding) returns a SECOND, DB-provisioned tenant WITH its
 * domain(s) + branding, Deoleo is unaffected, and no domain maps to two tenants.
 *
 * Runs under the `gifsy` project so it has an authenticated session: the routing
 * endpoint is `@Public()` on the backend, but the Next proxy still requires a valid
 * token to forward any non-public `/api/*` request (path is NOT role-restricted, so
 * any authenticated role passes). We reach it via the same-origin proxy at
 * `/api/tenants/routing`, exactly as the pre-login proxy does server-side.
 *
 * Seed source (api/prisma/seed.ts §4/§5 — seedClientBDemo + seedClientDomains):
 *   deoleo  → domains [deoleoloyalty.gifsy.in (primary), deoleo.gifsy.in]
 *   clientb → domains [zenithrewards.gifsy.in (primary, branded: label ≠ slug, NOT in
 *             the code registry), clientb.gifsy.in]; DB branding
 *             { displayName: 'Zenith Rewards (DB)', primaryColor: '#7c3aed' }
 *
 * The DB branding for clientb deliberately DIFFERS from CLIENT_REGISTRY.clientb
 * ('Client B Loyalty' / #2563eb) so a match here proves the value came from the DB,
 * not the code registry.
 *
 * NOT covered here (by design):
 *   - A real browser load of a never-configured `*.gifsy.in` (DNS/edge) — proven
 *     zero-touch by the P3 live-edge verify (a never-configured probe host returned
 *     a Next 404 through worker→frontend, i.e. fail-closed, not a CF black-hole).
 *   - Data-level cross-tenant isolation — covered by clientAdmin/cross-tenant.e2e.ts
 *     + clientbAdmin/cross-tenant.e2e.ts (both directions).
 */

interface PublicBranding {
  displayName?: string;
  primaryColor?: string;
  logoUrl?: string;
  wordmarkWhiteUrl?: string;
  wordmarkColorUrl?: string;
  faviconUrl?: string;
}
interface RouteTenant {
  slug: string;
  status: 'ACTIVE' | 'ONBOARDING';
  domains: string[];
  branding: PublicBranding;
}

// The exact allow-list the backend whitelists (tenant-routing.service.ts pickPublicBranding).
// Anything outside this set leaking into the public table is a security regression.
const ALLOWED_BRANDING_KEYS = new Set([
  'displayName',
  'primaryColor',
  'logoUrl',
  'wordmarkWhiteUrl',
  'wordmarkColorUrl',
  'faviconUrl',
]);

async function fetchRouting(page: import('@playwright/test').Page): Promise<RouteTenant[]> {
  const res = await page.request.get('/api/tenants/routing', { headers: authHeader('gifsy') });
  expect(res.status(), 'routing table is reachable through the proxy').toBe(200);
  const body = (await res.json()) as { data?: { tenants?: RouteTenant[] } };
  const tenants = body?.data?.tenants;
  expect(Array.isArray(tenants), 'response envelope is { data: { tenants: [...] } }').toBe(true);
  return tenants!;
}

test.describe('@gifsy §A-DOMAIN P6 — DB tenant routing table', () => {
  test('Deoleo is present, ACTIVE, and routes via its branded domain (unaffected)', async ({ page }) => {
    const tenants = await fetchRouting(page);
    const deoleo = tenants.find((t) => t.slug === 'deoleo');
    expect(deoleo, 'deoleo must be in the routing table').toBeTruthy();
    expect(deoleo!.status).toBe('ACTIVE');
    expect(
      deoleo!.domains.map((d) => d.toLowerCase()),
      'deoleo routes via deoleoloyalty.gifsy.in (branded: label ≠ slug)',
    ).toContain('deoleoloyalty.gifsy.in');
  });

  test('the 2nd DB-provisioned tenant (clientb) appears WITH its domain + DB branding', async ({ page }) => {
    const tenants = await fetchRouting(page);
    const clientb = tenants.find((t) => t.slug === 'clientb');
    expect(clientb, 'the DB-provisioned 2nd tenant must be in the routing table').toBeTruthy();

    // (1) It routes via a branded domain whose LABEL differs from the slug — a mapping
    // only the DB can supply (the code registry has no domains for clientb).
    expect(
      clientb!.domains.map((d) => d.toLowerCase()),
      'clientb routes via its DB-provisioned branded host zenithrewards.gifsy.in',
    ).toContain('zenithrewards.gifsy.in');

    // (2) Its branding RESOLVES from the DB — and the DISTINCTIVE '(DB)' value proves
    // the source is the DB row, not CLIENT_REGISTRY.clientb ('Client B Loyalty').
    expect(clientb!.branding.displayName).toBe('Zenith Rewards (DB)');
    expect(clientb!.branding.primaryColor).toBe('#7c3aed');
  });

  test('domain uniqueness: no host maps to two tenants (no cross-tenant mis-route)', async ({ page }) => {
    const tenants = await fetchRouting(page);
    const owners = new Map<string, string>();
    for (const t of tenants) {
      for (const d of t.domains) {
        const host = d.toLowerCase();
        const prev = owners.get(host);
        expect(
          prev === undefined,
          `DOMAIN COLLISION: "${host}" is claimed by both "${prev}" and "${t.slug}"`,
        ).toBe(true);
        owners.set(host, t.slug);
      }
    }
    // Sanity: the two branded hosts resolve to exactly the tenants we expect.
    expect(owners.get('deoleoloyalty.gifsy.in')).toBe('deoleo');
    expect(owners.get('zenithrewards.gifsy.in')).toBe('clientb');
  });

  test('the public table exposes ONLY whitelisted fields (no branding-blob leak)', async ({ page }) => {
    const tenants = await fetchRouting(page);
    for (const t of tenants) {
      // Only ACTIVE / ONBOARDING tenants are exposed (INACTIVE excluded by the service).
      expect(['ACTIVE', 'ONBOARDING']).toContain(t.status);
      for (const key of Object.keys(t.branding)) {
        expect(
          ALLOWED_BRANDING_KEYS.has(key),
          `NON-WHITELISTED branding key "${key}" leaked in the public routing table for "${t.slug}"`,
        ).toBe(true);
      }
    }
  });
});
