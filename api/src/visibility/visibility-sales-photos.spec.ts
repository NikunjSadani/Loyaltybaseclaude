/**
 * Sales photo view (owner 2026-11-24) — TENANT-SCOPED via visibilityConfig.salesPhotoViewLevels.
 *
 * Covers: the outlet-status photos (level allowed vs not, reach 403, current month only, OFF = byte-identical),
 * the on-demand GET sales/captures/:id/photos (403 / 404 / old month), the media-stream tightening for SALES callers
 * (in reach + current month allowed; out of reach / old month / old version / level not listed → 403; the rep's own
 * pre-submit read-back + form sample images still allowed; admin + OFF tenants untouched), and the pure builder.
 *
 * Run: npx jest src/visibility/visibility-sales-photos.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { VisibilityCaptureService } from './visibility-capture.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { VisibilityMediaService } from './visibility-media.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { currentWindowKey, windowsForMonth } from './visibility-window.helper';
import { buildSalesCapturePhotos, mediaKeyRefWhere } from './visibility-sales-photos';

const mockPrisma = {
  client: { findUnique: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  outlet: { findFirst: jest.fn(), findMany: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  visibilityForm: { findUnique: jest.fn() },
  visibilityFormVersion: { findMany: jest.fn() },
  visibilityCapture: { findFirst: jest.fn(), findMany: jest.fn() },
  visibilityCaptureSubmission: { findFirst: jest.fn(), findMany: jest.fn() },
};
const mockMedia = { uploadMedia: jest.fn() };
const mockTenant = { resolveVisibilityEnabled: jest.fn(), resolveVisibilityCaptureMode: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn() };

const user: JwtPayload = { sub: 'u1', role: 'SALES_ASM', clientId: 't1', phone: '9', name: 'Asha' };
const admin: JwtPayload = { sub: 'a1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '8', name: 'Admin' };

const baseConfig = {
  outletScope: ['SSS'],
  frequencyPerMonth: 1,
  allowedSalesLevels: ['XSR', 'SO'],
  geoFence: { enabled: true, radiusMeters: 50 },
  programs: [],
  subPrograms: [],
};
const ON = { ...baseConfig, salesPhotoViewLevels: ['XSR', 'SO', 'ASM'] };

const CUR = currentWindowKey(new Date(), 1); // e.g. 2026-11-P1
const CUR_MONTH_KEYS = windowsForMonth(CUR.slice(0, 7), 1);
const OLD = '2020-01-P1';

const formSchema = {
  fields: [
    { id: 'w1', type: 'CAMERA', label: 'Window 1', required: true, order: 1, geoFenceRequired: true, sampleImageKey: 'visibility-media/t1/2026-01/sample.jpg' },
    { id: 'w2', type: 'CAMERA', label: 'Counter', required: false, order: 2 },
    { id: 'note', type: 'TEXT', label: 'Note', required: false, order: 3 },
  ],
};

const KEY1 = 'visibility-media/t1/2026-11/aaa-w1.jpg';
const KEY2 = 'visibility-media/t1/2026-11/bbb-w2.jpg';

function captureRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cap1',
    outletId: 'o1',
    windowKey: CUR,
    status: 'CHANGES_REQUESTED',
    currentVersion: 2,
    formVersion: 4,
    formValues: {
      w1: { key: KEY1, geo: { lat: 12.9, lng: 77.5, accuracy: 10, capturedAt: '2026-11-03T05:00:00.000Z' } },
      w2: KEY2,
      note: 'ok',
    },
    photoReviews: {
      w1: { status: 'APPROVED', reviewedAt: 'x', reviewedByUserId: 'g' },
      w2: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: 'x', reviewedByUserId: 'g' },
    },
    rejectionReason: null,
    rejectionReasonCode: null,
    receivedAt: new Date('2026-11-03T05:01:00.000Z'),
    submittedBy: { user: { name: 'Ravi ISR' } },
    ...over,
  };
}

describe('Sales photo view (salesPhotoViewLevels)', () => {
  let service: VisibilityCaptureService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: ON });
    mockPrisma.client.findUnique.mockResolvedValue({ features: {} });
    // Caller = ASM su1, whose downline holds o1 only.
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'ASM' } });
    mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null, userId: 'u1' }]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o1' }]);
    mockPrisma.outlet.findFirst.mockResolvedValue({
      id: 'o1', outletCode: 'OC1', name: 'Shop 1', partnerId: 'p1', isActive: true,
      programName: null, programCategory: null, outletType: { code: 'SSS', name: 'Retail' },
    });
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [{ boardPhotoLat: 12.9, boardPhotoLng: 77.5 }] });
    mockPrisma.visibilityForm.findUnique.mockResolvedValue({ formSchema });
    mockPrisma.visibilityFormVersion.findMany.mockResolvedValue([{ version: 4, formSchema }]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([captureRow()]);
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue(null);
    mockPrisma.visibilityCaptureSubmission.findFirst.mockResolvedValue(null);
    mockPrisma.visibilityCaptureSubmission.findMany.mockResolvedValue([]);
    mockMedia.uploadMedia.mockResolvedValue({ key: 'k' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityCaptureService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: {} },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
        { provide: VisibilityMediaService, useValue: mockMedia },
      ],
    }).compile();
    service = module.get(VisibilityCaptureService);
  });

  // ── Outlet card (GET outlet/:id/status) ──────────────────────────────────────────
  describe('getOutletStatus', () => {
    it('allowed level + in reach → the CURRENT version photos per window, with badges, reason, capturedBy — never GPS', async () => {
      const res = await service.getOutletStatus(user, 'o1');
      expect(res).toHaveProperty('photoView', true);
      const w = res.windows.find((x) => x.windowKey === CUR) as unknown as { photos: Record<string, unknown> };
      expect(w.photos).toMatchObject({
        captureId: 'cap1',
        version: 2,
        submittedBy: 'Ravi ISR',
        submittedAt: '2026-11-03T05:01:00.000Z',
        captureReason: null,
        windowClosed: false,
        photos: [
          { fieldId: 'w1', label: 'Window 1', mediaKey: KEY1, status: 'approved', reason: null, capturedAt: '2026-11-03T05:00:00.000Z', fenceStatus: 'inside' },
          { fieldId: 'w2', label: 'Counter', mediaKey: KEY2, status: 'needs_retake', reason: 'Photo is blurry / unclear' },
        ],
      });
      // Versions are read once for all this outlet's captures (by captureId — indexed), never per photo.
      expect(mockPrisma.visibilityCaptureSubmission.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.visibilityCaptureSubmission.findMany.mock.calls[0][0].where).toEqual({
        clientId: 't1', captureId: { in: ['cap1'] },
      });
      expect((w.photos.photos as Array<{ viewPath: string }>)[1].viewPath).toBe(
        `/v1/visibility/captures/media?key=${encodeURIComponent(KEY2)}`,
      );
      // No coordinates anywhere in the response.
      const json = JSON.stringify(res);
      expect(json).not.toMatch(/"lat"|"lng"|captureLat|captureLng|accuracy/);
    });

    it('reads only the CURRENT month windows (never another month)', async () => {
      await service.getOutletStatus(user, 'o1');
      const where = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where;
      expect(where.windowKey.in).toEqual(CUR_MONTH_KEYS);
      expect(where.windowKey.in).not.toContain(OLD);
    });

    it('level NOT in salesPhotoViewLevels → no photo keys at all', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...ON, salesPhotoViewLevels: ['XSR'] } });
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([
        { id: 'cap1', windowKey: CUR, status: 'SUBMITTED', currentVersion: 1, rejectionReason: null, photoReviews: null },
      ]);
      const res = await service.getOutletStatus(user, 'o1');
      expect(res).not.toHaveProperty('photoView');
      for (const w of res.windows) expect(w).not.toHaveProperty('photos');
    });

    it('outlet outside the caller team → 403 (unchanged reach rule)', async () => {
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o9' }]);
      await expect(service.getOutletStatus(user, 'o1')).rejects.toThrow(ForbiddenException);
    });

    it('setting UNSET (Deoleo) → byte-identical: the old select, no new keys', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: baseConfig });
      const row = { id: 'cap1', windowKey: CUR, status: 'SUBMITTED', currentVersion: 1, rejectionReason: null, photoReviews: null };
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([row]);
      const res = await service.getOutletStatus(user, 'o1');
      expect(mockPrisma.visibilityCapture.findMany.mock.calls[0][0].select).toEqual({
        id: true, windowKey: true, status: true, currentVersion: true, rejectionReason: true, photoReviews: true,
      });
      expect(Object.keys(res)).toEqual(['outlet', 'inScope', 'notInScopeReason', 'notApplicable', 'canCapture', 'windows']);
      const w = res.windows.find((x) => x.windowKey === CUR)!;
      expect(Object.keys(w)).toEqual([
        'windowKey', 'startDay', 'endDay', 'closed', 'captureId', 'status', 'currentVersion', 'rejectionReason', 'photoReviews', 'state',
      ]);
      expect(mockPrisma.visibilityFormVersion.findMany).not.toHaveBeenCalled();
    });
  });

  // ── Eligible list flag ───────────────────────────────────────────────────────────
  describe('getSalesEligible', () => {
    beforeEach(() => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'ASM' }, subordinates: [] });
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, outletType: { code: 'SSS', name: 'R' } },
      ]);
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    });

    it('ON for the level → a photoView flag only (photos are never inlined in the list)', async () => {
      const res = await service.getSalesEligible(user);
      expect(res).toHaveProperty('photoView', true);
      expect(res.outlets[0]).not.toHaveProperty('photos');
    });

    it('UNSET → no photoView key (byte-identical)', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: baseConfig });
      const res = await service.getSalesEligible(user);
      expect(res).not.toHaveProperty('photoView');
    });
  });

  // ── GET sales/captures/:captureId/photos ─────────────────────────────────────────
  describe('getSalesCapturePhotos', () => {
    beforeEach(() => mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureRow()));

    it('returns the current version photos for an in-reach current-month capture', async () => {
      const res = await service.getSalesCapturePhotos(user, 'cap1');
      expect(res.captureId).toBe('cap1');
      expect(res.photos.map((p) => p.status)).toEqual(['approved', 'needs_retake']);
      expect(mockPrisma.visibilityCapture.findFirst.mock.calls[0][0].where).toEqual({ id: 'cap1', clientId: 't1' });
    });

    it('level not listed → 403', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...ON, salesPhotoViewLevels: ['XSR'] } });
      await expect(service.getSalesCapturePhotos(user, 'cap1')).rejects.toThrow(ForbiddenException);
    });

    it("level not listed BUT the caller submitted this capture → its own photos are shown (A3)", async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...ON, salesPhotoViewLevels: ['XSR'] } });
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureRow({ submittedBySalesUserId: 'su1' }));
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o9' }]);
      await expect(service.getSalesCapturePhotos(user, 'cap1')).resolves.toMatchObject({ captureId: 'cap1' });
    });

    it('B3: a v2 merge — the carried-forward approved photo keeps its v1 time + submitter; the new photo is v2', async () => {
      // v1 (Asha SO, 2 Nov) held w1 + an old w2; v2 (Ravi ISR, 3 Nov) re-took w2 only, carrying w1 forward approved.
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(
        captureRow({
          formValues: { w1: KEY1, w2: KEY2 },
          photoReviews: { w1: { status: 'APPROVED', reviewedAt: 'x', reviewedByUserId: 'g' } },
          status: 'SUBMITTED',
        }),
      );
      mockPrisma.visibilityCaptureSubmission.findMany.mockResolvedValue([
        { captureId: 'cap1', version: 2, formValues: { w1: KEY1, w2: KEY2 }, createdAt: new Date('2026-11-03T05:01:00.000Z'), submittedBy: { user: { name: 'Ravi ISR' } } },
        { captureId: 'cap1', version: 1, formValues: { w1: KEY1, w2: 'visibility-media/t1/old.jpg' }, createdAt: new Date('2026-11-02T04:00:00.000Z'), submittedBy: { user: { name: 'Asha SO' } } },
      ]);
      const res = await service.getSalesCapturePhotos(user, 'cap1');
      expect(res.submittedBy).toBe('Ravi ISR');
      expect(res.photos).toEqual([
        expect.objectContaining({ fieldId: 'w1', status: 'approved', takenBy: 'Asha SO', capturedAt: '2026-11-02T04:00:00.000Z' }),
        expect.objectContaining({ fieldId: 'w2', status: 'pending', takenBy: 'Ravi ISR', capturedAt: '2026-11-03T05:01:00.000Z' }),
      ]);
    });

    it('feature OFF (unset) → 403', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: baseConfig });
      await expect(service.getSalesCapturePhotos(user, 'cap1')).rejects.toThrow(ForbiddenException);
    });

    it('unknown capture → 404', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(null);
      await expect(service.getSalesCapturePhotos(user, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('outlet outside the team → 403', async () => {
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o9' }]);
      await expect(service.getSalesCapturePhotos(user, 'cap1')).rejects.toThrow(ForbiddenException);
    });

    it('a capture of another month → 403', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue(captureRow({ windowKey: OLD }));
      await expect(service.getSalesCapturePhotos(user, 'cap1')).rejects.toThrow("Only this month's visibility photos can be viewed.");
    });
  });

  // ── Media-stream tightening (GET captures/media) — FAIL-CLOSED ───────────────────
  describe('assertSalesMediaAccess', () => {
    const CUR_MONTH = CUR.slice(0, 7);
    const OWN_KEY = `visibility-media/t1/u/u1/${CUR_MONTH}/abc-w1.jpg`;
    beforeEach(() => {
      // findMany here = the current-month lookup; default: KEY1 sits on cap1 (o1, in reach), submitted by someone else.
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([
        { outletId: 'o1', formValues: captureRow().formValues, submittedBySalesUserId: 'su9' },
      ]);
    });

    it('in reach + current month + level listed → allowed (indexed current-month lookup only)', async () => {
      await expect(service.assertSalesMediaAccess(user, KEY1)).resolves.toBeUndefined();
      const where = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where;
      expect(where.windowKey.in).toEqual(CUR_MONTH_KEYS);
      expect(where.OR).toEqual(mediaKeyRefWhere(['w1', 'w2'], KEY1));
      // No all-history scans any more.
      expect(mockPrisma.visibilityCapture.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.visibilityCaptureSubmission.findFirst).not.toHaveBeenCalled();
    });

    it('caches the field ids + team reach: a second image needs no form-version / hierarchy reads', async () => {
      await service.assertSalesMediaAccess(user, KEY1);
      await service.assertSalesMediaAccess(user, KEY2);
      expect(mockPrisma.visibilityFormVersion.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.visibilityCapture.findMany).toHaveBeenCalledTimes(2);
    });

    it('outlet out of reach → 403', async () => {
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o9' }]);
      await expect(service.assertSalesMediaAccess(user, KEY1)).rejects.toThrow(ForbiddenException);
    });

    it('level not listed → 403', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...ON, salesPhotoViewLevels: ['XSR'] } });
      await expect(service.assertSalesMediaAccess(user, KEY1)).rejects.toThrow(ForbiddenException);
    });

    it('A3: level not listed and out of reach, but the caller submitted that capture → allowed', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...ON, salesPhotoViewLevels: ['XSR'] } });
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o9' }]);
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([
        { outletId: 'o1', formValues: captureRow().formValues, submittedBySalesUserId: 'su1' },
      ]);
      await expect(service.assertSalesMediaAccess(user, KEY1)).resolves.toBeUndefined();
    });

    it('not on a current-month current version (old month / replaced photo / unknown) → 403', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      await expect(service.assertSalesMediaAccess(user, KEY1)).rejects.toThrow(ForbiddenException);
    });

    it('an OLD-FORMAT unattached upload (ownership cannot be proven) → 403', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      await expect(service.assertSalesMediaAccess(user, `visibility-media/t1/${CUR_MONTH}/new.jpg`)).rejects.toThrow(ForbiddenException);
    });

    it('the caller OWN upload of this month → allowed without any capture lookup', async () => {
      await expect(service.assertSalesMediaAccess(user, OWN_KEY)).resolves.toBeUndefined();
      expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
    });

    it('the caller own upload of an OLDER month, or another user upload → 403', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      await expect(service.assertSalesMediaAccess(user, 'visibility-media/t1/u/u1/2020-01/old.jpg')).rejects.toThrow(ForbiddenException);
      await expect(service.assertSalesMediaAccess(user, `visibility-media/t1/u/u2/${CUR_MONTH}/x.jpg`)).rejects.toThrow(ForbiddenException);
    });

    it('a /vendor-import/ key not on a current-month capture → 403; a path with .. → 403', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      await expect(service.assertSalesMediaAccess(user, 'visibility-media/t1/vendor-import/a.jpg')).rejects.toThrow(ForbiddenException);
      await expect(service.assertSalesMediaAccess(user, `visibility-media/t1/u/u1/${CUR_MONTH}/../../x.jpg`)).rejects.toThrow(ForbiddenException);
    });

    it('a form with no photo field → 403 (fail closed)', async () => {
      mockPrisma.visibilityForm.findUnique.mockResolvedValue({ formSchema: { fields: [] } });
      mockPrisma.visibilityFormVersion.findMany.mockResolvedValue([]);
      await expect(service.assertSalesMediaAccess(user, KEY1)).rejects.toThrow(ForbiddenException);
    });

    it('the form sample image → allowed without any capture lookup', async () => {
      await expect(service.assertSalesMediaAccess(user, 'visibility-media/t1/2026-01/sample.jpg')).resolves.toBeUndefined();
      expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
    });

    it('a substring look-alike in a row is not a match (exact key only) → 403', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([{ outletId: 'o1', formValues: { w2: `${KEY1}x` } }]);
      await expect(service.assertSalesMediaAccess(user, KEY1)).rejects.toThrow(ForbiddenException);
    });

    it('admin roles are unchanged (no checks at all)', async () => {
      await expect(service.assertSalesMediaAccess(admin, KEY1)).resolves.toBeUndefined();
      await expect(service.assertSalesMediaAccess({ ...admin, role: 'GIFSY_ADMIN' }, KEY1)).resolves.toBeUndefined();
      expect(mockSettings.getEffectiveSettings).not.toHaveBeenCalled();
    });

    it('tenant with the setting UNSET → unchanged (no lookups, allowed)', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: baseConfig });
      await expect(service.assertSalesMediaAccess(user, `visibility-media/t1/${CUR_MONTH}/new.jpg`)).resolves.toBeUndefined();
      expect(mockPrisma.visibilityForm.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
    });

    it('another tenant key is left to viewMedia (its existing 403)', async () => {
      await expect(service.assertSalesMediaAccess(user, 'visibility-media/t2/x.jpg')).resolves.toBeUndefined();
      expect(mockSettings.getEffectiveSettings).not.toHaveBeenCalled();
    });

    it('private caching only for a sales caller of a photo-view tenant', async () => {
      await expect(service.salesMediaCacheable(user)).resolves.toBe(true);
      await expect(service.salesMediaCacheable(admin)).resolves.toBe(false);
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: baseConfig });
      await expect(service.salesMediaCacheable(user)).resolves.toBe(false);
    });
  });

  // ── Sales upload key carries the uploader only on photo-view tenants ────────────
  describe('uploadCaptureMedia', () => {
    it('photo-view tenant → owner-foldered key; unset tenant → exactly the old call', async () => {
      const file = { buffer: Buffer.from('x') } as Express.Multer.File;
      await service.uploadCaptureMedia(user, file);
      expect(mockMedia.uploadMedia).toHaveBeenLastCalledWith(user, file, { ownerFolder: true });
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: baseConfig });
      await service.uploadCaptureMedia(user, file);
      expect(mockMedia.uploadMedia).toHaveBeenLastCalledWith(user, file);
    });
  });

  // ── Pure builder ─────────────────────────────────────────────────────────────────
  describe('buildSalesCapturePhotos', () => {
    it('whole-capture REJECTED → every photo needs re-take; the reason is given ONCE (captureReason)', () => {
      const out = buildSalesCapturePhotos(
        captureRow({ status: 'REJECTED', photoReviews: null, rejectionReason: null, rejectionReasonCode: 'WRONG_OUTLET' }) as never,
        formSchema as never,
        null,
      );
      expect(out.captureReason).toBe('Wrong outlet');
      expect(out.photos.map((p) => [p.status, p.reason])).toEqual([
        ['needs_retake', null],
        ['needs_retake', null],
      ]);
      expect(out.photos[0]).not.toHaveProperty('fenceStatus'); // no policy → no fence word
    });

    it('SUBMITTED with no reviews → pending; APPROVED whole-capture → approved; windowClosed is passed through', () => {
      const sub = buildSalesCapturePhotos(captureRow({ status: 'SUBMITTED', photoReviews: null }) as never, formSchema as never, null, { windowClosed: true });
      expect(sub.photos.map((p) => p.status)).toEqual(['pending', 'pending']);
      expect(sub.windowClosed).toBe(true);
      const ok = buildSalesCapturePhotos(captureRow({ status: 'APPROVED', photoReviews: null }) as never, formSchema as never, null);
      expect(ok.photos.map((p) => p.status)).toEqual(['approved', 'approved']);
      expect(ok.windowClosed).toBe(false);
    });
  });
});

