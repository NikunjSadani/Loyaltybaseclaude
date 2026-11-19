import {
  BOARD_FIX_MAX_AGE_MS,
  isFreshFixTime,
  isRealFix,
  FENCE_BLOCK_ENTITY,
  LOCATION_REQUIRED_FEATURE,
  isLocationRequiredFor,
  recordFenceBlock,
} from './location-gate.helper';

describe('location-gate.helper', () => {
  describe('isLocationRequiredFor', () => {
    it('is ON only for a SALES_* caller when features.requireLocation === true', () => {
      const on = { [LOCATION_REQUIRED_FEATURE]: true };
      for (const role of ['SALES_ISR', 'SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD', 'SALES_HO']) {
        expect(isLocationRequiredFor(on, role)).toBe(true);
      }
    });

    it('is OFF for non-sales initiators (partner self-enrollment, admins) even when the flag is on', () => {
      const on = { requireLocation: true };
      for (const role of ['SSS', 'WHOLESALER', 'CLIENT_ADMIN', 'GIFSY_ADMIN', 'MIS_USER']) {
        expect(isLocationRequiredFor(on, role)).toBe(false);
      }
    });

    it('is OFF when the flag is absent / false / not a real boolean (Deoleo default)', () => {
      expect(isLocationRequiredFor({}, 'SALES_ISR')).toBe(false);
      expect(isLocationRequiredFor(null, 'SALES_ISR')).toBe(false);
      expect(isLocationRequiredFor({ requireLocation: false }, 'SALES_ISR')).toBe(false);
      expect(isLocationRequiredFor({ requireLocation: 'true' }, 'SALES_ISR')).toBe(false);
    });
  });

  describe('recordFenceBlock', () => {
    it('writes ONE audit row (REJECT / LOCATION_FENCE_BLOCK) with the flow + distance + tenant', async () => {
      const create = jest.fn().mockResolvedValue({});
      await recordFenceBlock({ auditLog: { create } } as never, {
        actorId: 'u-rep',
        clientId: 'bajaj',
        flow: 'KYC',
        outletId: 'o-1',
        distanceM: 6512.4,
        accuracyM: 12,
      });
      expect(create).toHaveBeenCalledTimes(1);
      const data = create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        action: 'REJECT',
        entityType: FENCE_BLOCK_ENTITY,
        entityId: 'o-1',
        actorId: 'u-rep',
        metadata: { flow: 'KYC', clientId: 'bajaj', distanceM: 6512, accuracyM: 12 },
      });
    });

    it('never throws (a failed audit write must not change the rep-facing refusal)', async () => {
      const create = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(
        recordFenceBlock({ auditLog: { create } } as never, {
          actorId: 'u-rep', clientId: 'bajaj', flow: 'VISIBILITY', outletId: 'o-1', distanceM: null, accuracyM: null,
        }),
      ).resolves.toBeUndefined();
    });
  });
});


describe('isRealFix / isFreshFixTime', () => {
  it('a real fix is finite, in range, and not 0,0', () => {
    expect(isRealFix({ lat: 12.9, lng: 77.5 })).toBe(true);
    expect(isRealFix({ lat: 0, lng: 0 })).toBe(false);
    expect(isRealFix({ lat: 91, lng: 0 })).toBe(false);
    expect(isRealFix(null)).toBe(false);
  });

  it('board-photo fix must be recent (server clock), tolerating a little phone-clock skew', () => {
    const now = new Date();
    expect(isFreshFixTime(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe(true);
    expect(isFreshFixTime(new Date(now.getTime() - BOARD_FIX_MAX_AGE_MS - 1_000).toISOString(), now)).toBe(false);
    expect(isFreshFixTime(new Date(now.getTime() - 3 * 86_400_000).toISOString(), now)).toBe(false); // pre-filled re-KYC geo
    expect(isFreshFixTime(new Date(now.getTime() + 5 * 60_000).toISOString(), now)).toBe(true);
    expect(isFreshFixTime(new Date(now.getTime() + 60 * 60_000).toISOString(), now)).toBe(false);
    expect(isFreshFixTime('garbage', now)).toBe(false);
    expect(isFreshFixTime(undefined, now)).toBe(false);
  });

  it('AUDIT #3: a phone clock that is off is judged on the PHONE clock (clientNow), within a 24 h bound', () => {
    const now = new Date();
    const phoneNow = new Date(now.getTime() - 3 * 3_600_000); // phone 3 h behind
    const ts = new Date(phoneNow.getTime() - 5 * 60_000).toISOString(); // fix 5 min ago on the phone clock
    expect(isFreshFixTime(ts, now)).toBe(false); // server clock alone would refuse
    expect(isFreshFixTime(ts, now, phoneNow.toISOString())).toBe(true);
    // A days-old pre-filled fix still fails even if the phone claims an old "now" beyond the 24 h bound.
    const old = new Date(now.getTime() - 3 * 86_400_000);
    expect(isFreshFixTime(new Date(old.getTime() - 60_000).toISOString(), now, old.toISOString())).toBe(false);
    expect(isFreshFixTime(ts, now, 'garbage')).toBe(false);
  });
});

describe('fixTimeProblem (round 4 #1)', () => {
  it('classifies missing / future / old exactly like the window', () => {
    const { fixTimeProblem } = jest.requireActual('./location-gate.helper') as typeof import('./location-gate.helper');
    const now = new Date();
    expect(fixTimeProblem(undefined, now)).toBe('missing');
    expect(fixTimeProblem('x', now)).toBe('missing');
    expect(fixTimeProblem(new Date(now.getTime() + 11 * 60_000).toISOString(), now)).toBe('future');
    expect(fixTimeProblem(new Date(now.getTime() - 61 * 60_000).toISOString(), now)).toBe('old');
    expect(fixTimeProblem(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBeNull();
  });
});

describe('isPhoneClockWrong (round 3 #3)', () => {
  it('only a sent clock more than 24 h away from the server clock is "wrong"', () => {
    const { isPhoneClockWrong } = jest.requireActual('./location-gate.helper') as typeof import('./location-gate.helper');
    const now = new Date();
    expect(isPhoneClockWrong(undefined, now)).toBe(false); // old clients: not judged
    expect(isPhoneClockWrong(new Date(now.getTime() - 3_600_000).toISOString(), now)).toBe(false);
    expect(isPhoneClockWrong(new Date(now.getTime() - 25 * 3_600_000).toISOString(), now)).toBe(true);
    expect(isPhoneClockWrong(new Date(now.getTime() + 25 * 3_600_000).toISOString(), now)).toBe(true);
  });
});
