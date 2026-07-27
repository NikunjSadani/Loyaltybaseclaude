/**
 * Unit tests for visibility-capture.service.ts (Stream B).
 *
 * Covers: reach+level auth (allowed-level-in-subtree passes; wrong level / out-of-subtree
 * → canCapture false or 403), window-key computed at submit, geo-fence block / allow /
 * flag-null, first-approved-wins 409, versioned reject→resubmit, and dup-hash surfacing.
 * Prisma / Tenant / TenantSettings / Storage / VisibilityMedia are mocked.
 *
 * Run: npx jest src/visibility/visibility-capture.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { VisibilityCaptureService, haversineMeters } from './visibility-capture.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { VisibilityMediaService } from './visibility-media.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { windowKeyForDate } from './visibility-window.helper';

const mockPrisma = {
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  outlet: { findFirst: jest.fn(), findMany: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  visibilityForm: { findUnique: jest.fn() },
  visibilityCapture: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  visibilityCaptureSubmission: { create: jest.fn() },
  visibilityImageHash: { findMany: jest.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((arg: any) =>
    typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg),
  ),
};

const mockTenant = {
  resolveVisibilityEnabled: jest.fn(),
  resolveVisibilityCaptureMode: jest.fn(),
};
const mockSettings = { getEffectiveSettings: jest.fn() };
const mockStorage = { downloadBytes: jest.fn() };
const mockMedia = {
  computeImageHash: jest.fn(),
  recordImageHashes: jest.fn(),
  uploadMedia: jest.fn(),
};

/** The current IST window key at freq=1 (used by the resubmit specs). */
const CUR_WINDOW = windowKeyForDate(new Date(), 1);

const user: JwtPayload = { sub: 'u1', role: 'SALES_SO', clientId: 't1', phone: '9', name: 'Rep' };

const config = {
  outletScope: ['SSS'],
  frequencyPerMonth: 1,
  allowedSalesLevels: ['SO'],
  geoFence: { enabled: true, radiusMeters: 50 },
};

const form = {
  clientId: 't1',
  version: 3,
  formSchema: {
    captureGpsOnSubmit: true,
    fields: [
      { id: 'photo', type: 'CAMERA', label: 'Shelf', required: true, order: 1 },
      { id: 'geo', type: 'GPS_POINT', label: 'Location', required: false, order: 2 },
    ],
  },
};

const outletRow = {
  id: 'o1',
  outletCode: 'OC1',
  name: 'Shop 1',
  partnerId: 'p1',
  outletType: { code: 'SSS' },
};

/** A submit payload whose GPS is ~15 m from the reference (inside a 50 m fence). */
const nearFormValues = {
  photo: 'visibility-media/t1/x.jpg',
  geo: { lat: 12.9001, lng: 77.5001, accuracy: 10 },
};

function refKyc(lat: number, lng: number) {
  return { kycSubmissions: [{ boardPhotoLat: lat, boardPhotoLng: lng }] };
}

describe('VisibilityCaptureService', () => {
  let service: VisibilityCaptureService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: config });

    // Caller = SO (allowed), with an active assignment to o1 (in-subtree).
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'SO' } });
    mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o1' }]);
    mockPrisma.outlet.findFirst.mockResolvedValue(outletRow);
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(form);
    mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
    mockStorage.downloadBytes.mockResolvedValue({ bytes: Buffer.from('img'), contentType: 'image/jpeg' });
    mockMedia.computeImageHash.mockReturnValue('hashA');
    mockMedia.recordImageHashes.mockResolvedValue({ dupHashes: [] });

    // Transaction internals: no approved row, no current row → create path.
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue(null);
    mockPrisma.visibilityCapture.findUnique.mockResolvedValue(null);
    mockPrisma.visibilityCapture.create.mockResolvedValue({ id: 'cap1', currentVersion: 1 });
    mockPrisma.visibilityCapture.update.mockResolvedValue({ id: 'cap1', currentVersion: 2 });
    mockPrisma.visibilityCaptureSubmission.create.mockResolvedValue({ id: 'sub1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityCaptureService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
        { provide: VisibilityMediaService, useValue: mockMedia },
      ],
    }).compile();
    service = module.get(VisibilityCaptureService);
  });

  // ── Gates ──────────────────────────────────────────────────────────────────
  it('403s when visibilityEnabled is OFF', async () => {
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('403s a submit when capture-mode is not PHOTO_APPROVAL', async () => {
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      ForbiddenException,
    );
  });

  // ── Window-key + happy submit ────────────────────────────────────────────────
  it('creates v1 SUBMITTED with the IST window-key computed at submit + geo inside fence', async () => {
    const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues });
    expect(res.version).toBe(1);
    expect(res.geoFenceOk).toBe(true);
    const createArg = mockPrisma.visibilityCapture.create.mock.calls[0][0].data;
    expect(createArg.windowKey).toBe(windowKeyForDate(new Date(), 1));
    expect(createArg.status).toBe('SUBMITTED');
    expect(createArg.currentVersion).toBe(1);
    expect(mockMedia.recordImageHashes).toHaveBeenCalledWith(mockPrisma, 't1', 'cap1', ['hashA']);
  });

  // ── Geo-fence ────────────────────────────────────────────────────────────────
  it('BLOCKS a capture outside the geo-fence radius (geoFenceOk false → 403)', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(13.5, 78.5)); // far away
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
  });

  it('ALLOWS but FLAGS when the outlet has no reference geo (geoFenceOk null)', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [] });
    const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues });
    expect(res.geoFenceOk).toBeNull();
    expect(res.flags).toContain('GEO_UNVERIFIABLE');
    expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
  });

  // ── First-approved-wins ──────────────────────────────────────────────────────
  it('409s when the window is already satisfied by an APPROVED capture', async () => {
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ id: 'approvedCap' });
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects a fresh submit over an existing SUBMITTED (awaiting) capture', async () => {
    mockPrisma.visibilityCapture.findUnique.mockResolvedValue({
      id: 'cap1',
      status: 'SUBMITTED',
      currentVersion: 1,
    });
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      BadRequestException,
    );
  });

  // ── Versioned reject → resubmit ──────────────────────────────────────────────
  it('resubmit bumps a REJECTED capture to version+1 SUBMITTED, clearing the rejection', async () => {
    // Top-level lookup for resubmit (the REJECTED row) + in-tx re-read.
    mockPrisma.visibilityCapture.findFirst.mockImplementation((args: { where?: { status?: string } }) => {
      // The in-tx first-approved check filters by status APPROVED → null.
      if (args?.where?.status === 'APPROVED') return Promise.resolve(null);
      return Promise.resolve({
        id: 'cap1',
        status: 'REJECTED',
        outletId: 'o1',
        currentVersion: 1,
        windowKey: CUR_WINDOW,
      });
    });
    mockPrisma.visibilityCapture.findUnique.mockResolvedValue({
      id: 'cap1',
      status: 'REJECTED',
      currentVersion: 1,
      windowKey: CUR_WINDOW,
    });

    const res = await service.resubmitCapture(user, 'cap1', { formValues: nearFormValues });
    expect(res.version).toBe(2);
    const updateArg = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
    expect(updateArg.status).toBe('SUBMITTED');
    expect(updateArg.currentVersion).toBe(2);
    expect(updateArg.rejectionReason).toBeNull();
    expect(updateArg.rejectionReasonCode).toBeNull();
  });

  it('refuses to resubmit a non-REJECTED capture', async () => {
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1',
      status: 'SUBMITTED',
      outletId: 'o1',
      currentVersion: 1,
    });
    await expect(service.resubmitCapture(user, 'cap1', { formValues: nearFormValues })).rejects.toThrow(
      BadRequestException,
    );
  });

  // ── Dup-hash surfacing ───────────────────────────────────────────────────────
  it('surfaces duplicatePhoto:true when a photo hash is seen on another capture', async () => {
    mockMedia.recordImageHashes.mockResolvedValue({ dupHashes: ['hashA'] });
    const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues });
    expect(res.duplicatePhoto).toBe(true);
  });

  // ── Reach + level auth ───────────────────────────────────────────────────────
  it('403s a submit when the caller level is not in allowedSalesLevels', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'ISR' } });
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('403s a submit when the outlet is outside the caller subtree reach', async () => {
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]); // no assignments → empty reach
    await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('getSalesEligible marks canCapture false for a non-allowed level (view-only, D8)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'ISR' } });
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, outletType: { code: 'SSS' } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    const res = await service.getSalesEligible(user);
    expect(res.levelAllowed).toBe(false);
    expect(res.outlets[0].canCapture).toBe(false);
    expect(res.outlets[0].windowState).toBe('due');
  });

  it('getSalesEligible marks canCapture true + reflects status for an allowed level', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, outletType: { code: 'SSS' } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      { outletId: 'o1', id: 'cap1', status: 'SUBMITTED', currentVersion: 1, rejectionReason: null },
    ]);
    const res = await service.getSalesEligible(user);
    expect(res.levelAllowed).toBe(true);
    expect(res.outlets[0].canCapture).toBe(true);
    expect(res.outlets[0].windowState).toBe('awaiting');
  });

  // ── H1: geo-fence fail-CLOSED on garbage/missing capture geo ─────────────────
  it('H1: BLOCKS a garbage present GPS value at validation (400) — cannot slip through as empty geo', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5)); // reference present
    await expect(
      service.submitCapture(user, {
        outletId: 'o1',
        formValues: { photo: 'visibility-media/t1/x.jpg', geo: { lat: 999, lng: 'nope' } },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
  });

  it('H1: BLOCKS (403) when the fence is on + reference exists but NO capture GPS supplied', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
    await expect(
      service.submitCapture(user, { outletId: 'o1', formValues: { photo: 'visibility-media/t1/x.jpg' } }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
  });

  it('H1: still ALLOWS+FLAGS garbage/missing capture geo when there is NO reference geo (unverifiable)', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [] }); // no reference
    const res = await service.submitCapture(user, {
      outletId: 'o1',
      formValues: { photo: 'visibility-media/t1/x.jpg' }, // no GPS
    });
    expect(res.geoFenceOk).toBeNull();
    expect(res.flags).toContain('GEO_UNVERIFIABLE');
    expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
  });

  // ── H2: sales-reachable capture-photo upload ─────────────────────────────────
  it('H2: uploadCaptureMedia lets a sales rep upload (enabled+photo+sales) and folders under the caller clientId', async () => {
    mockMedia.uploadMedia.mockResolvedValue({ key: 'visibility-media/t1/2026-07/uuid-shelf.jpg' });
    const file = { buffer: Buffer.from([0xff, 0xd8, 0xff]), size: 3, originalname: 'shelf.jpg' } as never;
    const res = await service.uploadCaptureMedia(user, file);
    expect(mockMedia.uploadMedia).toHaveBeenCalledWith(user, file);
    expect(res.key).toContain('visibility-media/t1/');
  });

  it('H2: uploadCaptureMedia 403s when the caller is not a sales user', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    const file = { buffer: Buffer.from([0xff, 0xd8, 0xff]), size: 3, originalname: 'shelf.jpg' } as never;
    await expect(service.uploadCaptureMedia(user, file)).rejects.toThrow(ForbiddenException);
    expect(mockMedia.uploadMedia).not.toHaveBeenCalled();
  });

  // ── M1: resubmit across a window boundary ────────────────────────────────────
  it('M1: 409s a resubmit whose REJECTED capture belongs to a PAST (closed) window', async () => {
    mockPrisma.visibilityCapture.findFirst.mockResolvedValue({
      id: 'cap1',
      status: 'REJECTED',
      outletId: 'o1',
      currentVersion: 1,
      windowKey: '1999-01-P1', // a window that is not the current one
    });
    await expect(
      service.resubmitCapture(user, 'cap1', { formValues: nearFormValues }),
    ).rejects.toThrow(ConflictException);
    expect(mockPrisma.visibilityCapture.update).not.toHaveBeenCalled();
  });

  // ── L1: CAMERA key must belong to the caller's tenant ────────────────────────
  it('L1: 400s a submit whose CAMERA key is not under the caller tenant media folder', async () => {
    await expect(
      service.submitCapture(user, {
        outletId: 'o1',
        formValues: { photo: 'visibility-media/OTHER/x.jpg', geo: { lat: 12.9001, lng: 77.5001 } },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
  });

  // ── M2: submit is blocked for a deactivated / out-of-scope outlet ────────────
  it('M2: 404s a submit for an outlet the denominator predicate excludes (deactivated/deleted)', async () => {
    // loadInScopeOutlet now filters deletedAt+deactivatedAt null → findFirst returns null.
    mockPrisma.outlet.findFirst.mockResolvedValue(null);
    await expect(
      service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }),
    ).rejects.toThrow(NotFoundException);
  });

  // ── haversine sanity ─────────────────────────────────────────────────────────
  it('haversineMeters ~0 for identical points and grows with separation', () => {
    expect(haversineMeters(12.9, 77.5, 12.9, 77.5)).toBeCloseTo(0, 5);
    expect(haversineMeters(12.9, 77.5, 12.9001, 77.5001)).toBeGreaterThan(5);
    expect(haversineMeters(12.9, 77.5, 12.9001, 77.5001)).toBeLessThan(50);
  });
});
