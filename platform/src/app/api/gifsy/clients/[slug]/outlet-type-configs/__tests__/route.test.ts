// TDD: /api/gifsy/clients/[slug]/outlet-type-configs  (GET + PUT)
// Tests written BEFORE implementation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  default: {
    outletType: { findMany: vi.fn(), findFirst: vi.fn() },
    outletTypeClientConfig: { findMany: vi.fn(), upsert: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser: vi.fn(),
}));

import { GET }  from '../route';
import { PUT }  from '../[code]/route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  role?: string;
  slug?: string;
  code?: string;
}) {
  const { role = 'GIFSY_ADMIN', slug = 'deoleo', body } = opts;
  return {
    headers: {
      get: (key: string) => {
        if (key === 'Authorization' || key === 'authorization') return `Bearer token`;
        if (key === 'x-tenant-slug') return slug;
        return null;
      },
    },
    json: () => Promise.resolve(body),
  } as any;
}

const SSS_TYPE      = { id: 'ot_1', code: 'SSS',         name: 'SSS',         isActive: true, createdAt: new Date() };
const WHOLESALER_TYPE = { id: 'ot_2', code: 'WHOLESALER',  name: 'Wholesaler',   isActive: true, createdAt: new Date() };

const DEFAULT_ROW = {
  id: 'cfg_1', clientId: 'deoleo', outletTypeId: 'ot_1',
  isEnabled: true, displayName: null,
  loyaltyEnabled: true, schemesEnabled: true, visibilityEnabled: true,
  payoutsEnabled: true, leaderboardEnabled: true, targetsEnabled: true, kycRequired: true,
  metadata: null, createdAt: new Date(), updatedAt: new Date(),
};

const gifsyAdminPayload  = { userId: 'u_1', role: 'GIFSY_ADMIN' };
const clientAdminPayload = { userId: 'u_2', role: 'CLIENT_ADMIN' };

// ── GET /api/gifsy/clients/[slug]/outlet-type-configs ─────────────────────────

describe('GET /api/gifsy/clients/[slug]/outlet-type-configs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(gifsyAdminPayload);
    (prisma.outletType.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([SSS_TYPE, WHOLESALER_TYPE]);
    (prisma.outletTypeClientConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('A1: returns 401 when no auth token', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(makeRequest({}), { params: Promise.resolve({ slug: 'deoleo' }) });
    expect(res.status).toBe(401);
  });

  it('A2: returns 403 for non-admin roles', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_3', role: 'SALES_ASM' });
    const res = await GET(makeRequest({}), { params: Promise.resolve({ slug: 'deoleo' }) });
    expect(res.status).toBe(403);
  });

  it('A3: CLIENT_ADMIN blocked from reading another client slug', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(clientAdminPayload);
    const res = await GET(
      makeRequest({ slug: 'other-client' }),
      { params: Promise.resolve({ slug: 'other-client' }) },
    );
    // CLIENT_ADMIN has clientId derived from their JWT — but we're not embedding clientId in
    // the platform token currently; for now CLIENT_ADMIN on Gifsy admin routes is blocked entirely
    // (only GIFSY_ADMIN can use /api/gifsy/* routes)
    expect(res.status).toBe(403);
  });

  it('A4: GIFSY_ADMIN gets all outlet type configs', async () => {
    const res = await GET(makeRequest({}), { params: Promise.resolve({ slug: 'deoleo' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('A5: missing DB rows are filled with defaults', async () => {
    (prisma.outletTypeClientConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(makeRequest({}), { params: Promise.resolve({ slug: 'deoleo' }) });
    const body = await res.json();
    body.data.forEach((cfg: any) => {
      expect(cfg.isEnabled).toBe(true);
      expect(cfg.loyaltyEnabled).toBe(true);
    });
  });

  it('A6: existing DB row values are returned', async () => {
    (prisma.outletTypeClientConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...DEFAULT_ROW, isEnabled: false, schemesEnabled: false },
    ]);
    const res = await GET(makeRequest({}), { params: Promise.resolve({ slug: 'deoleo' }) });
    const body = await res.json();
    const retailerCfg = body.data.find((c: any) => c.outletTypeCode === 'SSS');
    expect(retailerCfg.isEnabled).toBe(false);
    expect(retailerCfg.schemesEnabled).toBe(false);
  });
});

// ── PUT /api/gifsy/clients/[slug]/outlet-type-configs/[code] ──────────────────

describe('PUT /api/gifsy/clients/[slug]/outlet-type-configs/[code]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(gifsyAdminPayload);
    (prisma.outletType.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(SSS_TYPE);
    (prisma.outletTypeClientConfig.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_ROW, isEnabled: false,
    });
  });

  it('B1: returns 401 when no auth token', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await PUT(
      makeRequest({ body: { isEnabled: false } }),
      { params: Promise.resolve({ slug: 'deoleo', code: 'SSS' }) },
    );
    expect(res.status).toBe(401);
  });

  it('B2: returns 403 for non-admin roles', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_3', role: 'SALES_ISR' });
    const res = await PUT(
      makeRequest({ body: { isEnabled: false } }),
      { params: Promise.resolve({ slug: 'deoleo', code: 'SSS' }) },
    );
    expect(res.status).toBe(403);
  });

  it('B3: returns 404 when outlet type code not found', async () => {
    (prisma.outletType.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PUT(
      makeRequest({ body: { isEnabled: false } }),
      { params: Promise.resolve({ slug: 'deoleo', code: 'NONEXISTENT' }) },
    );
    expect(res.status).toBe(404);
  });

  it('B4: returns 200 with updated config on success', async () => {
    const res = await PUT(
      makeRequest({ body: { isEnabled: false } }),
      { params: Promise.resolve({ slug: 'deoleo', code: 'SSS' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.outletTypeCode).toBe('SSS');
  });

  it('B5: calls prisma.upsert with correct clientId and outletTypeId', async () => {
    await PUT(
      makeRequest({ body: { schemesEnabled: false } }),
      { params: Promise.resolve({ slug: 'deoleo', code: 'SSS' }) },
    );
    expect(prisma.outletTypeClientConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId_outletTypeId: { clientId: 'deoleo', outletTypeId: 'ot_1' } },
      }),
    );
  });
});
