import { describe, expect, it } from 'vitest';
import { blockedSteps, detectAndroidBrowser, iosTooOld, notificationGuide, parseIosVersion } from '../notification-guide';

describe('parseIosVersion', () => {
  it('reads iPhone / iPad "OS x_y"', () => {
    expect(parseIosVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) Version/16.3')).toEqual({ major: 16, minor: 3 });
    expect(parseIosVersion('Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)')).toEqual({ major: 17, minor: 4 });
  });
  it('falls back to Version/x.y (iPad desktop mode)', () => {
    expect(parseIosVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/16.6 Safari/605.1.15')).toEqual({ major: 16, minor: 6 });
  });
  it('null when unreadable', () => {
    expect(parseIosVersion('')).toBeNull();
  });
});

describe('detectAndroidBrowser (real user agents)', () => {
  it('Chrome', () => {
    expect(
      detectAndroidBrowser(
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
      ),
    ).toBe('chrome');
  });
  it('Samsung Internet (also carries Chrome/)', () => {
    expect(
      detectAndroidBrowser(
        'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('samsung');
  });
  it('Firefox, Edge, Opera, Mi Browser and in-app WebViews are "other"', () => {
    expect(detectAndroidBrowser('Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0')).toBe('other');
    expect(
      detectAndroidBrowser(
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.2210.84',
      ),
    ).toBe('other');
    expect(
      detectAndroidBrowser(
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 OPR/79.0.4195.76078',
      ),
    ).toBe('other');
    expect(
      detectAndroidBrowser(
        'Mozilla/5.0 (Linux; U; Android 12; en-in; M2101K6P Build/SKQ1.210908.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.4.0-g',
      ),
    ).toBe('other');
    expect(
      detectAndroidBrowser(
        'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('other');
  });
});

describe('blocked steps per Android browser', () => {
  it('Samsung → ≡ menu path; other → generic site settings', () => {
    expect(blockedSteps('android', 'h', 'the X app', 'samsung')[0]).toMatch(/Samsung Internet and tap ≡ \(menu\) → Settings → Sites and downloads/);
    const other = blockedSteps('android', 'h', 'the X app', 'other');
    expect(other[0]).toBe('Open your browser’s site settings → Notifications.');
    expect(other.join(' ')).not.toMatch(/Chrome/);
  });
  it('no step depends on the reminder re-appearing after a reload', () => {
    expect(blockedSteps('desktop').join(' ')).not.toMatch(/^Reload the page, then/);
    expect(blockedSteps('desktop')[1]).toMatch(/turn on by themselves/);
  });
});

describe('iosTooOld', () => {
  it('16.4 is the floor; unknown is never "too old"', () => {
    expect(iosTooOld({ major: 16, minor: 3 })).toBe(true);
    expect(iosTooOld({ major: 15, minor: 9 })).toBe(true);
    expect(iosTooOld({ major: 16, minor: 4 })).toBe(false);
    expect(iosTooOld({ major: 17, minor: 0 })).toBe(false);
    expect(iosTooOld(null)).toBe(false);
  });
});

describe('notificationGuide', () => {
  const v17 = { major: 17, minor: 1 };
  it('granted → null', () => {
    expect(notificationGuide({ platform: 'android', state: 'granted', iosVersion: null })).toBeNull();
  });
  it('picks the kind per platform + state', () => {
    expect(notificationGuide({ platform: 'android', state: 'default', iosVersion: null })?.kind).toBe('enable');
    expect(notificationGuide({ platform: 'desktop', state: 'default', iosVersion: null })?.kind).toBe('enable');
    expect(notificationGuide({ platform: 'ios-app', state: 'default', iosVersion: v17 })?.kind).toBe('enable');
    expect(notificationGuide({ platform: 'ios-safari', state: 'unsupported', iosVersion: v17 })?.kind).toBe('install-first');
    expect(notificationGuide({ platform: 'ios-safari', state: 'default', iosVersion: v17 })?.kind).toBe('install-first');
    expect(notificationGuide({ platform: 'ios-app', state: 'unsupported', iosVersion: { major: 16, minor: 1 } })?.kind).toBe('ios-too-old');
    // Unknown iOS version (iPad desktop-mode UA) → neutral, never "can't show notifications".
    const ipad = notificationGuide({ platform: 'ios-app', state: 'unsupported', iosVersion: null });
    expect(ipad?.kind).toBe('unsupported');
    expect(ipad?.intro).toMatch(/16.4 or later/);
    expect(ipad?.intro).not.toMatch(/can’t show/);
    expect(notificationGuide({ platform: 'ios-app', state: 'default', iosVersion: null })?.kind).toBe('enable');
    expect(notificationGuide({ platform: 'android', state: 'unsupported', iosVersion: null })?.kind).toBe('unsupported');
    expect(notificationGuide({ platform: 'android', state: 'denied', iosVersion: null })?.kind).toBe('blocked');
  });
  it('blocked steps match the training deck', () => {
    const android = blockedSteps('android', 'bajaj.gifsy.in', 'the Bajaj Sales app');
    expect(android[0]).toMatch(/⋮.*Settings → Site settings → Notifications/);
    expect(android[1]).toBe('Under Blocked, tap bajaj.gifsy.in → Allow.');
    expect(android.join(' ')).toMatch(/Apps → the Bajaj Sales app \(or Chrome\) → Notifications → turn ON/);
    expect(android.join(' ')).toMatch(/Do Not Disturb/);
    const ios = blockedSteps('ios-app', 'x', 'the Bajaj Sales app');
    expect(ios[0]).toBe('Open the iPhone Settings app → Notifications.');
    expect(ios[1]).toMatch(/Allow Notifications/);
  });
});
