import { computeDispatchSla, dispatchSlaApplies } from './dispatch-sla';

// 2026-06-01 is a Monday; keep gaps inside Mon–Wed so no weekend intrudes.
const MON = new Date('2026-06-01T02:00:00Z').getTime();
const H = 60 * 60_000;

describe('dispatch-sla (channel-aware §12)', () => {
  describe('dispatchSlaApplies', () => {
    it('applies to self-fulfilled channels', () => {
      expect(dispatchSlaApplies('GIFSY_WAREHOUSE')).toBe(true);
      expect(dispatchSlaApplies('BRAND')).toBe(true);
    });
    it('exempts Amazon + digital vouchers', () => {
      expect(dispatchSlaApplies('FULFILLED_BY_AMAZON')).toBe(false);
      expect(dispatchSlaApplies('DIGITAL_VOUCHER')).toBe(false);
    });
    it('treats an unrouted (null) channel as applicable', () => {
      expect(dispatchSlaApplies(null)).toBe(true);
    });
  });

  it('GIFSY_WAREHOUSE undispatched past the budget → breached', () => {
    const r = computeDispatchSla({
      fulfilmentChannel: 'GIFSY_WAREHOUSE',
      status: 'CONFIRMED',
      confirmedAtMs: MON,
      dispatchedAtMs: null,
      nowMs: MON + 50 * H,
      slaBusinessHours: 48,
    });
    expect(r.applicable).toBe(true);
    expect(r.elapsedBusinessHours).toBeCloseTo(50, 5);
    expect(r.breached).toBe(true);
  });

  it('GIFSY_WAREHOUSE within the budget → not breached', () => {
    const r = computeDispatchSla({
      fulfilmentChannel: 'GIFSY_WAREHOUSE',
      status: 'CONFIRMED',
      confirmedAtMs: MON,
      dispatchedAtMs: null,
      nowMs: MON + 10 * H,
      slaBusinessHours: 48,
    });
    expect(r.breached).toBe(false);
    expect(r.elapsedBusinessHours).toBeCloseTo(10, 5);
  });

  it('AMAZON is never breached (no platform dispatch SLA)', () => {
    const r = computeDispatchSla({
      fulfilmentChannel: 'FULFILLED_BY_AMAZON',
      status: 'CONFIRMED',
      confirmedAtMs: MON,
      dispatchedAtMs: null,
      nowMs: MON + 100 * H,
      slaBusinessHours: 48,
    });
    expect(r.applicable).toBe(false);
    expect(r.breached).toBe(false);
  });

  it('already dispatched → not breached even past the budget', () => {
    const r = computeDispatchSla({
      fulfilmentChannel: 'GIFSY_WAREHOUSE',
      status: 'DISPATCHED',
      confirmedAtMs: MON,
      dispatchedAtMs: MON + 60 * H,
      nowMs: MON + 200 * H,
      slaBusinessHours: 48,
    });
    expect(r.breached).toBe(false);
  });
});
