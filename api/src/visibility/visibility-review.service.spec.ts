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
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VisibilityReviewService, VISIBILITY_REJECT_REASONS, CAPTURE_CHANGED_MESSAGE } from './visibility-review.service';
import { IMPORTED_REVIEW_ACTOR_LABEL } from './visibility-review-events';
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
  // The per-photo badge policy reads clients.features.outletMasterGeo (default: not set → legacy KYC-board policy).
  client: { findUnique: jest.fn() },
  // Permanent review history (append-only) + reviewer-name fallback.
  visibilityReviewEvent: { createMany: jest.fn(), findMany: jest.fn() },
  user: { findMany: jest.fn() },
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
    mockPrisma.client.findUnique.mockResolvedValue(null);
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
    mockPrisma.visibilityReviewEvent.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.visibilityReviewEvent.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
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

  // ── Programme / sub-programme (review-layout, 2026-11-19) — additive fields ──────
  it('adminListCaptures adds the outlet programme + sub-programme to each row (flattened, no nested outlet)', async () => {
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      { id: 'cap1', outletCode: 'OC1', windowKey: '2020-01-P1', status: 'SUBMITTED', outlet: { programName: 'Unnati', programCategory: 'Elite', state: ' Maharashtra ', zone: 'West' } },
      { id: 'cap2', outletCode: 'OC2', windowKey: '2020-01-P1', status: 'SUBMITTED', outlet: { programName: null, programCategory: null, state: '', zone: null } },
    ]);
    mockPrisma.visibilityCapture.count.mockResolvedValue(2);
    const res = await service.adminListCaptures(gifsy, {});
    const select = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].select;
    expect(select.outlet).toEqual({ select: { programName: true, programCategory: true, state: true, zone: true } });
    // Existing fields still selected (additive change).
    expect(select).toMatchObject({ id: true, outletCode: true, geoFenceOk: true, photoReviews: true });
    expect(res.captures[0]).toEqual({
      id: 'cap1', outletCode: 'OC1', windowKey: '2020-01-P1', status: 'SUBMITTED', programName: 'Unnati', programCategory: 'Elite', outletState: 'Maharashtra', outletZone: 'West',
      windowClosed: true,
    });
    expect(res.captures[1]).toMatchObject({ programName: null, programCategory: null, outletState: null, outletZone: null });
    expect(res.captures[0]).not.toHaveProperty('outlet');
  });

  it('adminListCaptures: windowClosed per row (IST, tenant frequency) — the queue words a closed re-take "Not approved — window closed"', async () => {
    const s = new Date(Date.now() + 330 * 60_000);
    const thisMonthP1 = `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-P1`;
    mockSettings.getEffectiveSettings.mockResolvedValue({
      visibilityConfig: { geoFence: { enabled: true, radiusMeters: 50 }, frequencyPerMonth: 1 },
    });
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      { id: 'open', windowKey: thisMonthP1, status: 'CHANGES_REQUESTED', outlet: null },
      { id: 'closed', windowKey: '2020-01-P1', status: 'CHANGES_REQUESTED', outlet: null },
    ]);
    mockPrisma.visibilityCapture.count.mockResolvedValue(2);
    const res = await service.adminListCaptures(gifsy, {});
    expect(res.captures.map((c: { id: string; windowClosed: boolean }) => [c.id, c.windowClosed])).toEqual([
      ['open', false],
      ['closed', true],
    ]);
  });

  it('adminGetCapture adds the outlet programme + sub-programme (null-safe when absent)', async () => {
    mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1', clientId: 't1', outletId: 'o1', status: 'SUBMITTED', formVersion: 1,
      formValues: { photo: 'visibility-media/t1/x.jpg' }, photoReviews: null,
      geoFenceOk: null, distanceMeters: null, captureLat: null, captureLng: null, captureAccuracy: null,
      submissions: [], imageHashes: [], submittedBy: null, approvedBy: null,
      outlet: { programName: 'SAMT', programCategory: 'Privilege', state: 'Punjab', zone: 'North' },
    });
    const res = await service.adminGetCapture(gifsy, 'cap1');
    const include = mockPrisma.visibilityCapture.findFirst.mock.calls[0][0].include;
    expect(include.outlet).toEqual({ select: { programName: true, programCategory: true, state: true, zone: true } });
    expect(res.capture.programName).toBe('SAMT');
    expect(res.capture.programCategory).toBe('Privilege');
    expect(res.capture.outletState).toBe('Punjab');
    expect(res.capture.outletZone).toBe('North');
    expect(res.capture).not.toHaveProperty('outlet');
    // Existing detail shape intact.
    expect(res.capture.media).toHaveLength(1);

    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1', clientId: 't1', outletId: 'o1', status: 'SUBMITTED', formVersion: 1,
      formValues: {}, photoReviews: null, submissions: [], imageHashes: [], submittedBy: null, approvedBy: null,
    });
    const bare = await service.adminGetCapture(gifsy, 'cap1');
    expect(bare.capture.programName).toBeNull();
    expect(bare.capture.programCategory).toBeNull();
    expect(bare.capture.outletState).toBeNull();
    expect(bare.capture.outletZone).toBeNull();
  });

  // ── Per-photo review (VISIBILITY-PER-PHOTO-APPROVAL) ──────────────────────────
  // ── Per-photo badges use the capture verdict's policy (prod finding 2026-11-19) ─────────────────────────────
  describe('per-photo fence badges', () => {
    const bajajCapture = {
      id: 'cap1', clientId: 't1', outletId: 'o1', status: 'SUBMITTED', formVersion: 1, photoReviews: null,
      geoFenceOk: true, distanceMeters: 34, captureLat: 12.9003, captureLng: 77.5001, captureAccuracy: 20,
      formValues: { wtk11hn: { key: 'visibility-media/t1/w1.jpg', geo: { lat: 12.9003, lng: 77.5001, accuracy: 20 } } },
      submissions: [], imageHashes: [], submittedBy: null, approvedBy: null,
    };
    const privilegeOnly = { op: 'eq', value: 'Privilege', fieldId: '__subProgram__' };
    const bajajSchema = {
      formSchema: { fields: [
        { id: 'wtk11hn', type: 'CAMERA', label: 'Window 1', required: true, order: 1, geotag: true, geoFenceRequired: true },
        { id: 'np9d0cc', type: 'CAMERA', label: 'Window 2', required: false, order: 3, geotag: true, geoFenceRequired: true, visibleWhen: privilegeOnly, requiredWhen: privilegeOnly },
      ] },
    };
    beforeEach(() => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(bajajCapture);
      mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue(bajajSchema);
      mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
    });

    it('outlet-master tenant: Elite outlet, Window 1 at 34 m / ±20 m → badge "inside" (matches the verdict true); hidden Window 2 has no badge', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ features: { outletMasterGeo: true } });
      mockPrisma.outlet.findFirst.mockResolvedValue({ latitude: 12.9, longitude: 77.5 });
      // The legacy KYC board reference is far away — it must NOT be used on an outlet-master tenant.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [{ boardPhotoLat: 13.5, boardPhotoLng: 78.5 }] });
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(res.capture.media.map((m: { fieldId: string }) => m.fieldId)).toEqual(['wtk11hn']);
      expect(res.capture.media[0].fenceStatus).toBe('inside');
      expect(res.capture.geoFence.geoFenceOk).toBe(true);
    });

    it('outlet-master tenant: a fix with accuracy worse than 200 m → badge "unverifiable" (same buffer as the verdict)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ features: { outletMasterGeo: true } });
      mockPrisma.outlet.findFirst.mockResolvedValue({ latitude: 12.9, longitude: 77.5 });
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        ...bajajCapture,
        formValues: { wtk11hn: { key: 'visibility-media/t1/w1.jpg', geo: { lat: 12.9003, lng: 77.5001, accuracy: 350 } } },
      });
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(res.capture.media[0].fenceStatus).toBe('unverifiable');
    });

    it('NON-gated tenant: unchanged — KYC board reference + configured 50 m radius, no buffer', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [{ boardPhotoLat: 12.9, boardPhotoLng: 77.5 }] });
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(res.capture.media[0].fenceStatus).toBe('inside'); // 34 m < 50 m against the KYC board geo
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [{ boardPhotoLat: 12.9006, boardPhotoLng: 77.5 }] });
      mockPrisma.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      const far = await service.adminGetCapture(gifsy, 'cap1');
      // ~33 m from the photo — still inside 50 m; the outlet-master path was not consulted.
      expect(far.capture.media[0].fenceStatus).toBe('inside');
      expect(mockPrisma.outlet.findFirst.mock.calls.every(([a]: [{ select?: Record<string, unknown> }]) => !a.select?.latitude)).toBe(true);
    });
  });

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

  // ── Permanent review history (visibility_review_events) ─────────────────────────
  describe('review history events', () => {
    const twoPhotoForm = {
      fields: [
        { id: 'front', type: 'CAMERA', label: 'Storefront', required: true, order: 1 },
        { id: 'shelf', type: 'CAMERA', label: 'Shelf', required: true, order: 2 },
      ],
    };
    const cap = (status = 'SUBMITTED', photoReviews: unknown = null) => ({
      id: 'cap1', clientId: 't1', outletId: 'o1', windowKey: '2026-11-P1', status, formVersion: 1, currentVersion: 2,
      formValues: { front: 'visibility-media/t1/front.jpg', shelf: 'visibility-media/t1/shelf.jpg' },
      photoReviews,
    });
    const events = () => mockPrisma.visibilityReviewEvent.createMany.mock.calls.flatMap((c) => c[0].data);
    beforeEach(() => {
      mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue({ formSchema: twoPhotoForm });
    });

    it('per-photo reject writes PHOTO_REJECTED (label, reason, reviewer name) + CHANGES_REQUESTED_RESULT in the SAME tx', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(cap());
      // Assert the event write happens inside the transaction callback.
      let insideTx = false;
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => unknown) => {
        insideTx = true;
        try { return await cb(mockPrisma); } finally { insideTx = false; }
      });
      mockPrisma.visibilityReviewEvent.createMany.mockImplementation(() => {
        expect(insideTx).toBe(true);
        return Promise.resolve({ count: 2 });
      });
      await service.reviewPhoto(gifsy, 'cap1', 'shelf', 'REJECTED', 'BLURRY', 'out of focus');
      expect(events()).toEqual([
        expect.objectContaining({
          clientId: 't1', captureId: 'cap1', outletId: 'o1', windowKey: '2026-11-P1', version: 2,
          action: 'PHOTO_REJECTED', statusAfter: 'CHANGES_REQUESTED', fieldId: 'shelf', fieldLabel: 'Shelf',
          reasonCode: 'BLURRY', reason: 'out of focus', actorUserId: 'admin1', actorName: 'Admin',
        }),
        expect.objectContaining({ action: 'CHANGES_REQUESTED_RESULT', statusAfter: 'CHANGES_REQUESTED', fieldId: null }),
      ]);
    });

    it('a second rejection while already Needs re-take does NOT repeat CHANGES_REQUESTED_RESULT', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(
        cap('CHANGES_REQUESTED', { shelf: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: 'x', reviewedByUserId: 'admin1' } }),
      );
      await service.reviewPhoto(gifsy, 'cap1', 'front', 'REJECTED', 'OTHER');
      expect(events().map((e: { action: string }) => e.action)).toEqual(['PHOTO_REJECTED']);
    });

    it('per-photo approve writes PHOTO_APPROVED with no reason', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(cap());
      await service.reviewPhoto(gifsy, 'cap1', 'front', 'APPROVED');
      expect(events()).toEqual([
        expect.objectContaining({ action: 'PHOTO_APPROVED', fieldId: 'front', reasonCode: null, reason: null, statusAfter: 'SUBMITTED' }),
      ]);
    });

    it('approve-all writes ONE CAPTURE_APPROVED_ALL; reject-all writes ONE CAPTURE_REJECTED_ALL with the reason', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(cap());
      await service.approve(gifsy, 'cap1');
      expect(events()).toEqual([expect.objectContaining({ action: 'CAPTURE_APPROVED_ALL', statusAfter: 'APPROVED', actorName: 'Admin' })]);
      mockPrisma.visibilityReviewEvent.createMany.mockClear();
      await service.reject(gifsy, 'cap1', 'WRONG_OUTLET', 'different shop');
      expect(events()).toEqual([
        expect.objectContaining({ action: 'CAPTURE_REJECTED_ALL', statusAfter: 'REJECTED', reasonCode: 'WRONG_OUTLET', reason: 'different shop' }),
      ]);
    });

    it('no event is written when the review is refused', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(cap('APPROVED'));
      await expect(service.reviewPhoto(gifsy, 'cap1', 'front', 'APPROVED')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.visibilityReviewEvent.createMany).not.toHaveBeenCalled();
    });

    it('adminGetCapture returns the history newest-first with names (current-name fallback) + lastReview of the current version', async () => {
      mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        ...cap('CHANGES_REQUESTED'), submissions: [], imageHashes: [], submittedBy: null, approvedBy: null,
      });
      const at = (m: number) => new Date(Date.now() - m * 60_000);
      mockPrisma.visibilityReviewEvent.findMany.mockResolvedValue([
        { id: 'e3', version: 2, action: 'PHOTO_REJECTED', statusAfter: 'CHANGES_REQUESTED', fieldId: 'shelf', fieldLabel: 'Shelf', reasonCode: 'BLURRY', reason: null, actorUserId: 'admin9', actorName: null, backfilled: true, createdAt: at(1) },
        { id: 'e2', version: 2, action: 'RESUBMITTED', statusAfter: 'SUBMITTED', fieldId: null, fieldLabel: null, reasonCode: null, reason: null, actorUserId: 'rep1', actorName: 'Rep One', backfilled: false, createdAt: at(5) },
        { id: 'e1', version: 1, action: 'CAPTURE_REJECTED_ALL', statusAfter: 'REJECTED', fieldId: null, fieldLabel: null, reasonCode: 'OTHER', reason: null, actorUserId: 'admin1', actorName: 'Admin', backfilled: false, createdAt: at(10) },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'admin9', name: 'Later Name' }]);
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(mockPrisma.visibilityReviewEvent.findMany.mock.calls[0][0].where).toEqual({ clientId: 't1', captureId: 'cap1' });
      expect(res.capture.reviewHistory.map((e: { id: string }) => e.id)).toEqual(['e3', 'e2', 'e1']);
      expect(res.capture.reviewHistory[0].actorName).toBe('Later Name');
      expect(res.capture.lastReview).toMatchObject({ actorName: 'Later Name', action: 'PHOTO_REJECTED' });
    });

    // ── L2: lost-update guard + idempotent repeat approve ──────────────────────────
    it('the write is conditional on the row as read (status + version + updatedAt)', async () => {
      const updatedAt = new Date('2026-11-20T10:00:00.000Z');
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ ...cap(), updatedAt });
      await service.reviewPhoto(gifsy, 'cap1', 'front', 'APPROVED');
      expect(mockPrisma.visibilityCapture.update.mock.calls[0][0].where).toEqual({
        id: 'cap1', status: 'SUBMITTED', currentVersion: 2, updatedAt,
      });
    });

    it('a review that lost the race (row changed meanwhile) → 409 "reload", and NO event is written', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ ...cap(), updatedAt: new Date() });
      mockPrisma.visibilityCapture.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'x' }),
      );
      const err = await service.reject(gifsy, 'cap1', 'BLURRY').catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe(CAPTURE_CHANGED_MESSAGE);
      expect(mockPrisma.visibilityReviewEvent.createMany).not.toHaveBeenCalled();
    });

    it('approving a photo that is ALREADY approved writes nothing (no second event)', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(
        cap('SUBMITTED', { front: { status: 'APPROVED', reviewedAt: '2026-11-20T09:00:00.000Z', reviewedByUserId: 'admin1' } }),
      );
      await service.reviewPhoto(gifsy, 'cap1', 'front', 'APPROVED');
      expect(mockPrisma.visibilityCapture.update).not.toHaveBeenCalled();
      expect(mockPrisma.visibilityReviewEvent.createMany).not.toHaveBeenCalled();
    });

    // ── B1: imported old-app captures never show the importing admin ───────────────
    it('an imported capture (photo under /vendor-import/) shows the old-app label, never the admin', async () => {
      mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        ...cap('APPROVED'),
        formValues: { front: 'visibility-media/bajaj/vendor-import/prod/b/OUT1/2025-06_v1.jpg' },
        approvedByUserId: 'admin1',
        submissions: [], imageHashes: [], submittedBy: null, approvedBy: { id: 'admin1', name: 'Gifsy Admin' },
      });
      mockPrisma.visibilityReviewEvent.findMany.mockResolvedValue([
        // Even a row that names the admin (e.g. written before the fix) is shown as the old app's approval.
        { id: 'e1', version: 2, action: 'CAPTURE_APPROVED_ALL', statusAfter: 'APPROVED', fieldId: null, fieldLabel: null, reasonCode: null, reason: null, actorUserId: 'admin1', actorName: 'Gifsy Admin', backfilled: true, createdAt: new Date('2025-06-20T06:30:00.000Z') },
      ]);
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(res.capture.imported).toBe(true);
      expect(res.capture.approvedBy).toBeNull();
      expect(res.capture.approvedByUserId).toBeNull();
      expect(res.capture.reviewHistory[0]).toMatchObject({ actorName: IMPORTED_REVIEW_ACTOR_LABEL, actorUserId: null });
      expect(res.capture.lastReview).toMatchObject({ actorName: IMPORTED_REVIEW_ACTOR_LABEL, actorUserId: null });
      expect(JSON.stringify(res.capture.reviewHistory)).not.toContain('Gifsy Admin');
    });

    it('same-timestamp events come back in a fixed order (result above the photo decision)', async () => {
      mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        ...cap('CHANGES_REQUESTED'), submissions: [], imageHashes: [], submittedBy: null, approvedBy: null,
      });
      const t = new Date('2026-11-20T10:00:00.000Z');
      const ev = (id: string, action: string) => ({ id, version: 2, action, statusAfter: 'CHANGES_REQUESTED', fieldId: null, fieldLabel: null, reasonCode: null, reason: null, actorUserId: 'admin1', actorName: 'Admin', backfilled: false, createdAt: t });
      // DB order by random id puts the photo decision first; the API must not depend on that.
      mockPrisma.visibilityReviewEvent.findMany.mockResolvedValue([ev('zzz', 'PHOTO_REJECTED'), ev('aaa', 'CHANGES_REQUESTED_RESULT')]);
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(res.capture.reviewHistory.map((e: { action: string }) => e.action)).toEqual(['CHANGES_REQUESTED_RESULT', 'PHOTO_REJECTED']);
    });

    it('lastReview is null when the current version has not been reviewed yet', async () => {
      mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
        ...cap('SUBMITTED'), submissions: [], imageHashes: [], submittedBy: null, approvedBy: null,
      });
      mockPrisma.visibilityReviewEvent.findMany.mockResolvedValue([
        { id: 'e2', version: 2, action: 'RESUBMITTED', statusAfter: 'SUBMITTED', fieldId: null, fieldLabel: null, reasonCode: null, reason: null, actorUserId: 'rep1', actorName: 'Rep', backfilled: false, createdAt: new Date() },
        { id: 'e1', version: 1, action: 'CAPTURE_REJECTED_ALL', statusAfter: 'REJECTED', fieldId: null, fieldLabel: null, reasonCode: 'OTHER', reason: null, actorUserId: 'admin1', actorName: 'Admin', backfilled: false, createdAt: new Date(Date.now() - 60_000) },
      ]);
      const res = await service.adminGetCapture(gifsy, 'cap1');
      expect(res.capture.lastReview).toBeNull();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
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
