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

  it('does NOT prefer a legacy local /favicons path — falls back to the static slug path (Deoleo no-regression)', () => {
    // deoleo's registry/DB value is `/favicons/deoleo.ico`, a file that was never
    // committed; the committed art is `/icons/deoleo/favicon.ico`.
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
});
