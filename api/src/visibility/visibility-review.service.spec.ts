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
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  visibilityCapture: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  visibilityCaptureSubmission: { updateMany: jest.fn() },
  visibilityImageHash: { findMany: jest.fn() },
  visibilityFormVersion: { findUnique: jest.fn() },
  visibilityForm: { findUnique: jest.fn() },
  // Per-photo geotag: the review resolves the outlet reference geo (outlet → partner KYC).
  outlet: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  // Per-photo review persists the capture row + the version snapshot in one tx.
  $transaction: jest.fn(),
};

const mockTenant = { resolveVisibilityEnabled: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn() };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 't1', phone: '9', name: 'Admin' };
const notGifsy: JwtPayload = { sub: 'u2', role: 'CLIENT_ADMIN', clientId: 't1', phone: '9', name: 'CA' };

describe('VisibilityReviewService', () => {
  let service: VisibilityReviewService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    // Per-photo geotag defaults: a fence radius + no outlet reference geo (→ 'unverifiable').
    mockSettings.getEffectiveSettings.mockResolvedValue({
      visibilityConfig: { geoFence: { enabled: true, radiusMeters: 50 } },
    });
    mockPrisma.outlet.findFirst.mockResolvedValue(null);
    mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1',
      clientId: 't1',
      status: 'SUBMITTED',
      formVersion: 1,
      formValues: { photo: 'visibility-media/t1/x.jpg' },
      photoReviews: null,
    });
    // Single required CAMERA field, present in the capture → approve-ALL derives APPROVED.
    mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue({
      formSchema: { fields: [{ id: 'photo', type: 'CAMERA', label: 'Photo', required: true, order: 1 }] },
    });
    mockPrisma.visibilityCapture.update.mockImplementation((args: { data: unknown }) =>
      Promise.resolve({ id: 'cap1', ...(args.data as object) }),
    );
    mockPrisma.visibilityCaptureSubmission.updateMany.mockResolvedValue({ count: 1 });
    // Run the review transaction against the same mock (tx === mockPrisma) so the existing
    // assertions on visibilityCapture.update.mock.calls still hold.
    mockPrisma.$transaction.mockImplementation((cb: (tx: typeof mockPrisma) => unknown) =>
      Promise.resolve(cb(mockPrisma)),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityReviewService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
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

  // ── Per-photo review (VISIBILITY-PER-PHOTO-APPROVAL) ──────────────────────────
  describe('reviewPhoto + derived status', () => {
    // A two-required-photo form + a capture that submitted both photos (no reviews yet).
    const twoPhotoForm = {
      captureGpsOnSubmit: false,
      fields: [
        { id: 'front', type: 'CAMERA', label: 'Storefront', required: true, order: 1 },
        { id: 'shelf', type: 'CAMERA', label: 'Shelf', required: true, order: 2 },
      ],
    };
    const captureWith = (photoReviews: unknown, status = 'SUBMITTED') => ({
      id: 'cap1',
      clientId: 't1',
      outletId: 'o1',
      status,
      formVersion: 1,
      currentVersion: 1,
      formValues: { front: 'visibility-media/t1/front.jpg', shelf: 'visibility-media/t1/shelf.jpg' },
      photoReviews,
    });

    beforeEach(() => {
      mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue({ formSchema: twoPhotoForm });
    });

    it('sets per-photo state and derives SUBMITTED while a required photo is still pending', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureWith(null));
      const res = await service.reviewPhoto(gifsy, 'cap1', 'front', 'APPROVED');
      const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(data.photoReviews.front.status).toBe('APPROVED');
      expect(data.photoReviews.front.reviewedByUserId).toBe('admin1');
      // shelf still pending → not all approved → SUBMITTED.
      expect(data.status).toBe('SUBMITTED');
      expect(res.capture.status).toBe('SUBMITTED');
      // The version snapshot is updated too (trace).
      expect(mockPrisma.visibilityCaptureSubmission.updateMany).toHaveBeenCalled();
    });

    it('derives APPROVED only when every required photo is approved', async () => {
      // front already approved; approving shelf completes it.
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(
        captureWith({ front: { status: 'APPROVED', reviewedAt: 'x', reviewedByUserId: 'admin1' } }),
      );
      await service.reviewPhoto(gifsy, 'cap1', 'shelf', 'APPROVED');
      const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(data.status).toBe('APPROVED');
      expect(data.approvedByUserId).toBe('admin1');
    });

    it('derives CHANGES_REQUESTED when a required photo is rejected', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureWith(null));
      const res = await service.reviewPhoto(gifsy, 'cap1', 'shelf', 'REJECTED', 'BLURRY', 'out of focus');
      const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(data.status).toBe('CHANGES_REQUESTED');
      expect(data.photoReviews.shelf).toMatchObject({ status: 'REJECTED', reasonCode: 'BLURRY', reason: 'out of focus' });
      expect(res.capture.status).toBe('CHANGES_REQUESTED');
    });

    it('a rejected photo never lets the window be satisfied (never APPROVED)', async () => {
      // shelf rejected, then front approved → still CHANGES_REQUESTED (not APPROVED).
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(
        captureWith({ shelf: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: 'x', reviewedByUserId: 'admin1' } }),
      );
      await service.reviewPhoto(gifsy, 'cap1', 'front', 'APPROVED');
      const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(data.status).toBe('CHANGES_REQUESTED');
    });

    it('rejects a per-photo REJECTED without a valid reason code', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureWith(null));
      await expect(service.reviewPhoto(gifsy, 'cap1', 'shelf', 'REJECTED', 'NOPE')).rejects.toThrow(BadRequestException);
    });

    it('rejects reviewing a field that is not a CAMERA field of the form', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureWith(null));
      await expect(service.reviewPhoto(gifsy, 'cap1', 'ghost', 'APPROVED')).rejects.toThrow(BadRequestException);
    });

    it('403s reviewPhoto for a non-GIFSY caller', async () => {
      await expect(service.reviewPhoto(notGifsy, 'cap1', 'front', 'APPROVED')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('approve-ALL / reject-ALL with per-photo state', () => {
    const twoPhotoForm = {
      captureGpsOnSubmit: false,
      fields: [
        { id: 'front', type: 'CAMERA', label: 'Storefront', required: true, order: 1 },
        { id: 'shelf', type: 'CAMERA', label: 'Shelf', required: true, order: 2 },
      ],
    };
    beforeEach(() => {
      mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue({ formSchema: twoPhotoForm });
    });

    it('approve-ALL is refused when a photo is currently rejected (must re-capture first)', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        id: 'cap1',
        clientId: 't1',
        outletId: 'o1',
        status: 'CHANGES_REQUESTED',
        formVersion: 1,
        currentVersion: 1,
        formValues: { front: 'visibility-media/t1/front.jpg', shelf: 'visibility-media/t1/shelf.jpg' },
        photoReviews: { shelf: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: 'x', reviewedByUserId: 'admin1' } },
      });
      await expect(service.approve(gifsy, 'cap1')).rejects.toThrow(BadRequestException);
    });

    it('approve-ALL writes an APPROVED review for every present photo + APPROVED status', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        id: 'cap1',
        clientId: 't1',
        outletId: 'o1',
        status: 'SUBMITTED',
        formVersion: 1,
        currentVersion: 1,
        formValues: { front: 'visibility-media/t1/front.jpg', shelf: 'visibility-media/t1/shelf.jpg' },
        photoReviews: null,
      });
      const res = await service.approve(gifsy, 'cap1');
      const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(res.capture.status).toBe('APPROVED');
      expect(data.photoReviews.front.status).toBe('APPROVED');
      expect(data.photoReviews.shelf.status).toBe('APPROVED');
    });
  });

  // ── Back-compat: a single-photo capture approve/reject == today ────────────────
  describe('single-photo capture is identical to today', () => {
    const onePhotoForm = {
      captureGpsOnSubmit: false,
      fields: [{ id: 'photo', type: 'CAMERA', label: 'Shelf', required: true, order: 1 }],
    };
    beforeEach(() => {
      mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue({ formSchema: onePhotoForm });
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        id: 'cap1',
        clientId: 't1',
        outletId: 'o1',
        status: 'SUBMITTED',
        formVersion: 1,
        currentVersion: 1,
        formValues: { photo: 'visibility-media/t1/p.jpg' },
        photoReviews: null,
      });
    });

    it('approve → APPROVED (same terminal state as before)', async () => {
      const res = await service.approve(gifsy, 'cap1');
      expect(res.capture.status).toBe('APPROVED');
      expect(mockPrisma.visibilityCapture.update.mock.calls[0][0].data.approvedByUserId).toBe('admin1');
    });

    it('reject → REJECTED (whole-capture reject, same as before)', async () => {
      const res = await service.reject(gifsy, 'cap1', 'POSM_NOT_VISIBLE', 'no material');
      const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(res.capture.status).toBe('REJECTED');
      expect(data.rejectionReasonCode).toBe('POSM_NOT_VISIBLE');
      expect(data.photoReviews.photo.status).toBe('REJECTED');
    });
  });
});
