// Daily Ops Digest — Gifsy-wide sign-in security line (auth refresh round, 2026-11-20).
import { failedSections, gifsyWideItems } from './daily-ops-digest-report';

describe('Daily Ops Digest — sign-in security (Gifsy-wide)', () => {
  it('lists reuse kills, repeated handbacks and failed first-use marks when non-zero (never silent)', () => {
    const items = gifsyWideItems({
      authEvents: { ok: true, data: { reuseKills: 2, repeatedHandbacks: 1, firstUseMarkFailures: 3 } },
    } as any).map((i) => i.text);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/2 refresh-token reuses detected/),
        expect.stringMatching(/1 user with repeated session handbacks/),
        expect.stringMatching(/3 session first-use marks failed/),
      ]),
    );
  });

  it('L3/L4/M1: unknown-device refusals, failed handback audits and a missing INTERNAL_PROXY_SECRET are listed', () => {
    const items = gifsyWideItems({
      authEvents: {
        ok: true,
        data: { reuseKills: 0, repeatedHandbacks: 0, firstUseMarkFailures: 0, handbackAuditFailures: 2, deviceUnknownRefusals: 3, internalSecretConfigured: false },
      },
    } as any).map((i) => i.text);
    expect(items).toEqual([
      expect.stringMatching(/2 session handback audit writes failed/),
      expect.stringMatching(/3 returning devices had to sign in again because the device could not be identified/),
      expect.stringMatching(/INTERNAL_PROXY_SECRET is not configured .* device binding is OFF/),
    ]);
  });

  it('hidden when everything is zero', () => {
    expect(gifsyWideItems({ authEvents: { ok: true, data: { reuseKills: 0, repeatedHandbacks: 0, firstUseMarkFailures: 0 } } } as any)).toEqual([]);
  });

  it('a load failure is called out and marks the run degraded', () => {
    const input = { tenants: [], authEvents: { ok: false, error: 'db down' } } as any;
    expect(gifsyWideItems(input).map((i) => i.text)).toEqual([expect.stringMatching(/Couldn't load the sign-in security events/)]);
    expect(failedSections(input)).toEqual([{ key: 'gifsy/auth-events', label: 'Sign-in security events' }]);
  });
});
