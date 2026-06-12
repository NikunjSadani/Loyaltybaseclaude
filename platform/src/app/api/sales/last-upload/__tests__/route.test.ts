/// <reference types="vitest/globals" />
/**
 * TDD — GET /api/sales/last-upload
 *
 * Returns the most recent successful SalesUpload.createdAt for the calling tenant.
 * Multi-tenant: scoped by clientId derived from request headers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  default: {
    salesUpload: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser: vi.fn(),
}));

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn(),
}));

import { GET } from '../route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRequest(opts: { clientId?: string; authed?: boolean } = {}) {
  const { clientId = 'tenant-abc', authed = true } = opts;
  return {
    headers: {
      get: (key: string) => {
        if (key === 'Authorization' || key === 'authorization') return authed ? 'Bearer token' : null;
        if (key === 'x-client-id') return clientId;
        return null;
      },
    },
  } as any;
}

const UPLOAD_ROW = {
  id: 'upload_1',
  clientId: 'tenant-abc',
  createdAt: new Date('2026-06-03T14:22:00Z'),
  status: 'COMPLETED',
  fileName: 'sales_june.xlsx',
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/sales/last-upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_1', role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('tenant-abc');
    (prisma.salesUpload.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(UPLOAD_ROW);
  });

  it('B1: returns 401 when no auth token', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(makeRequest({ authed: false }));
    expect(res.status).toBe(401);
  });

  it('B2: returns 200 with lastUploadedAt when a completed upload exists', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.lastUploadedAt).toBe('2026-06-03T14:22:00.000Z');
  });

  it('B3: returns null lastUploadedAt when no uploads exist for tenant', async () => {
    (prisma.salesUpload.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lastUploadedAt).toBeNull();
  });

  it('B4: query is scoped to the calling tenant (clientId from request)', async () => {
    await GET(makeRequest({ clientId: 'tenant-xyz' }));
    expect(prisma.salesUpload.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clientId: 'tenant-abc' }), // mocked getClientIdFromRequest returns 'tenant-abc'
      }),
    );
  });

  it('B5: query orders by createdAt desc — most recent upload is returned', async () => {
    await GET(makeRequest());
    expect(prisma.salesUpload.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('B6: only COMPLETED or PARTIALLY_COMPLETED uploads are considered', async () => {
    await GET(makeRequest());
    expect(prisma.salesUpload.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['COMPLETED', 'PARTIALLY_COMPLETED'] },
        }),
      }),
    );
  });
});
