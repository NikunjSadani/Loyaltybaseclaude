/**
 * Request-volume round 5 (2026-11-21, staging 271b3ae9): background/push writes keep the read cache (Profile reuses
 * the lists' reads), the KYC list reuses its three reads on back-navigation, the Outlets page's visibility read is
 * de-duplicated, and the KYC tab has the refresh control.
 */
import fs from 'node:fs';
import path from 'node:path';

const eligibleSpy = vi.fn(async () => ({ success: true as const, data: { outlets: [] } }));
vi.mock('@/lib/visibility', () => ({ visibilityApi: { getSalesEligible: () => eligibleSpy() } }));

import { installClientMediumHeader, __resetClientMediumForTests, isCacheNeutralWrite, BACKGROUND_HEADER } from '@/lib/client-medium';
import { getSalesOutlets, getSalesMe, getKycSubmissions, getSalesTeam, getVisibilitySalesEligible } from '@/lib/cached-reads';
import { peekCached } from '@/lib/session-cache';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const count = (m: ReturnType<typeof vi.fn>, url: string) => m.mock.calls.filter((c) => String(c[0]) === url).length;

let originalFetch: typeof window.fetch;
beforeEach(() => { originalFetch = window.fetch; __resetClientMediumForTests(); eligibleSpy.mockClear(); });
afterEach(() => { window.fetch = originalFetch; __resetClientMediumForTests(); vi.unstubAllGlobals(); });

describe('a — automatic writes do not wipe the lists\' reads (Profile reuses them)', () => {
  it('a background push re-subscribe keeps /api/sales/outlets + /api/sales/me cached; a real write still clears', async () => {
    const base = vi.fn(async (u: RequestInfo | URL) => (String(u).includes('/api/sales/') ? ok({ outlets: [] }) : ok({})));
    window.fetch = base as unknown as typeof window.fetch;
    installClientMediumHeader();
    await getSalesOutlets();
    await getSalesMe();
    await window.fetch('/api/push/subscribe', { method: 'POST', headers: { [BACKGROUND_HEADER]: '1' } });
    await window.fetch('/api/push/installed', { method: 'POST' });
    await getSalesOutlets(); // Profile a few seconds later
    await getSalesMe();
    expect(count(base, '/api/sales/outlets')).toBe(1);
    expect(count(base, '/api/sales/me')).toBe(1);
    await window.fetch('/api/kyc/submit', { method: 'POST' });
    expect(peekCached('/api/sales/outlets')).toBeUndefined();
  });

  it('classifies writes', () => {
    expect(isCacheNeutralWrite('/api/push/subscribe', { method: 'POST' })).toBe(true);
    expect(isCacheNeutralWrite('/api/anything', { method: 'POST', headers: { [BACKGROUND_HEADER]: '1' } })).toBe(true);
    expect(isCacheNeutralWrite('/api/kyc/submit', { method: 'POST' })).toBe(false);
    expect(isCacheNeutralWrite('/api/notifications/read-all', { method: 'POST' })).toBe(false);
  });
});

describe('b — back to the KYC list within 60 s: no requests', () => {
  it('kyc, sales/outlets and sales/team are each fetched once across two visits', async () => {
    const f = vi.fn(async () => ok({ submissions: [], outlets: [], members: [] }));
    vi.stubGlobal('fetch', f);
    for (let visit = 0; visit < 2; visit++) {
      await Promise.all([getKycSubmissions(), getSalesOutlets(), getSalesTeam()]);
    }
    expect(count(f, '/api/kyc')).toBe(1);
    expect(count(f, '/api/sales/outlets')).toBe(1);
    expect(count(f, '/api/sales/team')).toBe(1);
    await getKycSubmissions({ force: true }); // the refresh control
    expect(count(f, '/api/kyc')).toBe(2);
  });

  it('the KYC page uses the shared readers, not its own fetches', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../../app/sales/kyc/page.tsx'), 'utf8');
    expect(code).not.toMatch(/fetch\(\s*'\/api\/(kyc|sales\/outlets|sales\/team)'/);
    expect(code).toMatch(/getKycSubmissions(<[^>]*>)?\(/);
    expect(code).toMatch(/getSalesTeam\(/);
  });
});

describe('c — /visibility/sales/eligible once per Outlets open', () => {
  it('the effect re-running when the roster arrives reuses the in-flight / cached read', async () => {
    await Promise.all([getVisibilitySalesEligible(), getVisibilitySalesEligible()]);
    await getVisibilitySalesEligible();
    expect(eligibleSpy).toHaveBeenCalledTimes(1);
  });

  it('Outlets / Tasks / dashboard call the shared reader', () => {
    const base = path.resolve(__dirname, '../../app/sales');
    for (const f of ['outlets/page.tsx', 'tasks/page.tsx', 'dashboard/page.tsx']) {
      const code = fs.readFileSync(path.join(base, f), 'utf8');
      expect(code, f).toMatch(/getVisibilitySalesEligible\(/);
      expect(code, f).not.toMatch(/visibilityApi\.getSalesEligible\(/);
    }
  });
});

describe('d — the KYC tab has the refresh control', () => {
  it('renders ListRefreshControl wired to a forced reload', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../../app/sales/kyc/page.tsx'), 'utf8');
    expect(code).toMatch(/<ListRefreshControl/);
    expect(code).toMatch(/setListRefresh\(\(n\) => n \+ 1\)/);
    expect(code).toMatch(/\[role, listRefresh\]/);
  });
});
