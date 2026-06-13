/// <reference types="vitest/globals" />
/**
 * TDD — GET /api/admin/sales/batches
 *
 * SB1: 401 when unauthenticated
 * SB2: 403 when role is not CLIENT_ADMIN or GIFSY_ADMIN
 * SB3: 200 with batch list for the calling tenant
 * SB4: results are ordered newest-first (createdAt desc)
 * SB5: query is scoped to the calling tenant only
 * SB6: each batch row includes id, month, totalRows, acceptedCount, createdAt
 * SB7: returns empty array when tenant has no batches
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    salesUploadBatch: {
      findMany: vi.fn(),
    },
  },
}));
vi.mock('@/lib/auth', () => ({ getAuthUser: vi.fn() }));
vi.mock('@/lib/tenant', () => ({ getClientIdFromRequest: vi.fn() }));

import { GET } from '../route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

function makeRequest(clientId = 'tenant-abc') {
  return { headers: { get: () => null }, url: 'http://localhost/api/admin/sales/batches' } as any;
}

const MOCK_BATCHES = [
  {
    id: 'batch_2',
    clientId: 'tenant-abc',
    month: '2026-06',
    totalRows: 120,
    acceptedCount: 118,
    rejectedCount: 2,
    status: 'COMPLETED',
    createdAt: new Date('2026-06-10T09:00:00Z'),
    uploadedBy: { id: 'u_1', name: 'Admin User' },
  },
  {
    id: 'batch_1',
    clientId: 'tenant-abc',
    month: '2026-05',
    totalRows: 100,
    acceptedCount: 100,
    rejectedCount: 0,
    status: 'COMPLETED',
    createdAt: new Date('2026-05-08T11:00:00Z'),
    uploadedBy: { id: 'u_1', name: 'Admin User' },
  },
];

describe('GET /api/admin/sales/batches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_1', role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('tenant-abc');
    (prisma.salesUploadBatch.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_BATCHES);
  });

  it('SB1: returns 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('SB2: returns 403 when role is SALES_XSR (not admin)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_2', role: 'SALES_XSR' });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('SB3: returns 200 with batch list', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('SB4: results include newest batch first', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.data[0].id).toBe('batch_2');
    expect(body.data[1].id).toBe('batch_1');
  });

  it('SB5: query is scoped to calling tenant clientId', async () => {
    await GET(makeRequest());
    expect(prisma.salesUploadBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clientId: 'tenant-abc' }),
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('SB6: each batch row exposes required fields', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    const batch = body.data[0];
    expect(batch).toHaveProperty('id');
    expect(batch).toHaveProperty('month');
    expect(batch).toHaveProperty('totalRows');
    expect(batch).toHaveProperty('acceptedCount');
    expect(batch).toHaveProperty('createdAt');
    expect(batch).toHaveProperty('status');
  });

  it('SB7: returns empty array when no batches exist', async () => {
    (prisma.salesUploadBatch.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });
});
