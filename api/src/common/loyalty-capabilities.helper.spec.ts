import {
  resolveCapabilities,
  TRADE_CAPABILITIES,
  EMPLOYEE_CAPABILITIES,
} from './loyalty-capabilities.helper';

describe('resolveCapabilities (Employee Rewards Phase 0)', () => {
  it('TRADE_LOYALTY → the trade defaults (compliance ON, outlet earner)', () => {
    expect(resolveCapabilities('TRADE_LOYALTY', null)).toEqual(TRADE_CAPABILITIES);
  });

  it('EMPLOYEE_REWARDS → the employee defaults (compliance OFF, employee earner, celebratory + vendor ON)', () => {
    expect(resolveCapabilities('EMPLOYEE_REWARDS', null)).toEqual(EMPLOYEE_CAPABILITIES);
  });

  it('fail-safe: unknown / null / undefined loyaltyType → TRADE defaults (never the compliance-off posture)', () => {
    expect(resolveCapabilities(null)).toEqual(TRADE_CAPABILITIES);
    expect(resolveCapabilities(undefined)).toEqual(TRADE_CAPABILITIES);
    expect(resolveCapabilities('SOMETHING_ELSE')).toEqual(TRADE_CAPABILITIES);
  });

  it('per-client boolean override via features.capabilities is applied sparsely', () => {
    const caps = resolveCapabilities('EMPLOYEE_REWARDS', { capabilities: { tds: true } });
    expect(caps.tds).toBe(true); // overridden on
    expect(caps.kyc).toBe(false); // untouched employee default
    expect(caps.earnerModel).toBe('EMPLOYEE');
  });

  it('ignores non-boolean overrides and never mutates the shared default objects', () => {
    const caps = resolveCapabilities('TRADE_LOYALTY', { capabilities: { kyc: 'nope', gst: 0 } });
    expect(caps.kyc).toBe(true); // non-boolean ignored → default kept
    expect(caps.gst).toBe(true);
    expect(TRADE_CAPABILITIES.kyc).toBe(true); // shared constant unmutated
  });

  it('earnerModel is NOT overridable — it follows loyaltyType', () => {
    const caps = resolveCapabilities('TRADE_LOYALTY', {
      capabilities: { earnerModel: 'EMPLOYEE' },
    });
    expect(caps.earnerModel).toBe('OUTLET');
  });

  it('tolerates a malformed features blob', () => {
    expect(resolveCapabilities('EMPLOYEE_REWARDS', { capabilities: 'x' } as never)).toEqual(
      EMPLOYEE_CAPABILITIES,
    );
    expect(resolveCapabilities('TRADE_LOYALTY', {})).toEqual(TRADE_CAPABILITIES);
  });
});
