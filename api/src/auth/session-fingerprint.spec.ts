import { deviceClass, sessionFingerprint } from './session-fingerprint';

const CHROME_ANDROID_130 = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const CHROME_ANDROID_131 = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36';
const SAFARI_IOS_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const SAFARI_IOS_18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36';

describe('sessionFingerprint (M-2: stable, version-free device class)', () => {
  it('a browser / OS UPDATE does not change it (Chrome 130→131 on Android 10→14; iOS 17→18 Safari)', () => {
    expect(sessionFingerprint({ userAgent: CHROME_ANDROID_130 })).toBe(sessionFingerprint({ userAgent: CHROME_ANDROID_131 }));
    expect(sessionFingerprint({ userAgent: SAFARI_IOS_17 })).toBe(sessionFingerprint({ userAgent: SAFARI_IOS_18 }));
  });

  it('a different browser family or OS family DOES change it', () => {
    const fps = [CHROME_ANDROID_131, SAFARI_IOS_18, CHROME_IOS, CHROME_WIN, EDGE_WIN, SAMSUNG].map((ua) => sessionFingerprint({ userAgent: ua }));
    expect(new Set(fps).size).toBe(fps.length);
  });

  it('classifies families correctly (Edge / Samsung are not "chrome"; CriOS is chrome on ios)', () => {
    expect(deviceClass(EDGE_WIN)).toEqual({ browser: 'edge', os: 'windows', mobile: false });
    expect(deviceClass(SAMSUNG)).toEqual({ browser: 'samsung', os: 'android', mobile: true });
    expect(deviceClass(CHROME_IOS)).toEqual({ browser: 'chrome', os: 'ios', mobile: true });
    expect(deviceClass(SAFARI_IOS_18)).toEqual({ browser: 'safari', os: 'ios', mobile: true });
  });

  it('the sec-ch-ua-mobile hint wins over the UA guess when present', () => {
    expect(deviceClass(CHROME_WIN, '?1').mobile).toBe(true);
    expect(deviceClass(CHROME_ANDROID_131, '?0').mobile).toBe(false);
  });

  it('no User-Agent → UNKNOWN (null)', () => {
    expect(sessionFingerprint({ userAgent: '' })).toBeNull();
    expect(sessionFingerprint({})).toBeNull();
  });
});
