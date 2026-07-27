/**
 * Unit tests for visibility-review.service.ts (Stream B).
 *
 * Covers: approve/reject status transitions, reject-reason-code validation, GIFSY-only
 * gate, and adminGetCapture surfacing cross-outlet duplicate-photo matches. Prisma +
 * TenantService mocked.
 *
 * Run: npx jest src/visibility/visibility-review.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { VisibilityReviewService, VISIBILITY_REJECT_REASONS } from './visibility-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  visibilityCapture: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  visibilityImageHash: { findMany: jest.fn() },
  visibilityFormVersion: { findUnique: jest.fn() },
  visibilityForm: { findUnique: jest.fn() },
};

const mockTenant = { resolveVisibilityEnabled: jest.fn() };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 't1', phone: '9', name: 'Admin' };
const notGifsy: JwtPayload = { sub: 'u2', role: 'CLIENT_ADMIN', clientId: 't1', phone: '9', name: 'CA' };

describe('VisibilityReviewService', () => {
  let service: VisibilityReviewService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1',
      clientId: 't1',
      status: 'SUBMITTED',
    });
    mockPrisma.visibilityCapture.update.mockImplementation((args: { data: unknown }) =>
      Promise.resolve({ id: 'cap1', ...(args.data as object) }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityReviewService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
      ],
    }).compile();
    service = module.get(VisibilityReviewService);
  });

  it('exposes the controlled reject-reason vocabulary', () => {
    expect(VISIBILITY_REJECT_REASONS).toEqual(
      expect.arrayContaining(['BLURRY', 'WRONG_OUTLET', 'POSM_NOT_VISIBLE', 'GEO_MISMATCH', 'OTHER']),
    );
  });

  // ── Gate ─────────────────────────────────────────────────────────────────────
  it('403s approve/reject for a non-GIFSY caller', async () => {
    await expect(service.approve(notGifsy, 'cap1')).rejects.toThrow(ForbiddenException);
    await expect(service.reject(notGifsy, 'cap1', 'BLURRY')).rejects.toThrow(ForbiddenException);
  });

  it('403s when visibilityEnabled is OFF', async () => {
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
    await expect(service.approve(gifsy, 'cap1')).rejects.toThrow(ForbiddenException);
  });

  // ── Approve ──────────────────────────────────────────────────────────────────
  it('approve transitions to APPROVED + records the reviewer', async () => {
    const res = await service.approve(gifsy, 'cap1');
    expect(res.capture.status).toBe('APPROVED');
    const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
    expect(data.approvedByUserId).toBe('admin1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('rejects approving an already-approved capture', async () => {
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ id: 'cap1', clientId: 't1', status: 'APPROVED' });
    await expect(service.approve(gifsy, 'cap1')).rejects.toThrow(BadRequestException);
  });

  // ── Reject ───────────────────────────────────────────────────────────────────
  it('reject validates the reason code against the vocabulary', async () => {
    await expect(service.reject(gifsy, 'cap1', 'NOT_A_REASON')).rejects.toThrow(BadRequestException);
  });

  it('reject transitions to REJECTED with the code + optional detail (re-opens window)', async () => {
    const res = await service.reject(gifsy, 'cap1', 'POSM_NOT_VISIBLE', 'no material on shelf');
    expect(res.capture.status).toBe('REJECTED');
    const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
    expect(data.rejectionReasonCode).toBe('POSM_NOT_VISIBLE');
    expect(data.rejectionReason).toBe('no material on shelf');
  });

  it('refuses to reject an approved capture', async () => {
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ id: 'cap1', clientId: 't1', status: 'APPROVED' });
    await expect(service.reject(gifsy, 'cap1', 'BLURRY')).rejects.toThrow(BadRequestException);
  });

  // ── Admin detail: dup matches ──────────────────────────────────────────────────
  it('adminGetCapture surfaces cross-outlet duplicate-photo matches', async () => {
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1',
      clientId: 't1',
      status: 'SUBMITTED',
      formVersion: 1,
      formValues: { photo: 'visibility-media/t1/x.jpg', geo: { lat: 12.9, lng: 77.5 } },
      geoFenceOk: true,
      distanceMeters: 12,
      captureLat: 12.9,
      captureLng: 77.5,
      captureAccuracy: 10,
      submissions: [],
      imageHashes: [{ hash: 'hashA' }],
      submittedBy: { id: 'su1', employeeCode: 'E1' },
      approvedBy: null,
    });
    mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue({
      formSchema: {
        captureGpsOnSubmit: true,
        fields: [
          { id: 'photo', type: 'CAMERA', label: 'Shelf', required: true, order: 1 },
          { id: 'geo', type: 'GPS_POINT', label: 'Location', required: false, order: 2 },
        ],
      },
    });
    mockPrisma.visibilityImageHash.findMany.mockResolvedValue([
      { hash: 'hashA', captureId: 'cap2', capture: { outletCode: 'OC2', windowKey: '2026-07-P1' } },
    ]);

    const res = await service.adminGetCapture(gifsy, 'cap1');
    expect(res.capture.media).toHaveLength(1);
    expect(res.capture.media[0].viewPath).toContain('/v1/visibility/captures/media?key=');
    expect(res.capture.geo).toHaveLength(1);
    expect(res.capture.duplicateMatches).toEqual([
      { hash: 'hashA', captureId: 'cap2', outletCode: 'OC2', windowKey: '2026-07-P1' },
    ]);
  });

  // ── List ─────────────────────────────────────────────────────────────────────
  it('adminListCaptures scopes by clientId + applies filters', async () => {
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    mockPrisma.visibilityCapture.count.mockResolvedValue(0);
    await service.adminListCaptures(gifsy, { windowKey: '2026-07-P1', status: 'SUBMITTED', outletCode: 'OC1' });
    const where = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ clientId: 't1', windowKey: '2026-07-P1', status: 'SUBMITTED', outletCode: 'OC1' });
  });
});
