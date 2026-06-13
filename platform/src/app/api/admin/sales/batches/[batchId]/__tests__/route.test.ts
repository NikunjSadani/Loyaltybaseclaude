/// <reference types="vitest/globals" />
/**
 * TDD — DELETE /api/admin/sales/batches/[batchId]
 *
 * SD1: 401 when unauthenticated
 * SD2: 403 when role is not CLIENT_ADMIN or GIFSY_ADMIN
 * SD3: 404 when batchId does not exist
 * SD4: 403 when batch belongs to a different tenant (cross-tenant guard)
 * SD5: 200 and deletes the batch (OutletSalesRecord cascade handled by DB)
 * SD6: response includes deletedBatchId and deletedRecordCount
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    salesUploadBatch: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    outletSalesRecord: {
      count: vi.fn(),
    },
  },
}));
vi.mock('@/lib/auth', () => ({ getAuthUser: vi.fn() }));
vi.mock('@/lib/tenant', () => ({ getClientIdFromRequest: vi.fn() }));

import { DELETE } from '../route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

function makeRequest(batchId = 'batch_1') {
  return {
    headers: { get: () => null },
    url: `http://localhost/api/admin/sales/batches/${batchId}`,
  } as any;
}

function makeParams(batchId = 'batch_1') {
  return Promise.resolve({ batchId });
}

const MOCK_BATCH = {
  id: 'batch_1',
  clientId: 'tenant-abc',
  month: '2026-05',
  totalRows: 100,
  acceptedCount: 100,
  status: 'COMPLETED',
  createdAt: new Date('2026-05-08T11:00:00Z'),
};

describe('DELETE /api/admin/sales/batches/[batchId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_1', role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('tenant-abc');
    (prisma.salesUploadBatch.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_BATCH);
    (prisma.outletSalesRecord.count as ReturnType<typeof vi.fn>).mockResolvedValue(100);
    (prisma.salesUploadBatch.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_BATCH);
  });

  it('SD1: returns 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(401);
  });

  it('SD2: returns 403 when role is SALES_XSR', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_2', role: 'SALES_XSR' });
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(403);
  });

  it('SD3: returns 404 when batchId does not exist', async () => {
    (prisma.salesUploadBatch.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(makeRequest('nonexistent'), { params: makeParams('nonexistent') });
    expect(res.status).toBe(404);
  });

  it('SD4: returns 403 when batch belongs to a different tenant', async () => {
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('other-tenant');
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(403);
  });

  it('SD5: returns 200 and calls prisma.salesUploadBatch.delete', async () => {
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(200);
    expect(prisma.salesUploadBatch.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'batch_1' } }),
    );
  });

  it('SD6: response includes deletedBatchId and deletedRecordCount', async () => {
    const res = await DELETE(makeRequest(), { params: makeParams() });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.deletedBatchId).toBe('batch_1');
    expect(body.data.deletedRecordCount).toBe(100);
  });
});
