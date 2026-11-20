/**
 * visibilityPortalGoLive / isImportedVisibilityCapture — imported old-app history is recognised by the re-hosted photo
 * path (/vendor-import/), never by "no rep recorded"; go-live = the earliest receive time of a non-imported capture.
 */
import { isImportedVisibilityCapture, visibilityPortalGoLive, VISIBILITY_IMPORTED_KEY_MARKER } from './visibility-portal-go-live';
import { isWindowInFrequency, visibilityReportScopeError, windowRangeUtc } from './visibility-report-scope';

describe('isImportedVisibilityCapture', () => {
  it('true for a bare-key or {key} photo under /vendor-import/, false otherwise', () => {
    expect(isImportedVisibilityCapture({ w1: 'visibility-media/bajaj/vendor-import/prod/b/A1/2026-11_v1.jpg' })).toBe(true);
    expect(isImportedVisibilityCapture({ w1: { key: 'visibility-media/bajaj/vendor-import/x.jpg', geo: { lat: 1, lng: 2 } } })).toBe(true);
    expect(isImportedVisibilityCapture({ w1: 'visibility-media/bajaj/2026-11/a.jpg', note: 'vendor-import' })).toBe(false);
    expect(isImportedVisibilityCapture(null)).toBe(false);
    expect(isImportedVisibilityCapture(['visibility-media/bajaj/vendor-import/x.jpg'])).toBe(false);
  });
});

describe('visibilityPortalGoLive', () => {
  it('one tenant-scoped MIN(receivedAt) excluding captures with an imported photo', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ goLive: new Date('2026-11-05T09:31:00Z') }]);
    const at = await visibilityPortalGoLive({ $queryRaw: queryRaw as never }, 'bajaj');
    expect(at?.toISOString()).toBe('2026-11-05T09:31:00.000Z');
    const sql = queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('MIN("receivedAt")');
    expect(sql.sql).toContain('NOT LIKE');
    expect(sql.values).toEqual(['bajaj', `%${VISIBILITY_IMPORTED_KEY_MARKER}%`]);
  });
  it('null when every capture is imported / there are none', async () => {
    expect(await visibilityPortalGoLive({ $queryRaw: jest.fn().mockResolvedValue([{ goLive: null }]) as never }, 'x')).toBeNull();
  });
});

describe('report scope helpers', () => {
  it('a window outside the current frequency has no guessed dates', () => {
    expect(isWindowInFrequency('2026-11-P3', 1)).toBe(false);
    expect(isWindowInFrequency('2026-11-P1', 1)).toBe(true);
    expect(() => windowRangeUtc('2026-11-P3', 1)).toThrow();
    expect(windowRangeUtc('2026-11-P1', 1)).toEqual({ start: new Date('2026-10-31T18:30:00Z'), end: new Date('2026-11-30T18:30:00Z') });
  });
  it('malformed window → "That window isn\'t valid."', () => {
    expect(visibilityReportScopeError({ windowKey: 'nope' }, 1, new Date('2026-11-20T06:00:00Z'), false)).toBe("That window isn't valid.");
  });
});
