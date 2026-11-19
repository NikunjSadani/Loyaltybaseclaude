import { classifyPhotoFence, outletMasterFencePolicy, outletMasterReference } from './geo-fence.helper';
import {
  haversineMeters,
  isValidGeo,
  evaluatePhotoFence,
} from './geo-fence.helper';
import type { GpsCapture } from './visibility-types';

/**
 * Per-photo geo-fence math (anti-fraud). Locks the verdict semantics behind the
 * Visibility (POSM) per-photo geotag so a future refactor can't silently loosen the
 * fence. See docs/plans/PER-PHOTO-GEOTAG-PLAN.md.
 */
describe('geo-fence.helper', () => {
  const REF = { lat: 19.076, lng: 72.8777 }; // Mumbai

  describe('haversineMeters', () => {
    it('is ~0 for identical points', () => {
      expect(haversineMeters(REF, REF)).toBeCloseTo(0, 5);
    });
    it('matches a known short distance (~1.11 km per 0.01° lat)', () => {
      const d = haversineMeters(REF, { lat: REF.lat + 0.01, lng: REF.lng });
      expect(d).toBeGreaterThan(1100);
      expect(d).toBeLessThan(1120);
    });
    it('is symmetric', () => {
      const a = { lat: 12.9, lng: 77.6 };
      expect(haversineMeters(a, REF)).toBeCloseTo(haversineMeters(REF, a), 3);
    });
  });

  describe('isValidGeo', () => {
    it('accepts an in-range fix', () => {
      expect(isValidGeo({ lat: 19, lng: 72 } as GpsCapture)).toBe(true);
    });
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['lat out of range', { lat: 999, lng: 72 }],
      ['lng out of range', { lat: 19, lng: 500 }],
      ['NaN lat', { lat: NaN, lng: 72 }],
      ['Infinity lng', { lat: 19, lng: Infinity }],
      ['missing lng', { lat: 19 }],
      ['non-number lat', { lat: '19', lng: 72 }],
    ])('rejects %s', (_label, g) => {
      expect(isValidGeo(g as unknown as GpsCapture)).toBe(false);
    });
  });

  describe('evaluatePhotoFence', () => {
    const near = { lat: REF.lat + 0.0002, lng: REF.lng } as GpsCapture; // ~22 m
    const far = { lat: REF.lat + 0.01, lng: REF.lng } as GpsCapture; // ~1.11 km

    it("returns 'inside' for a valid fix within the radius", () => {
      expect(evaluatePhotoFence(near, REF, 50)).toBe('inside');
    });
    it("returns 'outside' for a valid fix beyond the radius", () => {
      expect(evaluatePhotoFence(far, REF, 50)).toBe('outside');
    });
    it("treats the radius boundary as inside (<=)", () => {
      // A fix ~22 m out with a 22 m+ radius is inside; well within → inside.
      expect(evaluatePhotoFence(near, REF, 25)).toBe('inside');
    });
    it("returns 'unverifiable' when there is no reference geo", () => {
      expect(evaluatePhotoFence(near, null, 50)).toBe('unverifiable');
    });
    it("returns 'unverifiable' for an absent fix (per owner D1: flag, don't block)", () => {
      expect(evaluatePhotoFence(null, REF, 50)).toBe('unverifiable');
      expect(evaluatePhotoFence(undefined, REF, 50)).toBe('unverifiable');
    });
    it("returns 'unverifiable' for an out-of-range / garbage fix (never silently 'inside')", () => {
      expect(evaluatePhotoFence({ lat: 999, lng: 72 } as GpsCapture, REF, 50)).toBe(
        'unverifiable',
      );
      expect(
        evaluatePhotoFence({ lat: NaN, lng: NaN } as GpsCapture, REF, 50),
      ).toBe('unverifiable');
    });
  });
});

// ── Shared per-photo fence policy (capture verdict + review badges use ONE resolution) ──

describe('outlet-master fence policy + classifyPhotoFence', () => {
  it('reference = outlet-master coords guarded by isUsableReference (0,0 / missing → none); radius forced 200 m', () => {
    expect(outletMasterReference({ latitude: 12.9, longitude: 77.5 })).toEqual({ lat: 12.9, lng: 77.5 });
    expect(outletMasterReference({ latitude: '12.9', longitude: '77.5' })).toEqual({ lat: 12.9, lng: 77.5 }); // Prisma Decimal-ish
    expect(outletMasterReference({ latitude: 0, longitude: 0 })).toBeNull();
    expect(outletMasterReference({ latitude: null, longitude: 77.5 })).toBeNull();
    expect(outletMasterFencePolicy({ latitude: 12.9, longitude: 77.5 })).toEqual({
      reference: { lat: 12.9, lng: 77.5 }, radiusMeters: 200, accuracyBuffer: true, nullIslandUnverifiable: true,
    });
  });

  it('34 m away at 20 m accuracy → inside; > 200 m accuracy → unverifiable (buffer); far + precise → outside', () => {
    const p = outletMasterFencePolicy({ latitude: 12.9, longitude: 77.5 });
    expect(classifyPhotoFence({ lat: 12.9003, lng: 77.5001, accuracy: 20 }, p)).toEqual({ status: 'inside', accuracyTooLow: false });
    expect(classifyPhotoFence({ lat: 12.9003, lng: 77.5001, accuracy: 250 }, p)).toEqual({ status: 'unverifiable', accuracyTooLow: true });
    expect(classifyPhotoFence({ lat: 12.95, lng: 77.55, accuracy: 10 }, p).status).toBe('outside');
  });

  it('a policy without the buffer (non-gated tenants) behaves exactly like evaluatePhotoFence', () => {
    const p = { reference: { lat: 12.9, lng: 77.5 }, radiusMeters: 50, accuracyBuffer: false };
    expect(classifyPhotoFence({ lat: 12.9003, lng: 77.5001, accuracy: 250 }, p)).toEqual({ status: 'inside', accuracyTooLow: false });
  });
});

describe('classifyPhotoFence — 0,0 (audit #6)', () => {
  it('outlet-master policy: a 0,0 fix is unverifiable, never outside; without the flag it is fenced as before', () => {
    const gated = outletMasterFencePolicy({ latitude: 12.9, longitude: 77.5 });
    expect(classifyPhotoFence({ lat: 0, lng: 0, accuracy: 5 }, gated).status).toBe('unverifiable');
    expect(classifyPhotoFence({ lat: 0, lng: 0, accuracy: 5 }, { reference: { lat: 12.9, lng: 77.5 }, radiusMeters: 50, accuracyBuffer: false }).status).toBe('outside');
  });
});
