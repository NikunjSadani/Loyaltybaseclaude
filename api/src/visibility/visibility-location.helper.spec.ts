import { visibilityLocationRefusal } from './visibility-location.helper';
import type { VisibilityFormSchema } from './visibility-types';

const fix = { lat: 12.9, lng: 77.5, accuracy: 12, capturedAt: '2026-11-18T05:00:00.000Z' };

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

describe('visibilityLocationRefusal (requireLocation ON)', () => {
  it('passes when every location-tagged photo carries a valid fix', () => {
    const values = { p1: { key: 'k1', geo: fix }, p2: { key: 'k2', geo: fix }, p3: 'k3', n: 4 };
    expect(visibilityLocationRefusal(perPhoto, values, new Set())).toBeNull();
  });

  it('refuses when a fence-required photo has no fix — names the photo', () => {
    const values = { p1: { key: 'k1' }, p2: { key: 'k2', geo: fix } };
    expect(visibilityLocationRefusal(perPhoto, values, new Set())).toMatch(/Shelf photo/);
  });

  it('refuses when a geotag photo has an out-of-range / garbage fix', () => {
    const values = { p1: { key: 'k1', geo: fix }, p2: { key: 'k2', geo: { lat: 999, lng: 77 } } };
    expect(visibilityLocationRefusal(perPhoto, values, new Set())).toMatch(/Board photo/);
  });

  it('ignores a CARRIED-forward approved photo (partial re-capture) — only new photos must carry a fix', () => {
    const values = { p1: { key: 'old' }, p2: { key: 'k2', geo: fix } };
    expect(visibilityLocationRefusal(perPhoto, values, new Set(['p1']))).toBeNull();
  });

  it('a photo field the rep left empty (optional) is not required to have a fix', () => {
    const values = { p1: { key: 'k1', geo: fix } };
    expect(visibilityLocationRefusal(perPhoto, values, new Set())).toBeNull();
  });

  it('but a capture with NO located photo at all (every tagged photo left empty) is refused', () => {
    expect(visibilityLocationRefusal(perPhoto, { p3: 'k3', n: 2 }, new Set())).not.toBeNull();
  });

  it('legacy GPS_POINT form: refuses with no / invalid GPS, passes with a valid one', () => {
    expect(visibilityLocationRefusal(legacy, { photo: 'k' }, new Set())).not.toBeNull();
    expect(visibilityLocationRefusal(legacy, { photo: 'k', gps: { lat: 'x', lng: 1 } }, new Set())).not.toBeNull();
    expect(visibilityLocationRefusal(legacy, { photo: 'k', gps: fix }, new Set())).toBeNull();
  });

  it('a form with NO location field at all is refused with a message telling Gifsy to add one', () => {
    const noGeo = { fields: [{ id: 'photo', type: 'CAMERA', label: 'Photo' }] } as never;
    expect(visibilityLocationRefusal(noGeo, { photo: 'k' }, new Set())).toMatch(/no location field/i);
  });
});
