import { Readable } from 'node:stream';
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
import { Prisma } from '@prisma/client';
import { CAPTURE_JUST_REVIEWED_MESSAGE, VisibilityCaptureService, haversineMeters } from './visibility-capture.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { VisibilityMediaService } from './visibility-media.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { windowKeyForDate } from './visibility-window.helper';
import { visibilityOutOfScopeReason } from './visibility-scope.helper';

const mockPrisma = {
  // persistCapture reads clients.features for the outlet-master geo-fence gate (outletMasterGeo).
  client: { findUnique: jest.fn() },
  // Location gate: an "outside the fence" refusal is recorded (features.requireLocation tenants only).
  auditLog: { create: jest.fn().mockResolvedValue({}) },
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
  // Permanent review history: submit / resubmit append an event in the same tx.
  visibilityReviewEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
const mockStorage = { openBoundedObject: jest.fn() };
const mockMedia = {
  computeImageHash: jest.fn(),
  computeImageHashFromStream: jest.fn(),
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
    // Default: tenant NOT geo-enabled (no outletMasterGeo flag) → legacy KYC-board-ref fence
    // (byte-identical to before). The outletMasterGeo tests override this per case.
    mockPrisma.client.findUnique.mockResolvedValue(null);

    // Caller = SO (allowed), with an active assignment to o1 (in-subtree).
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'SO' } });
    mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o1' }]);
    mockPrisma.outlet.findFirst.mockResolvedValue(outletRow);
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(form);
    mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
    mockStorage.openBoundedObject.mockResolvedValue({ stream: Readable.from([Buffer.from('img')]), size: (Buffer.from('img')).length, contentType: 'image/jpeg' });
    mockMedia.computeImageHashFromStream.mockResolvedValue('hashA');
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
    // Permanent review history: one SUBMITTED event (v1, the rep as actor), written via the tx client.
    expect(mockPrisma.visibilityReviewEvent.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visibilityReviewEvent.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        clientId: 't1', captureId: 'cap1', outletId: 'o1', windowKey: createArg.windowKey, version: 1,
        action: 'SUBMITTED', statusAfter: 'SUBMITTED', actorUserId: user.sub,
      }),
    ]);
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

  // ── Outlet-master geo-fence (Bajaj-only via clients.features.outletMasterGeo) ─────────────
  // When ON, the reference becomes the OUTLET-MASTER lat/long, the fence is forced on at 200 m
  // (ignoring config.geoFence 50 m/enabled), outside → block with the owner message, and missing
  // master coords / no fix → unverifiable (allow + flag). Deoleo / non-gated stays byte-identical.
  describe('outlet-master geo-fence (outletMasterGeo gate)', () => {
    const BLOCK_MSG = 'You are far from the outlet. Please go to the outlet and try again.';
    const gatedOn = () =>
      mockPrisma.client.findUnique.mockResolvedValue({ features: { outletMasterGeo: true } });
    /** outletRow + outlet-master coords (loadInScopeOutlet now selects latitude/longitude). */
    const outletWithMaster = (lat: number | null, lng: number | null) => ({
      ...outletRow,
      latitude: lat,
      longitude: lng,
    });
    // Form values whose GPS is ~14 m from (12.9, 77.5).
    const nearMaster = { photo: 'visibility-media/t1/x.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 10 } };
    const noGeo = { photo: 'visibility-media/t1/x.jpg' };

    it('uses the OUTLET-MASTER reference (not the KYC board) and ALLOWS within 200 m', async () => {
      gatedOn();
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5)); // master near subject
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(13.5, 78.5));     // KYC board FAR
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearMaster });
      // Proof the master ref (near) won over the KYC board (far): fence passes.
      expect(res.geoFenceOk).toBe(true);
      expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    });

    it('BLOCKS outside 200 m of the OUTLET-MASTER with the exact owner message', async () => {
      gatedOn();
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(13.5, 78.5)); // master FAR from subject
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));     // KYC board near (would pass legacy)
      await expect(
        service.submitCapture(user, { outletId: 'o1', formValues: nearMaster }),
      ).rejects.toThrow(BLOCK_MSG);
      expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
    });

    it('UNVERIFIABLE + allowed when the outlet has NO master coords (never blocks)', async () => {
      gatedOn();
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(null, null));
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5)); // KYC board ignored under gate
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearMaster });
      expect(res.geoFenceOk).toBeNull();
      expect(res.flags).toContain('GEO_UNVERIFIABLE');
      expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    });

    it('UNVERIFIABLE + allowed when there is no photo GPS fix (no H1 hard-block under the gate)', async () => {
      gatedOn();
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: noGeo });
      expect(res.geoFenceOk).toBeNull();
      expect(res.flags).toContain('GEO_UNVERIFIABLE');
      expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    });

    it('REGRESSION: with the gate OFF, outlet-master coords are IGNORED (uses the KYC board ref)', async () => {
      // Gate off (default). Master coords far, KYC board near → legacy fence uses the board → passes.
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(13.5, 78.5));
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearMaster });
      expect(res.geoFenceOk).toBe(true);
      expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    });

    // ── ACCURACY BUFFER (gated path) ──────────────────────────────────────────────────
    // A fix whose OWN reported accuracy is worse than the (forced 200 m) fence radius cannot be
    // trusted to place the capture in/out → UNVERIFIABLE (allow + flag), never 'outside'.
    it('ACCURACY BUFFER: fix accuracy > 200 m (near master) → UNVERIFIABLE + allowed, never blocked', async () => {
      gatedOn();
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5)); // master near subject
      const imprecise = { photo: 'visibility-media/t1/x.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 250 } };
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: imprecise });
      expect(res.geoFenceOk).toBeNull();
      expect(res.flags).toContain('GEO_UNVERIFIABLE');
      expect(res.distanceMeters).toBeNull();
      expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    });

    it('ACCURACY BUFFER: a precise (≤200 m) fix that is FAR still BLOCKS (buffer does not weaken a real outside)', async () => {
      gatedOn();
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(13.5, 78.5)); // master FAR from subject
      const preciseFar = { photo: 'visibility-media/t1/x.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 20 } };
      await expect(
        service.submitCapture(user, { outletId: 'o1', formValues: preciseFar }),
      ).rejects.toThrow(BLOCK_MSG);
      expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
    });

    it('ACCURACY BUFFER is NOT applied with the gate OFF (a high-accuracy near fix still passes the legacy fence)', async () => {
      // Gate off (default). Imprecise (250 m) but geometrically near the KYC board (14 m < 50 m)
      // → legacy fence passes; the accuracy buffer is gated-only so it never fires here.
      mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(13.5, 78.5));
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
      const imprecise = { photo: 'visibility-media/t1/x.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 250 } };
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: imprecise });
      expect(res.geoFenceOk).toBe(true);
      expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    });

    // ── LOCATION GATE (features.requireLocation — owner 2026-11-18; LOCATION-GATE.md) ──────────
    describe('requireLocation', () => {
      const NO_LOC = /Location is required to submit a visibility capture/;
      // Gate fixes carry a recent capturedAt (the rule checks freshness — never a hardcoded date).
      const nearNow = () => ({ photo: 'visibility-media/t1/x.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 10, capturedAt: new Date().toISOString() } });
      const requireOn = (extra: Record<string, unknown> = {}) =>
        mockPrisma.client.findUnique.mockResolvedValue({ features: { requireLocation: true, ...extra } });

      it('ON + no GPS on the capture → 400 before any write (legacy GPS_POINT form)', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        await expect(service.submitCapture(user, { outletId: 'o1', formValues: noGeo })).rejects.toThrow(NO_LOC);
        expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
      });

      it('ON + no GPS field value but the phone sent a submit-time captureGeo → accepted (fresh fix of this request)', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        const res = await service.submitCapture(user, {
          outletId: 'o1', formValues: noGeo, captureGeo: { lat: 12.9001, lng: 77.5001, accuracy: 9, capturedAt: new Date().toISOString() },
        } as never);
        expect(res.version).toBe(1);
        expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
      });

      // ── AUDIT #1: a capture whose photos carried a fix is never stored as "No GPS" ──
      const perPhotoForm = {
        clientId: 't1', version: 4,
        formSchema: { fields: [{ id: 'shelf', type: 'CAMERA', label: 'Shelf', required: true, order: 1, geoFenceRequired: true }] },
      };
      const shelf = (accuracy: number) => ({
        shelf: { key: 'visibility-media/t1/x.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy, capturedAt: new Date().toISOString() } },
      });

      it('AUDIT #1: ON + outlet WITHOUT master coordinates → the photo fix is still stored (unverifiable, not "No GPS")', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(null, null));
        mockPrisma.visibilityForm.findUnique.mockResolvedValue(perPhotoForm);
        const res = await service.submitCapture(user, { outletId: 'o1', formValues: shelf(12) });
        expect(res.geoFenceOk).toBeNull();
        const data = mockPrisma.visibilityCapture.create.mock.calls[0][0].data;
        expect(data).toMatchObject({ captureLat: 12.9001, captureLng: 77.5001, captureAccuracy: 12, distanceMeters: null });
        expect(mockPrisma.visibilityCaptureSubmission.create.mock.calls[0][0].data.captureLat).toBe(12.9001);
      });

      it('AUDIT #1: ON + a fix worse than 200 m → stored with its accuracy (reported as poor accuracy), verdict unchanged', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        mockPrisma.visibilityForm.findUnique.mockResolvedValue(perPhotoForm);
        const res = await service.submitCapture(user, { outletId: 'o1', formValues: shelf(350) });
        expect(res.geoFenceOk).toBeNull();
        expect(res.distanceMeters).toBeNull();
        expect(mockPrisma.visibilityCapture.create.mock.calls[0][0].data).toMatchObject({ captureLat: 12.9001, captureAccuracy: 350 });
      });

      it('ROUND 3 #3: phone clock more than 24 h off → 400 "set date and time to automatic"', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        await expect(
          service.submitCapture(user, { outletId: 'o1', formValues: nearNow(), clientNow: new Date(Date.now() + 2 * 86_400_000).toISOString() } as never),
        ).rejects.toThrow(/date and time are wrong/);
        expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
      });

      it('ROUND 3 #8: the stored fix prefers the fresh captureGeo of this request over a carried-forward photo', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(null, null)); // no reference → fallback path
        mockPrisma.visibilityForm.findUnique.mockResolvedValue({
          clientId: 't1', version: 4,
          formSchema: { fields: [
            { id: 'old', type: 'CAMERA', label: 'Old', required: false, order: 1, geotag: true },
            { id: 'plain', type: 'CAMERA', label: 'Plain', required: false, order: 2 },
          ] },
        });
        // A CHANGES_REQUESTED row whose APPROVED photo carries an old location elsewhere.
        mockPrisma.visibilityCapture.findUnique.mockResolvedValueOnce({
          id: 'cap1', status: 'CHANGES_REQUESTED', currentVersion: 1,
          formValues: { old: { key: 'visibility-media/t1/o.jpg', geo: { lat: 13.5, lng: 78.5, accuracy: 5, capturedAt: '2026-01-01T00:00:00.000Z' } }, plain: 'visibility-media/t1/p.jpg' },
          photoReviews: { old: { status: 'APPROVED' }, plain: { status: 'REJECTED' } },
        });
        mockPrisma.visibilityCapture.findUnique.mockResolvedValueOnce({ id: 'cap1', status: 'CHANGES_REQUESTED', currentVersion: 1 });
        await service.submitCapture(user, {
          outletId: 'o1',
          formValues: { plain: 'visibility-media/t1/p2.jpg' },
          captureGeo: { lat: 12.9001, lng: 77.5001, accuracy: 7, capturedAt: new Date().toISOString() },
        } as never);
        const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
        expect(data).toMatchObject({ captureLat: 12.9001, captureLng: 77.5001, captureAccuracy: 7 });
      });

      it('ROUND 4 #2: fence path — the STORED fix is the fresh photo of this request, not the farther carried one; verdict unchanged', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        mockPrisma.visibilityForm.findUnique.mockResolvedValue({
          clientId: 't1', version: 4,
          formSchema: { fields: [
            { id: 'a', type: 'CAMERA', label: 'A', required: false, order: 1, geoFenceRequired: true },
            { id: 'b', type: 'CAMERA', label: 'B', required: false, order: 2, geoFenceRequired: true },
          ] },
        });
        // Carried APPROVED photo ~145 m away (inside 200 m, the farthest); the re-shot photo ~15 m away.
        mockPrisma.visibilityCapture.findUnique.mockResolvedValueOnce({
          id: 'cap1', status: 'CHANGES_REQUESTED', currentVersion: 1,
          formValues: { a: { key: 'visibility-media/t1/a.jpg', geo: { lat: 12.9013, lng: 77.5, accuracy: 8, capturedAt: '2026-01-01T00:00:00.000Z' } }, b: { key: 'visibility-media/t1/b.jpg' } },
          photoReviews: { a: { status: 'APPROVED' }, b: { status: 'REJECTED' } },
        });
        mockPrisma.visibilityCapture.findUnique.mockResolvedValueOnce({ id: 'cap1', status: 'CHANGES_REQUESTED', currentVersion: 1 });
        const res = await service.submitCapture(user, {
          outletId: 'o1',
          formValues: { b: { key: 'visibility-media/t1/b2.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 6, capturedAt: new Date().toISOString() } } },
        } as never);
        expect(res.geoFenceOk).toBe(true); // verdict from every photo, as before
        const data = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
        expect(data).toMatchObject({ captureLat: 12.9001, captureLng: 77.5001, captureAccuracy: 6 });
        expect(data.distanceMeters).toBeLessThan(30); // distance of the SAME stored fix (not the carried 145 m)
      });

      it('ROUND 4 #2: OFF (Deoleo-like, outletMasterGeo only) → the fence path keeps storing the farthest photo as before', async () => {
        gatedOn();
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        mockPrisma.visibilityForm.findUnique.mockResolvedValue({
          clientId: 't1', version: 4,
          formSchema: { fields: [
            { id: 'a', type: 'CAMERA', label: 'A', required: false, order: 1, geoFenceRequired: true },
            { id: 'b', type: 'CAMERA', label: 'B', required: false, order: 2, geoFenceRequired: true },
          ] },
        });
        await service.submitCapture(user, {
          outletId: 'o1',
          formValues: {
            a: { key: 'visibility-media/t1/a.jpg', geo: { lat: 12.9013, lng: 77.5, accuracy: 8 } },
            b: { key: 'visibility-media/t1/b.jpg', geo: { lat: 12.9001, lng: 77.5001, accuracy: 6 } },
          },
        } as never);
        expect(mockPrisma.visibilityCapture.create.mock.calls[0][0].data).toMatchObject({ captureLat: 12.9013, captureAccuracy: 8 });
      });

      it('AUDIT #1: OFF (Deoleo) → stored values unchanged (no fallback: NULL location columns as before)', async () => {
        gatedOn();
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(null, null));
        mockPrisma.visibilityForm.findUnique.mockResolvedValue(perPhotoForm);
        await service.submitCapture(user, { outletId: 'o1', formValues: shelf(12) });
        expect(mockPrisma.visibilityCapture.create.mock.calls[0][0].data.captureLat).toBeNull();
      });

      it('ON + a valid fix near the outlet → accepted, nothing recorded', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearNow() });
        expect(res.geoFenceOk).toBe(true);
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      });

      it('ON + per-photo form, a fence photo WITHOUT a fix → 400 naming the photo', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        mockPrisma.visibilityForm.findUnique.mockResolvedValue({
          clientId: 't1', version: 4,
          formSchema: { fields: [{ id: 'shelf', type: 'CAMERA', label: 'Shelf', required: true, order: 1, geoFenceRequired: true }] },
        });
        await expect(
          service.submitCapture(user, { outletId: 'o1', formValues: { shelf: { key: 'visibility-media/t1/x.jpg' } } }),
        ).rejects.toThrow(/"Shelf"/);
        expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
      });

      it('ON + outside the fence → owner message AND one LOCATION_FENCE_BLOCK audit row (flow VISIBILITY)', async () => {
        requireOn({ outletMasterGeo: true });
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(13.5, 78.5));
        await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearNow() })).rejects.toThrow(BLOCK_MSG);
        expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          action: 'REJECT', entityType: 'LOCATION_FENCE_BLOCK', entityId: 'o1', actorId: 'u1',
          metadata: { flow: 'VISIBILITY', clientId: 't1' },
        });
      });

      it('OFF (default) → no GPS still allowed + flagged and an outside block records NOTHING (Deoleo parity)', async () => {
        gatedOn();
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(12.9, 77.5));
        const res = await service.submitCapture(user, { outletId: 'o1', formValues: noGeo });
        expect(res.flags).toContain('GEO_UNVERIFIABLE');
        mockPrisma.outlet.findFirst.mockResolvedValue(outletWithMaster(13.5, 78.5));
        mockPrisma.visibilityCapture.findUnique.mockResolvedValue(null);
        await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearNow() })).rejects.toThrow(BLOCK_MSG);
        expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      });
    });
  });

  // ── Prod bug 2026-11-19: conditional (Privilege-only) fence photo hidden at an Elite/Unnati outlet ───────────
  // Bajaj form version cmwdgt7u2001e01s6ty73t1z5: Window 1 (required, fence) + Window 2 (fence, visible/required only
  // when __subProgram__ == Privilege) + the two GPS points. Outlet-master coords (12.9, 77.5).
  describe('conditional fence photos (outletMasterGeo tenants)', () => {
    const privilegeOnly = { op: 'eq', value: 'Privilege', fieldId: '__subProgram__' };
    const bajajForm = {
      clientId: 't1', version: 7,
      formSchema: {
        fields: [
          { id: 'wtk11hn', type: 'CAMERA', label: 'Window 1', required: true, order: 1, geotag: true, geoFenceRequired: true },
          { id: 'g1', type: 'GPS_POINT', label: 'Geo tag 1', required: false, order: 2 },
          { id: 'np9d0cc', type: 'CAMERA', label: 'Window 2', required: false, order: 3, geotag: true, geoFenceRequired: true, visibleWhen: privilegeOnly, requiredWhen: privilegeOnly },
          { id: 'g2', type: 'GPS_POINT', label: 'Geo Tag 2', required: false, order: 4, visibleWhen: privilegeOnly, requiredWhen: privilegeOnly },
        ],
      },
    };
    const near = (key: string) => ({ key: `visibility-media/t1/${key}.jpg`, geo: { lat: 12.9003, lng: 77.5001, accuracy: 20 } }); // ~34 m
    const far = (key: string) => ({ key: `visibility-media/t1/${key}.jpg`, geo: { lat: 12.95, lng: 77.55, accuracy: 10 } });
    const outlet = (programCategory: string, gate = true) => {
      mockPrisma.client.findUnique.mockResolvedValue(gate ? { features: { outletMasterGeo: true } } : null);
      mockPrisma.outlet.findFirst.mockResolvedValue({ ...outletRow, latitude: 12.9, longitude: 77.5, programCategory });
      mockPrisma.visibilityForm.findUnique.mockResolvedValue(bajajForm);
    };

    it.each(['Elite', 'Unnati'])('%s outlet, only Window 1 inside → geoFenceOk TRUE, no GEO_UNVERIFIABLE', async (cat) => {
      outlet(cat);
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: { wtk11hn: near('w1') } });
      expect(res.geoFenceOk).toBe(true);
      expect(res.flags).not.toContain('GEO_UNVERIFIABLE');
      expect(mockPrisma.visibilityCapture.create.mock.calls[0][0].data.geoFenceOk).toBe(true);
      expect(mockPrisma.visibilityCaptureSubmission.create.mock.calls[0][0].data.geoFenceOk).toBe(true);
    });

    it('Privilege outlet, both windows inside → TRUE', async () => {
      outlet('Privilege');
      const res = await service.submitCapture(user, {
        outletId: 'o1',
        formValues: { wtk11hn: near('w1'), np9d0cc: near('w2'), g2: { lat: 12.9003, lng: 77.5001, accuracy: 20 } },
      });
      expect(res.geoFenceOk).toBe(true);
      expect(res.flags).not.toContain('GEO_UNVERIFIABLE');
    });

    it('Privilege outlet, Window 2 missing → the required-field error (as today)', async () => {
      outlet('Privilege');
      await expect(
        service.submitCapture(user, { outletId: 'o1', formValues: { wtk11hn: near('w1'), g2: { lat: 12.9, lng: 77.5 } } }),
      ).rejects.toThrow(/Window 2.*is required/);
      expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
    });

    it('Privilege outlet, Window 2 outside → BLOCKED', async () => {
      outlet('Privilege');
      await expect(
        service.submitCapture(user, {
          outletId: 'o1',
          formValues: { wtk11hn: near('w1'), np9d0cc: far('w2'), g2: { lat: 12.95, lng: 77.55 } },
        }),
      ).rejects.toThrow('You are far from the outlet. Please go to the outlet and try again.');
      expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
    });

    it('audit #6: outlet-master tenant, Window 1 fix at 0,0 → unverifiable (allow + flag), never "far from the outlet"', async () => {
      outlet('Elite');
      const res = await service.submitCapture(user, {
        outletId: 'o1',
        formValues: { wtk11hn: { key: 'visibility-media/t1/w1.jpg', geo: { lat: 0, lng: 0, accuracy: 5 } } },
      });
      expect(res.geoFenceOk).toBeNull();
      expect(res.flags).toContain('GEO_UNVERIFIABLE');
      expect(mockPrisma.visibilityCapture.create.mock.calls[0][0].data.distanceMeters).toBeNull();
    });

    it('audit #6: NON-gated tenant, a 0,0 fix → unchanged (fenced against the KYC board reference → blocked)', async () => {
      outlet('Elite', false);
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
      await expect(
        service.submitCapture(user, {
          outletId: 'o1',
          formValues: { wtk11hn: { key: 'visibility-media/t1/w1.jpg', geo: { lat: 0, lng: 0, accuracy: 5 } } },
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('NON-gated tenant (Deoleo) → unchanged: the hidden fence slot still reads unverifiable (all fence fields, as before)', async () => {
      outlet('Elite', false);
      mockPrisma.channelPartner.findFirst.mockResolvedValue(refKyc(12.9, 77.5));
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: { wtk11hn: near('w1') } });
      expect(res.geoFenceOk).toBeNull();
      expect(res.flags).toContain('GEO_UNVERIFIABLE');
    });
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
    // The cleared rejection survives in the permanent history; the resubmit itself is recorded.
    expect(mockPrisma.visibilityReviewEvent.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ captureId: 'cap1', version: 2, action: 'RESUBMITTED', statusAfter: 'SUBMITTED', windowKey: CUR_WINDOW }),
    ]);
  });

  it('resubmit guards against a concurrent review: writes only if the row is still the one read (status, version, updatedAt); else 409 and nothing written', async () => {
    const readAt = new Date('2026-11-20T05:00:00Z');
    const row = { id: 'cap1', status: 'REJECTED', outletId: 'o1', currentVersion: 1, windowKey: CUR_WINDOW, updatedAt: readAt };
    mockPrisma.visibilityCapture.findFirst.mockImplementation((args: { where?: { status?: string } }) =>
      Promise.resolve(args?.where?.status === 'APPROVED' ? null : row),
    );
    mockPrisma.visibilityCapture.findUnique.mockResolvedValue(row);
    // A review landed between the read and the write → the guarded update matches no row.
    mockPrisma.visibilityCapture.update.mockReset();
    mockPrisma.visibilityCapture.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('No record found', { code: 'P2025', clientVersion: 'test' }),
    );
    await expect(service.resubmitCapture(user, 'cap1', { formValues: nearFormValues })).rejects.toThrow(
      new ConflictException(CAPTURE_JUST_REVIEWED_MESSAGE),
    );
    expect(mockPrisma.visibilityCapture.update.mock.calls[0][0].where).toEqual({
      id: 'cap1', status: 'REJECTED', currentVersion: 1, updatedAt: readAt,
    });
    expect(CAPTURE_JUST_REVIEWED_MESSAGE).toBe('This visit was just reviewed — reload');
    expect(mockPrisma.visibilityCaptureSubmission.create).not.toHaveBeenCalled();
    expect(mockPrisma.visibilityReviewEvent.createMany).not.toHaveBeenCalled();
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
    expect(mockPrisma.visibilityReviewEvent.createMany).not.toHaveBeenCalled();
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

  it('getSalesEligible returns programCategory so the capture form can evaluate the __subProgram__ clause', async () => {
    // Regression: without this, the FE sees a blank sub-program, HIDES a required 2nd photo, and the
    // BE (which re-derives the real sub-program) then rejects the submit → the rep is hard-blocked.
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, programCategory: 'Premium', outletType: { code: 'SSS' } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    const res = await service.getSalesEligible(user);
    expect(res.outlets[0]).toHaveProperty('programCategory', 'Premium');
  });

  it('getSalesEligible returns each outlet assignedUserId + the caller’s direct-report members (Team Member filter)', async () => {
    // Manager su1 with one direct report su2; o1 is assigned to su2 (login-User u2).
    mockPrisma.salesUser.findFirst.mockResolvedValue({
      id: 'su1',
      hierarchyLevel: { code: 'SO' },
      subordinates: [{ id: 'su2', employeeCode: 'E2', user: { name: 'Rep Two' } }],
    });
    mockPrisma.salesUser.findMany.mockResolvedValue([
      { id: 'su1', reportingToId: null, userId: 'u1' },
      { id: 'su2', reportingToId: 'su1', userId: 'u2' },
    ]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
      { outletId: 'o1', salesUser: { userId: 'u2' } },
    ]);
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, outletType: { code: 'SSS' } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);

    const res = await service.getSalesEligible(user);
    // Each outlet carries the assigned rep's login-User id (the member-filter key).
    expect(res.outlets[0].assignedUserId).toBe('u2');
    // Direct-report members, each with their whole-sub-tree submitterUserIds.
    expect(res.members).toEqual([
      { id: 'su2', name: 'Rep Two', submitterUserIds: ['u2'] },
    ]);
  });

  it('G3: an ASM above a soft-deleted SO reaches the ISR\'s outlet AND gets the ISR as a promoted Team-Member option (never the SO)', async () => {
    const DEL = new Date('2026-11-01');
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'asm', hierarchyLevel: { code: 'SO' }, subordinates: [] });
    const NODES = [
      { id: 'asm', reportingToId: null, userId: 'u-asm', isActive: true, deletedAt: null },
      { id: 'so', reportingToId: 'asm', userId: 'u-so', isActive: true, deletedAt: DEL },
      { id: 'isr', reportingToId: 'so', userId: 'u-isr', isActive: true, deletedAt: null },
    ];
    // Edge read honours a deletedAt:null filter like the DB; the promoted-member fetch is by id.
    mockPrisma.salesUser.findMany.mockImplementation((args: { where: { id?: unknown; deletedAt?: null } }) =>
      Promise.resolve(
        args.where.id
          ? [{ id: 'isr', employeeCode: 'E-ISR', user: { name: 'Isr One' } }]
          : NODES.filter((n) => !('deletedAt' in args.where && n.deletedAt)),
      ),
    );
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outletId: 'o1', salesUser: { userId: 'u-isr' } }]);
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, outletType: { code: 'SSS' } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);

    const res = await service.getSalesEligible(user);
    const aWhere = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
    expect([...aWhere.salesUserId.in].sort()).toEqual(['asm', 'isr']);
    expect(res.members).toEqual([{ id: 'isr', name: 'Isr One', submitterUserIds: ['u-isr'] }]);
    expect(mockPrisma.salesUser.findMany.mock.calls[0][0].where).toEqual({ clientId: 't1' });
  });

  it('getSalesEligible returns members [] for a leaf rep with no downline', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1', hierarchyLevel: { code: 'SO' }, subordinates: [] });
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', outletCode: 'OC1', name: 'Shop 1', zone: null, state: null, outletType: { code: 'SSS' } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    const res = await service.getSalesEligible(user);
    expect(res.members).toEqual([]);
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

  // ── Design B: sub-program-driven conditional 2nd photo ───────────────────────
  // A form whose 2nd CAMERA is required (+visible) only when the OUTLET's sub-program
  // (programCategory) == 'X'. The context is server-authoritative and never persisted.
  const subProgramForm = {
    clientId: 't1',
    version: 5,
    formSchema: {
      captureGpsOnSubmit: true,
      fields: [
        { id: 'photo1', type: 'CAMERA', label: 'Photo 1', required: true, order: 1 },
        {
          id: 'photo2',
          type: 'CAMERA',
          label: 'Photo 2',
          required: false,
          order: 2,
          requiredWhen: { fieldId: '__subProgram__', op: 'eq', value: 'X' },
          visibleWhen: { fieldId: '__subProgram__', op: 'eq', value: 'X' },
        },
        { id: 'geo', type: 'GPS_POINT', label: 'Location', required: false, order: 3 },
      ],
    },
  };
  const geoNear = { lat: 12.9001, lng: 77.5001, accuracy: 10 };

  it("REJECTS a submit missing the 2nd photo for an outlet whose sub-program == 'X'", async () => {
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(subProgramForm);
    mockPrisma.outlet.findFirst.mockResolvedValue({ ...outletRow, programCategory: 'X' });
    await expect(
      service.submitCapture(user, {
        outletId: 'o1',
        formValues: { photo1: 'visibility-media/t1/a.jpg', geo: geoNear },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
  });

  it("ACCEPTS the same single-photo submit for an outlet whose sub-program == 'Y'", async () => {
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(subProgramForm);
    mockPrisma.outlet.findFirst.mockResolvedValue({ ...outletRow, programCategory: 'Y' });
    const res = await service.submitCapture(user, {
      outletId: 'o1',
      formValues: { photo1: 'visibility-media/t1/a.jpg', geo: geoNear },
    });
    expect(res.version).toBe(1);
    expect(mockPrisma.visibilityCapture.create).toHaveBeenCalled();
    // photo2 is hidden for 'Y' → never persisted.
    const createArg = mockPrisma.visibilityCapture.create.mock.calls[0][0].data;
    expect('photo2' in createArg.formValues).toBe(false);
  });

  it('IGNORES a client-sent __subProgram__ (server uses the outlet value → still requires the 2nd photo)', async () => {
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(subProgramForm);
    // Outlet really is 'X' (needs 2 photos); client spoofs 'Y' to try to drop the 2nd.
    mockPrisma.outlet.findFirst.mockResolvedValue({ ...outletRow, programCategory: 'X' });
    await expect(
      service.submitCapture(user, {
        outletId: 'o1',
        formValues: { photo1: 'visibility-media/t1/a.jpg', geo: geoNear, __subProgram__: 'Y' },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
  });

  it('never persists a reserved __subProgram__ key in the stored formValues', async () => {
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(subProgramForm);
    mockPrisma.outlet.findFirst.mockResolvedValue({ ...outletRow, programCategory: 'X' });
    const res = await service.submitCapture(user, {
      outletId: 'o1',
      formValues: {
        photo1: 'visibility-media/t1/a.jpg',
        photo2: 'visibility-media/t1/b.jpg',
        geo: geoNear,
        __subProgram__: 'spoof', // client-injected reserved key
      },
    });
    expect(res.version).toBe(1);
    const createArg = mockPrisma.visibilityCapture.create.mock.calls[0][0].data;
    expect('__subProgram__' in createArg.formValues).toBe(false);
    expect(createArg.formValues.photo1).toBe('visibility-media/t1/a.jpg');
    expect(createArg.formValues.photo2).toBe('visibility-media/t1/b.jpg');
  });

  it('re-derives sub-program context from the outlet on RESUBMIT too', async () => {
    mockPrisma.visibilityForm.findUnique.mockResolvedValue(subProgramForm);
    mockPrisma.outlet.findFirst.mockResolvedValue({ ...outletRow, programCategory: 'X' });
    // A REJECTED capture in the current window to resubmit over.
    mockPrisma.visibilityCapture.findFirst.mockImplementation((args: { where?: { status?: string } }) => {
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
    // Outlet is 'X' → the 2nd photo is still required on resubmit; omitting it is rejected.
    await expect(
      service.resubmitCapture(user, 'cap1', {
        formValues: { photo1: 'visibility-media/t1/a.jpg', geo: geoNear },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.visibilityCapture.update).not.toHaveBeenCalled();
  });

  // ── Partial re-capture merge (VISIBILITY-PER-PHOTO-APPROVAL) ─────────────────
  describe('partial re-capture merge over a CHANGES_REQUESTED capture', () => {
    const twoCamForm = {
      clientId: 't1',
      version: 3,
      formSchema: {
        captureGpsOnSubmit: false,
        fields: [
          { id: 'front', type: 'CAMERA', label: 'Front', required: true, order: 1 },
          { id: 'shelf', type: 'CAMERA', label: 'Shelf', required: true, order: 2 },
        ],
      },
    };
    // front APPROVED (carry-forward), shelf rejected (must be re-captured).
    const priorCapture = {
      id: 'cap1',
      status: 'CHANGES_REQUESTED',
      outletId: 'o1',
      currentVersion: 1,
      windowKey: CUR_WINDOW,
      formValues: {
        front: 'visibility-media/t1/front-APPROVED.jpg',
        shelf: 'visibility-media/t1/shelf-OLD.jpg',
      },
      photoReviews: { front: { status: 'APPROVED', reviewedAt: 'x', reviewedByUserId: 'admin1' } },
    };

    beforeEach(() => {
      mockPrisma.visibilityForm.findUnique.mockResolvedValue(twoCamForm);
      // No reference geo → the legacy fence allows+flags (keeps this test focused on the merge).
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ kycSubmissions: [] });
      mockPrisma.visibilityCapture.findFirst.mockImplementation((args: { where?: { status?: string } }) => {
        if (args?.where?.status === 'APPROVED') return Promise.resolve(null);
        return Promise.resolve(priorCapture);
      });
      mockPrisma.visibilityCapture.findUnique.mockResolvedValue(priorCapture);
    });

    it('carries the APPROVED photo forward, replaces only the rejected one, and ignores a payload that tries to replace the approved photo (anti-tamper)', async () => {
      const res = await service.resubmitCapture(user, 'cap1', {
        formValues: {
          front: 'visibility-media/t1/front-HACKED.jpg', // tamper attempt on the approved photo
          shelf: 'visibility-media/t1/shelf-NEW.jpg', // the legit re-capture
        },
      });
      expect(res.version).toBe(2);
      const updateArg = mockPrisma.visibilityCapture.update.mock.calls[0][0].data;
      expect(updateArg.status).toBe('SUBMITTED');
      // ANTI-TAMPER: the approved photo stays the STORED value, never the payload's.
      expect(updateArg.formValues.front).toBe('visibility-media/t1/front-APPROVED.jpg');
      // The rejected photo is replaced by the rep's new media.
      expect(updateArg.formValues.shelf).toBe('visibility-media/t1/shelf-NEW.jpg');
      // The approved review is carried; the rejected field's review is cleared (pending).
      expect(updateArg.photoReviews.front.status).toBe('APPROVED');
      expect(updateArg.photoReviews.shelf).toBeUndefined();
      // The version snapshot records the carried reviews too.
      const subArg = mockPrisma.visibilityCaptureSubmission.create.mock.calls[0][0].data;
      expect(subArg.photoReviews.front.status).toBe('APPROVED');
    });

    it('accepts a resubmit over a CHANGES_REQUESTED capture (re-open status honored)', async () => {
      const res = await service.resubmitCapture(user, 'cap1', {
        formValues: { shelf: 'visibility-media/t1/shelf-NEW.jpg' },
      });
      // front carried from the prior snapshot → both required photos present → passes validation.
      expect(res.version).toBe(2);
      expect(mockPrisma.visibilityCapture.update).toHaveBeenCalled();
    });
  });

  // ── haversine sanity ─────────────────────────────────────────────────────────
  it('haversineMeters ~0 for identical points and grows with separation', () => {
    expect(haversineMeters(12.9, 77.5, 12.9, 77.5)).toBeCloseTo(0, 5);
    expect(haversineMeters(12.9, 77.5, 12.9001, 77.5001)).toBeGreaterThan(5);
    expect(haversineMeters(12.9, 77.5, 12.9001, 77.5001)).toBeLessThan(50);
  });


  // ── APPLIES-TO (D9/D12): visibility programs / subPrograms narrow the type scope ─────────────
  describe('APPLIES-TO program scope', () => {
    let activeCfg: Record<string, unknown> = config;
    const scopedCfg = (vc: Record<string, unknown>) => {
      activeCfg = { ...config, ...vc };
      mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: activeCfg });
    };
    /**
     * Emulates the DB for the in-scope query: a `findFirst` on visibilityUniverseWhere (an `AND` with the rule) returns
     * the row only when it is in scope (the explain-function as the oracle); a plain lookup returns the row.
     */
    const outletDb = (row: Record<string, unknown>) =>
      mockPrisma.outlet.findFirst.mockImplementation(({ where }: any) => {
        const full = { isActive: true, deletedAt: null, deactivatedAt: null, kycIntent: null, ...row };
        if (where?.AND) {
          const universe = where.AND[1];
          expect(universe.AND?.[0] ?? universe).toMatchObject({ isActive: true, deactivatedAt: null, deletedAt: null });
          return Promise.resolve(visibilityOutOfScopeReason(full as any, activeCfg as any) ? null : full);
        }
        return Promise.resolve(full);
      });

    it('submit 400s an in-type outlet whose program is outside visibility programs, with the plain reason', async () => {
      scopedCfg({ programs: ['RLP'], subPrograms: [] });
      outletDb({ ...outletRow, programName: 'BSC', programCategory: null });
      const err = service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues });
      await expect(err).rejects.toThrow(BadRequestException);
      await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }))
        .rejects.toThrow("This outlet's programme / sub-programme is not part of the visibility programme.");
      expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
    });

    it('submit 400s on a sub-program mismatch, incl. a BLANK outlet sub-program (D4)', async () => {
      scopedCfg({ programs: [], subPrograms: ['Urban'] });
      outletDb({ ...outletRow, programName: 'RLP', programCategory: null });
      await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }))
        .rejects.toThrow(BadRequestException);
    });

    it('submit 400s an outlet the single in-scope rule excludes (not KYC-approved / deactivated / parked) — plain reason', async () => {
      scopedCfg({});
      outletDb({ ...outletRow, isActive: false });
      await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }))
        .rejects.toThrow('This outlet is not KYC-approved yet — visibility can be captured once its KYC is approved.');
      outletDb({ ...outletRow, deactivatedAt: new Date('2026-01-05T00:00:00Z') });
      await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }))
        .rejects.toThrow('This outlet is deactivated, so visibility cannot be captured for it.');
      outletDb({ ...outletRow, kycIntent: 'PARKED' });
      await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }))
        .rejects.toThrow('This outlet is marked Parked, so visibility cannot be captured for it.');
      outletDb({ ...outletRow, outletType: { code: 'WHS' } });
      await expect(service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues }))
        .rejects.toThrow('Outlet type WHS is not part of the visibility programme.');
      expect(mockPrisma.visibilityCapture.create).not.toHaveBeenCalled();
    });

    it('submit succeeds when the program matches case-insensitively', async () => {
      scopedCfg({ programs: ['rlp'], subPrograms: [] });
      outletDb({ ...outletRow, programName: 'RLP', programCategory: null });
      const res = await service.submitCapture(user, { outletId: 'o1', formValues: nearFormValues });
      expect(res.version).toBe(1);
    });

    it('getSalesEligible ANDs the program where onto the unchanged base where; unscoped → base only', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      scopedCfg({ programs: ['RLP'], subPrograms: [] });
      await service.getSalesEligible(user);
      const scopedWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(scopedWhere.AND[0]).toMatchObject({ clientId: 't1', outletType: { code: { in: ['SSS'] } } });
      expect(scopedWhere.AND[1]).toEqual({ AND: [{ OR: [{ programName: { equals: 'RLP', mode: 'insensitive' } }] }] });

      mockPrisma.outlet.findMany.mockClear();
      scopedCfg({ programs: [], subPrograms: [] });
      await service.getSalesEligible(user);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('AND');
      expect(where.outletType).toEqual({ code: { in: ['SSS'] } });
    });

    it('getOutletStatus: inScope/canCapture false + a plain reason when the program is excluded; true when unscoped', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      outletDb({ id: 'o1', outletCode: 'OC1', name: 'Shop 1', programName: 'BSC', programCategory: null, outletType: { code: 'SSS', name: 'R' } });
      scopedCfg({ programs: ['RLP'], subPrograms: [] });
      const scoped = await service.getOutletStatus(user, 'o1');
      expect(scoped.inScope).toBe(false);
      expect(scoped.canCapture).toBe(false);
      expect(scoped.notInScopeReason).toBe("This outlet's programme / sub-programme is not part of the visibility programme.");
      expect(scoped.outlet).toEqual({ outletId: 'o1', outletCode: 'OC1', outletName: 'Shop 1', outletType: { code: 'SSS', name: 'R' } });
      scopedCfg({});
      const unscoped = await service.getOutletStatus(user, 'o1');
      expect(unscoped.inScope).toBe(true);
      expect(unscoped.notInScopeReason).toBeNull();
    });

    it('getOutletStatus uses THE single rule: a not-KYC-approved outlet of an in-scope type is NOT in scope (no button)', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      scopedCfg({});
      outletDb({ id: 'o1', outletCode: 'OC1', name: 'Shop 1', isActive: false, programName: null, programCategory: null, outletType: { code: 'SSS', name: 'R' } });
      const res = await service.getOutletStatus(user, 'o1');
      expect(res).toMatchObject({
        inScope: false,
        canCapture: false,
        notInScopeReason: 'This outlet is not KYC-approved yet — visibility can be captured once its KYC is approved.',
      });
    });
  });
});
