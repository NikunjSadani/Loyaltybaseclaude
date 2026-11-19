import { describe, expect, it } from 'vitest';
import { blockedSteps, iosTooOld, notificationGuide, parseIosVersion } from '../notification-guide';

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
