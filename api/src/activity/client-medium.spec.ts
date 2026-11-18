import { activityContextFromRequest, deviceFromUserAgent, parseClientMedium } from './client-medium';

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadLegacy: 'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  nodeFetch: 'node',
  curl: 'curl/8.4.0',
};

describe('parseClientMedium (untrusted X-Client-Medium header)', () => {
  it.each([
    ['app', 'app'],
    ['browser', 'browser'],
    ['  APP ', 'app'],
    ['Browser', 'browser'],
  ])('accepts %p → %p', (raw, want) => {
    expect(parseClientMedium(raw)).toBe(want);
  });

  it.each([[undefined], [null], [''], ['standalone'], ['app,browser'], [['app', 'app']], [42], ['app; drop table']])(
    'anything else (%p) → unknown',
    (raw) => {
      expect(parseClientMedium(raw)).toBe('unknown');
    },
  );
});

describe('deviceFromUserAgent', () => {
  it.each([
    ['androidChrome', 'phone'],
    ['androidTablet', 'phone'], // tablets count as phones (Android UA also says "Linux" — phone wins)
    ['iphone', 'phone'],
    ['ipadLegacy', 'phone'],
    ['windowsChrome', 'computer'],
    ['macSafari', 'computer'], // NB: iPadOS desktop-mode UAs look exactly like this → computer (documented limit)
    ['linuxFirefox', 'computer'],
    ['chromebook', 'computer'],
    ['nodeFetch', 'unknown'],
    ['curl', 'unknown'],
  ] as const)('%s → %s', (key, want) => {
    expect(deviceFromUserAgent(UA[key])).toBe(want);
  });

  it('empty / missing / non-string → unknown', () => {
    expect(deviceFromUserAgent('')).toBe('unknown');
    expect(deviceFromUserAgent('   ')).toBe('unknown');
    expect(deviceFromUserAgent(undefined)).toBe('unknown');
    expect(deviceFromUserAgent(['a'])).toBe('unknown');
  });
});

describe('activityContextFromRequest', () => {
  it('reads the lower-cased Node headers', () => {
    expect(
      activityContextFromRequest({ headers: { 'x-client-medium': 'app', 'user-agent': UA.androidChrome } }),
    ).toEqual({ medium: 'app', device: 'phone' });
    expect(
      activityContextFromRequest({ headers: { 'x-client-medium': 'browser', 'user-agent': UA.windowsChrome } }),
    ).toEqual({ medium: 'browser', device: 'computer' });
  });

  it('a missing header / missing request → unknown, never throws', () => {
    expect(activityContextFromRequest({ headers: {} })).toEqual({ medium: 'unknown', device: 'unknown' });
    expect(activityContextFromRequest(undefined)).toEqual({ medium: 'unknown', device: 'unknown' });
    expect(activityContextFromRequest(null)).toEqual({ medium: 'unknown', device: 'unknown' });
    const hostile = {
      get headers(): never {
        throw new Error('boom');
      },
    };
    expect(activityContextFromRequest(hostile)).toEqual({ medium: 'unknown', device: 'unknown' });
  });
});
