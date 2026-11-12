import {
  BRANDING_ASSET_ROUTE,
  brandingAssetRouteUrl,
  normaliseBrandingKey,
  toServableBrandingUrl,
} from './branding-asset';

const KEY = 'branding/bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-bajaj-logo.png';
const GCS = `https://storage.googleapis.com/gifsy-platform-files/${KEY}`;

describe('normaliseBrandingKey', () => {
  it('accepts a real uploaded branding key (the Bajaj prod shape)', () => {
    expect(normaliseBrandingKey(KEY)).toBe(KEY);
    expect(
      normaliseBrandingKey(
        'branding/bajaj/2026-11/3c151c05-c912-4a86-a24c-ae1b270826c4-bajaj-wordmark-white.png',
      ),
    ).not.toBeNull();
  });

  it.each([
    ['path traversal', 'branding/../kyc/2026-01/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-pan.jpg'],
    ['traversal inside the name', 'branding/bajaj/2026-11/../../kyc/x.png'],
    ['encoded traversal', 'branding/bajaj/2026-11/%2e%2e/kyc.png'],
    ['other prefix (KYC)', 'kyc/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-pan.png'],
    ['other prefix (gift)', 'gift-catalogue/_platform/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-g.png'],
    ['prefix look-alike', 'brandingX/bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-a.png'],
    ['leading slash', `/${KEY}`],
    ['backslash', 'branding\\bajaj\\2026-11\\5d3daa20-92f7-4ff8-8d2e-8ff59a429201-a.png'],
    ['double slash', 'branding//bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-a.png'],
    ['bare prefix', 'branding/'],
    ['missing uuid', 'branding/bajaj/2026-11/logo.png'],
    ['extra nesting', 'branding/bajaj/2026-11/x/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-a.png'],
    ['uppercase slug', 'branding/BAJAJ/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-a.png'],
    ['query/fragment chars', `${KEY}?x=1`],
    ['NUL byte', `${KEY}\u0000`],
    ['empty', ''],
  ])('rejects %s', (_label, key) => {
    expect(normaliseBrandingKey(key)).toBeNull();
  });

  it('rejects non-strings (array from ?key=a&key=b, undefined, objects)', () => {
    expect(normaliseBrandingKey([KEY, KEY])).toBeNull();
    expect(normaliseBrandingKey(undefined)).toBeNull();
    expect(normaliseBrandingKey({ key: KEY })).toBeNull();
  });

  it('rejects an over-long key', () => {
    expect(
      normaliseBrandingKey(
        `branding/bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-${'a'.repeat(600)}.png`,
      ),
    ).toBeNull();
  });
});

describe('brandingAssetRouteUrl', () => {
  it('builds the same-origin relative route URL (served via the FE /api → /v1 rewrite)', () => {
    expect(brandingAssetRouteUrl(KEY)).toBe(`${BRANDING_ASSET_ROUTE}?key=${encodeURIComponent(KEY)}`);
    expect(BRANDING_ASSET_ROUTE).toBe('/api/public/branding-assets');
  });
});

describe('toServableBrandingUrl', () => {
  it('maps a stored private-bucket branding URL to the public route', () => {
    expect(toServableBrandingUrl(GCS, 'gifsy-platform-files')).toBe(brandingAssetRouteUrl(KEY));
  });

  it.each([
    '/brand/deoleo-wordmark-white.png',
    '/brand/deoleo-wordmark-color.png',
    '/logos/deoleo.svg',
    '/favicons/deoleo.ico',
    '',
    'https://cdn.example.com/logo.png',
    // Same host, NON-branding prefix — never re-pointed at the public route.
    'https://storage.googleapis.com/gifsy-platform-files/kyc/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-pan.png',
    // A different bucket — the route only reads OUR bucket, so leave it alone.
    `https://storage.googleapis.com/someone-else/${KEY}`,
    // Traversal smuggled into a stored URL.
    'https://storage.googleapis.com/gifsy-platform-files/branding/../kyc/x.png',
    // Already-mapped values are idempotent.
    brandingAssetRouteUrl(KEY),
  ])('passes %p through untouched', (url) => {
    expect(toServableBrandingUrl(url, 'gifsy-platform-files')).toBe(url);
  });

  it('passes non-strings through untouched', () => {
    expect(toServableBrandingUrl(undefined, 'gifsy-platform-files')).toBeUndefined();
    expect(toServableBrandingUrl(null, 'gifsy-platform-files')).toBeNull();
  });

  it('defaults the bucket from GCS_BUCKET (BOM/CRLF-cleaned) or gifsy-platform-files', () => {
    const prev = process.env.GCS_BUCKET;
    try {
      delete process.env.GCS_BUCKET;
      expect(toServableBrandingUrl(GCS)).toBe(brandingAssetRouteUrl(KEY));
      process.env.GCS_BUCKET = '﻿other-bucket\r\n';
      expect(toServableBrandingUrl(GCS)).toBe(GCS);
      expect(toServableBrandingUrl(`https://storage.googleapis.com/other-bucket/${KEY}`)).toBe(
        brandingAssetRouteUrl(KEY),
      );
    } finally {
      if (prev === undefined) delete process.env.GCS_BUCKET;
      else process.env.GCS_BUCKET = prev;
    }
  });
});
