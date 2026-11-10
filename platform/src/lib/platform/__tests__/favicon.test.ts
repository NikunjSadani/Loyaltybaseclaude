import { describe, it, expect } from 'vitest';
import { resolveFaviconIcoHref } from '../favicon';

describe('resolveFaviconIcoHref', () => {
  it('prefers an absolute https faviconUrl (console-uploaded GCS asset)', () => {
    expect(
      resolveFaviconIcoHref(
        'https://storage.googleapis.com/gifsy-platform-files/branding/acme/fav.ico',
        'acme',
      ),
    ).toBe('https://storage.googleapis.com/gifsy-platform-files/branding/acme/fav.ico');
  });

  it('prefers an absolute http faviconUrl too', () => {
    expect(resolveFaviconIcoHref('http://cdn.example/fav.ico', 'acme')).toBe(
      'http://cdn.example/fav.ico',
    );
  });

  it('does NOT prefer a legacy local /favicons path — falls back to the canonical slug path (Deoleo no-regression)', () => {
    // deoleo's registry/DB value is `/favicons/deoleo.ico`; a LOCAL path always falls back
    // to the CANONICAL committed art at `/icons/deoleo/favicon.ico` (only absolute http(s)
    // URLs are preferred). `/favicons/deoleo.ico` is also committed now, but the helper
    // can't stat a URL, so it stays on the single canonical `/icons/<slug>/` location.
    expect(resolveFaviconIcoHref('/favicons/deoleo.ico', 'deoleo')).toBe(
      '/icons/deoleo/favicon.ico',
    );
  });

  it('falls back to the static slug path for an empty faviconUrl', () => {
    expect(resolveFaviconIcoHref('', 'clientb')).toBe('/icons/clientb/favicon.ico');
  });

  it('treats whitespace-only and nullish faviconUrl as empty', () => {
    expect(resolveFaviconIcoHref('   ', 'deoleo')).toBe('/icons/deoleo/favicon.ico');
    expect(resolveFaviconIcoHref(undefined, 'deoleo')).toBe('/icons/deoleo/favicon.ico');
    expect(resolveFaviconIcoHref(null, 'deoleo')).toBe('/icons/deoleo/favicon.ico');
  });

  it('does not treat a protocol-relative or bare path as absolute', () => {
    // Only http(s) absolute URLs win; anything else uses the committed static art.
    expect(resolveFaviconIcoHref('//cdn.example/fav.ico', 'acme')).toBe(
      '/icons/acme/favicon.ico',
    );
  });

  it('prefers a console-uploaded branding asset served by the public same-origin route', () => {
    const href = '/api/public/branding-assets?key=branding%2Fbajaj%2F2026-11%2Fuuid-fav.png';
    expect(resolveFaviconIcoHref(href, 'bajaj')).toBe(href);
  });

  it('does not prefer other /api paths or a route look-alike', () => {
    expect(resolveFaviconIcoHref('/api/gift-images?key=x', 'acme')).toBe('/icons/acme/favicon.ico');
    expect(resolveFaviconIcoHref('/api/public/branding-assets-evil?key=x', 'acme')).toBe(
      '/icons/acme/favicon.ico',
    );
  });
});
