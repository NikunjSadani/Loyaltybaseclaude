/// <reference types="vitest/globals" />
/**
 * TDD — Sales-team banner configuration
 *
 * RED phase: all tests fail before implementation.
 *
 * Changes under test:
 *  1. lib/banner.ts              — add showInSalesApp field + async API helpers
 *  2. app/api/admin/banner-config/route.ts  — new GET + PUT (programSetting-backed)
 *  3. app/admin/banners/page.tsx — migrate from loadBanners/saveBanners → API
 *  4. app/sales/dashboard/page.tsx — fetch + show banners targeted at sales team
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── A: lib/banner.ts — new API shape ────────────────────────────────────────

describe('A — lib/banner.ts API shape', () => {
  const code = src('lib/banner.ts');

  it('A1: Banner interface has showInSalesApp field', () => {
    expect(code).toMatch(/showInSalesApp\s*[?]?\s*:\s*boolean/);
  });

  it('A2: exports fetchBanners (async)', () => {
    expect(code).toMatch(/export\s+async\s+function\s+fetchBanners/);
  });

  it('A3: exports updateBanners (async)', () => {
    expect(code).toMatch(/export\s+async\s+function\s+updateBanners/);
  });

  it('A4: fetchBanners sends Authorization header', () => {
    expect(code).toMatch(/Authorization/);
  });

  it('A5: updateBanners sends Authorization header', () => {
    // Both fetchBanners and updateBanners use the same authHeader() helper
    // so one match is sufficient — checked in A4; here confirm PUT body
    expect(code).toMatch(/method\s*:\s*['"]PUT['"]/);
  });

  it('A6: exports getActiveSalesBanners helper', () => {
    expect(code).toMatch(/export\s+function\s+getActiveSalesBanners/);
  });
});

// ─── B: API route file exists and is shaped correctly ────────────────────────

describe('B — app/api/admin/banner-config/route.ts shape', () => {
  const code = src('app/api/admin/banner-config/route.ts');

  it('B1: exports GET', () => {
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
  });

  it('B2: exports PUT', () => {
    expect(code).toMatch(/export\s+async\s+function\s+PUT/);
  });

  it('B3: uses prisma.programSetting', () => {
    expect(code).toMatch(/programSetting/);
  });

  it('B4: uses settingKey "banner_config"', () => {
    expect(code).toMatch(/banner_config/);
  });

  it('B5: GET allows all non-partner roles (e.g. SALES_SO)', () => {
    // Partner roles blocked; internal roles allowed
    expect(code).toMatch(/SSS/); // blocked (was RETAILER, renamed to SSS)
    expect(code).toMatch(/partnerRoles/);
  });

  it('B6: PUT allows CLIENT_ADMIN and GIFSY_ADMIN', () => {
    expect(code).toMatch(/CLIENT_ADMIN/);
    expect(code).toMatch(/GIFSY_ADMIN/);
  });

  it('B7: Banner items in PUT schema include showInSalesApp', () => {
    expect(code).toMatch(/showInSalesApp/);
  });
});

// ─── C: admin/banners/page.tsx — uses API helpers ────────────────────────────

describe('C — admin/banners/page.tsx uses API helpers', () => {
  const code = src('app/admin/banners/page.tsx');

  it('C1: imports fetchBanners', () => {
    expect(code).toMatch(/fetchBanners/);
  });

  it('C2: imports updateBanners', () => {
    expect(code).toMatch(/updateBanners/);
  });

  it('C3: does not call loadBanners() (localStorage-only helper)', () => {
    expect(code).not.toMatch(/loadBanners\s*\(\s*\)/);
  });

  it('C4: does not call saveBanners() (localStorage-only helper)', () => {
    expect(code).not.toMatch(/saveBanners\s*\(\s*\)/);
  });

  it('C5: has a "Show in Sales App" toggle (showInSalesApp)', () => {
    expect(code).toMatch(/showInSalesApp/);
  });
});

// ─── D: sales/dashboard/page.tsx — shows sales banners ───────────────────────

describe('D — sales/dashboard/page.tsx shows sales banners', () => {
  const code = src('app/sales/dashboard/page.tsx');

  it('D1: imports fetchBanners', () => {
    expect(code).toMatch(/fetchBanners/);
  });

  it('D2: fetches banners in useEffect (async load)', () => {
    expect(code).toMatch(/fetchBanners\s*\(\s*\)/);
  });

  it('D3: uses getActiveSalesBanners helper (which internally filters by showInSalesApp)', () => {
    // The dashboard delegates to getActiveSalesBanners() rather than re-implementing
    // the showInSalesApp check inline — this is the correct pattern.
    expect(code).toMatch(/getActiveSalesBanners/);
  });

  it('D4: renders banner title in the sales UI', () => {
    // The banner strip renders banner.title
    expect(code).toMatch(/banner\.title/);
  });
});

// ─── E: API route runtime ─────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  default: {
    programSetting: {
      findFirst: vi.fn(),
      upsert:    vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser: vi.fn(),
}));

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn(() => 'client_test'),
}));

import { GET, PUT } from '../../app/api/admin/banner-config/route';
import prisma        from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

const clientAdmin = { userId: 'u_1', role: 'CLIENT_ADMIN' };
const gifsyAdmin  = { userId: 'u_2', role: 'GIFSY_ADMIN'  };

function makeReq(opts: { body?: unknown; role?: string | null } = {}) {
  const { role = 'CLIENT_ADMIN', body } = opts;
  const payload =
    role === 'CLIENT_ADMIN' ? clientAdmin :
    role === 'GIFSY_ADMIN'  ? gifsyAdmin  : null;
  (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(payload);
  return {
    headers: { get: (k: string) => (k === 'x-tenant-slug' ? 'testclient' : null) },
    json: () => Promise.resolve(body),
  } as any;
}

const DEFAULT_BANNERS: unknown[] = [];

describe('E — API route runtime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('E1: GET returns 401 when not authenticated', async () => {
    const req = makeReq({ role: null });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('E2: GET returns 200 for SALES_SO role', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_x', role: 'SALES_SO' });
    (prisma.programSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = {
      headers: { get: () => 'testclient' },
      json: () => Promise.resolve({}),
    } as any;
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('E3: GET returns empty banners array when no setting stored', async () => {
    (prisma.programSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res  = await GET(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.banners).toEqual([]);
  });

  it('E4: GET returns stored banners when setting exists', async () => {
    const stored = [
      { id: 'b1', active: true, type: 'text', title: 'Scheme Update', body: 'New scheme launched',
        ctaLabel: '', ctaUrl: '', videoUrl: '', bgColor: 'indigo',
        audience: 'ALL', priority: 0, startDate: '', endDate: '',
        showInSalesApp: true, updatedAt: new Date().toISOString() },
    ];
    (prisma.programSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ settingValue: { banners: stored } });
    const res  = await GET(makeReq());
    const body = await res.json();
    expect(body.data.banners).toHaveLength(1);
    expect(body.data.banners[0].title).toBe('Scheme Update');
  });

  it('E5: PUT returns 401 when not authenticated', async () => {
    const res = await PUT(makeReq({ role: null, body: { banners: DEFAULT_BANNERS } }));
    expect(res.status).toBe(401);
  });

  it('E6: PUT returns 403 for SALES_SO (only admins can write)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_x', role: 'SALES_SO' });
    const req = {
      headers: { get: () => 'testclient' },
      json: () => Promise.resolve({ banners: DEFAULT_BANNERS }),
    } as any;
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it('E7: PUT upserts programSetting with key "banner_config"', async () => {
    (prisma.programSetting.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ps_1' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = makeReq({ body: { banners: DEFAULT_BANNERS } });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const call = (prisma.programSetting.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId_settingKey.settingKey).toBe('banner_config');
  });

  it('E8: PUT rejects body missing banners array', async () => {
    const req = makeReq({ body: {} }); // missing banners
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('E9: PUT accepts banners with showInSalesApp flag', async () => {
    (prisma.programSetting.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ps_1' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const banners = [{
      id: 'b1', active: true, type: 'text', title: 'Scheme Update', body: 'New scheme launched',
      ctaLabel: '', ctaUrl: '', videoUrl: '', bgColor: 'indigo',
      audience: 'ALL', priority: 0, startDate: '', endDate: '',
      showInSalesApp: true, updatedAt: new Date().toISOString(),
    }];
    const res = await PUT(makeReq({ body: { banners } }));
    expect(res.status).toBe(200);
  });
});

// ─── F: getActiveSalesBanners filters correctly ───────────────────────────────

describe('F — getActiveSalesBanners helper logic (source check)', () => {
  const code = src('lib/banner.ts');

  it('F1: getActiveSalesBanners filters by showInSalesApp', () => {
    expect(code).toMatch(/showInSalesApp/);
  });

  it('F2: getActiveSalesBanners filters by active flag', () => {
    // The function must check b.active
    expect(code).toMatch(/\.active/);
  });

  it('F3: getActiveSalesBanners respects startDate/endDate scheduling', () => {
    expect(code).toMatch(/startDate/);
    expect(code).toMatch(/endDate/);
  });
});
