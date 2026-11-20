/**
 * visibility-review-events helpers: the imported-capture rule (B1 — the shared visibility-portal-go-live rule) and the deterministic event order (S2).
 * The SQL side of the same rule is proven by visibility-review-events.migration.spec.ts (real Postgres).
 */
import { compareEventsNewestFirst } from './visibility-review-events';
import { isImportedVisibilityCapture as isImportedCapture, VISIBILITY_IMPORTED_KEY_MARKER } from './visibility-portal-go-live';

describe('isImportedVisibilityCapture (the rule the migration SQL mirrors)', () => {
  it('true when any photo key (bare string or {key}) is under /vendor-import/', () => {
    expect(VISIBILITY_IMPORTED_KEY_MARKER).toBe('/vendor-import/');
    expect(isImportedCapture({ a: 'visibility-media/bajaj/vendor-import/prod/x/OUT1/2025-06_v1.jpg' })).toBe(true);
    expect(isImportedCapture({ a: 'visibility-media/bajaj/n.jpg', b: { key: 'visibility-media/bajaj/vendor-import/OUT2/x.jpg', geo: null } })).toBe(true);
  });
  it('false for native captures and odd shapes', () => {
    expect(isImportedCapture({ a: 'visibility-media/bajaj/OUT1/front.jpg', b: { key: 'visibility-media/t/x.jpg' } })).toBe(false);
    expect(isImportedCapture({ note: 42, other: { notKey: '/vendor-import/' } })).toBe(false);
    expect(isImportedCapture(null)).toBe(false);
    expect(isImportedCapture(['visibility-media/bajaj/vendor-import/x.jpg'])).toBe(false);
    // "vendor-import" without the surrounding slashes is not the import folder.
    expect(isImportedCapture({ a: 'visibility-media/bajaj/my-vendor-imports.jpg' })).toBe(false);
  });
});

describe('compareEventsNewestFirst', () => {
  const t = new Date('2026-11-20T10:00:00.000Z');
  const e = (id: string, action: string, version = 1, at = t) => ({ id, action, version, createdAt: at }) as Parameters<typeof compareEventsNewestFirst>[0];
  it('newest first; same time → higher version, then result > whole-capture > photo > submit, then id', () => {
    const sorted = [
      e('a', 'SUBMITTED'),
      e('b', 'PHOTO_REJECTED'),
      e('c', 'CHANGES_REQUESTED_RESULT'),
      e('d', 'CAPTURE_APPROVED_ALL'),
      e('e', 'RESUBMITTED', 2),
      e('f', 'SUBMITTED', 1, new Date(t.getTime() + 1)),
      e('g', 'PHOTO_REJECTED'),
    ].sort(compareEventsNewestFirst).map((x) => x.id);
    expect(sorted).toEqual(['f', 'e', 'c', 'd', 'g', 'b', 'a']);
  });
});
