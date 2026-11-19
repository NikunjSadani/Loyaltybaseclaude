import { visibilityLocationRefusal, VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE } from './visibility-location.helper';
import type { VisibilityFormSchema } from './visibility-types';

const fix = { lat: 12.9, lng: 77.5, accuracy: 12, capturedAt: '2026-11-18T05:00:00.000Z' };
const none = new Set<string>();

const perPhoto: VisibilityFormSchema = {
  fields: [
    { id: 'p1', type: 'CAMERA', label: 'Shelf photo', geoFenceRequired: true },
    { id: 'p2', type: 'CAMERA', label: 'Board photo', geotag: true },
    { id: 'p3', type: 'CAMERA', label: 'Plain photo' },
    { id: 'n', type: 'NUMBER', label: 'Facings' },
  ],
} as never;

const legacy: VisibilityFormSchema = {
  fields: [
    { id: 'photo', type: 'CAMERA', label: 'Photo' },
    { id: 'gps', type: 'GPS_POINT', label: 'Location' },
  ],
} as never;

/** For a fresh submit the stored values = the request values. */
const fresh = (schema: VisibilityFormSchema, v: Record<string, unknown>, captureGeo?: unknown) =>
  visibilityLocationRefusal(schema, v, none, v, captureGeo);

describe('visibilityLocationRefusal (requireLocation ON)', () => {
  it('passes when every new location-tagged photo carries a real fix', () => {
    expect(fresh(perPhoto, { p1: { key: 'k1', geo: fix }, p2: { key: 'k2', geo: fix }, p3: 'k3', n: 4 })).toBeNull();
  });

  it('refuses a new fence photo without a fix — names the photo', () => {
    expect(fresh(perPhoto, { p1: { key: 'k1' }, p2: { key: 'k2', geo: fix } })).toMatch(/"Shelf photo"/);
  });

  it('refuses an out-of-range fix and the 0,0 default', () => {
    expect(fresh(perPhoto, { p1: { key: 'k1', geo: fix }, p2: { key: 'k2', geo: { lat: 999, lng: 77 } } })).toMatch(/Board photo/);
    expect(fresh(perPhoto, { p1: { key: 'k1', geo: { lat: 0, lng: 0 } } })).toMatch(/Shelf photo/);
  });

  // ── Review scenario A: partial re-capture whose carried APPROVED photo had no geo ──
  it('REVIEW A: a carried-forward approved photo WITHOUT geo never causes a refusal (re-shot photo has a fix)', () => {
    const stored = { p1: { key: 'old-no-geo' }, p2: { key: 'new', geo: fix } };
    expect(visibilityLocationRefusal(perPhoto, stored, new Set(['p1']), { p2: stored.p2 })).toBeNull();
  });

  it('REVIEW A: only a NON-tagged photo was re-shot → the submit-time captureGeo is the fresh fix', () => {
    const stored = { p1: { key: 'old-no-geo' }, p3: 'new-plain' };
    expect(visibilityLocationRefusal(perPhoto, stored, new Set(['p1']), { p3: 'new-plain' }, fix)).toBeNull();
    // An old client that sends no captureGeo cannot prove a fresh location → refused (not the form message).
    const r = visibilityLocationRefusal(perPhoto, stored, new Set(['p1']), { p3: 'new-plain' });
    expect(r).toMatch(/Location is required/);
    expect(r).not.toBe(VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE);
  });

  it('merged-back earlier GPS values are NOT a fresh fix (only what this request sent counts)', () => {
    const stored = { photo: 'new', gps: fix }; // gps merged back from the earlier version
    expect(visibilityLocationRefusal(legacy, stored, none, { photo: 'new' })).not.toBeNull();
  });

  // ── Review scenario B: tagged photos optional / hidden ──
  it('REVIEW B: tagged photos optional and left empty → captureGeo satisfies the rule', () => {
    expect(fresh(perPhoto, { p3: 'k3', n: 2 }, fix)).toBeNull();
  });

  it('REVIEW B: a hidden tagged photo (dropped by validation) without geo is never required', () => {
    // request carried p1 without geo but validation dropped it (visibleWhen false) → not in stored values
    expect(visibilityLocationRefusal(perPhoto, { p3: 'k3' }, none, { p1: { key: 'x' }, p3: 'k3' }, fix)).toBeNull();
  });

  it('legacy GPS_POINT form: refuses with no / invalid GPS, passes with a valid one or captureGeo', () => {
    expect(fresh(legacy, { photo: 'k' })).not.toBeNull();
    expect(fresh(legacy, { photo: 'k', gps: { lat: 'x', lng: 1 } })).not.toBeNull();
    expect(fresh(legacy, { photo: 'k', gps: fix })).toBeNull();
    expect(fresh(legacy, { photo: 'k' }, fix)).toBeNull();
  });

  it('a form with NO location field and no captureGeo → names the FORM problem', () => {
    const noGeo = { fields: [{ id: 'photo', type: 'CAMERA', label: 'Photo' }] } as never;
    expect(fresh(noGeo, { photo: 'k' })).toBe(VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE);
    expect(fresh(noGeo, { photo: 'k' }, fix)).toBeNull(); // a new client's submit-time fix is enough
    expect(fresh(noGeo, { photo: 'k' }, { lat: 0, lng: 0 })).toBe(VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE);
  });
});
