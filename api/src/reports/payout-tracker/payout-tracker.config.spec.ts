import { parsePayoutTrackerConfig, payoutTrackerEmailTarget, validateRecipientList } from './payout-tracker.config';

describe('parsePayoutTrackerConfig', () => {
  it('absent / null / enabled:false / enabled missing → off (inert)', () => {
    expect(parsePayoutTrackerConfig(undefined)).toEqual({ kind: 'off' });
    expect(parsePayoutTrackerConfig(null)).toEqual({ kind: 'off' });
    expect(parsePayoutTrackerConfig({ enabled: false, recipients: ['a@b.com'] })).toEqual({ kind: 'off' });
    expect(parsePayoutTrackerConfig({ recipients: ['a@b.com'] })).toEqual({ kind: 'off' });
    expect(parsePayoutTrackerConfig({ enabled: 'true', recipients: ['a@b.com'] })).toEqual({ kind: 'off' });
  });

  it('enabled with only recipients → defaults (10:00, Mon–Sat, holidays sent); emails lowercased + de-duped; cc minus to', () => {
    expect(parsePayoutTrackerConfig({ enabled: true, recipients: [' A@Bajaj.com ', 'a@bajaj.com'], cc: ['a@bajaj.com', 'Ops@Gifsy.in'] })).toEqual({
      kind: 'on',
      config: { enabled: true, recipients: ['a@bajaj.com'], cc: ['ops@gifsy.in'], sendTimeIst: '10:00', days: [1, 2, 3, 4, 5, 6], sendOnHolidays: true },
    });
  });

  it('explicit time / days / holidays honoured (days sorted, de-duped)', () => {
    const r = parsePayoutTrackerConfig({ enabled: true, recipients: ['a@b.com'], sendTimeIst: '09:30', days: [5, 1, 1], sendOnHolidays: false });
    expect(r).toEqual({ kind: 'on', config: expect.objectContaining({ sendTimeIst: '09:30', days: [1, 5], sendOnHolidays: false }) });
  });

  it.each([
    [{ enabled: true, recipients: [] }, /recipients is empty/],
    [{ enabled: true }, /recipients is empty/],
    [{ enabled: true, recipients: ['not-an-email'] }, /not a valid email/],
    [{ enabled: true, recipients: 'a@b.com' }, /must be a list/],
    [{ enabled: true, recipients: ['a@b.com'], cc: ['x@'] }, /cc: "x@"/],
    [{ enabled: true, recipients: ['a@b.com'], sendTimeIst: '25:00' }, /sendTimeIst/],
    [{ enabled: true, recipients: ['a@b.com'], sendTimeIst: '9:30' }, /sendTimeIst/],
    [{ enabled: true, recipients: ['a@b.com'], days: [0] }, /days/],
    [{ enabled: true, recipients: ['a@b.com'], days: [] }, /days/],
    [{ enabled: true, recipients: ['a@b.com'], sendOnHolidays: 'no' }, /sendOnHolidays/],
  ])('enabled but invalid → invalid with a readable error (%j)', (raw, re) => {
    const r = parsePayoutTrackerConfig(raw);
    expect(r.kind).toBe('invalid');
    expect((r as { error: string }).error).toMatch(re);
  });

  it('a non-object value → invalid (never silently off)', () => {
    expect(parsePayoutTrackerConfig('yes').kind).toBe('invalid');
    expect(parsePayoutTrackerConfig([1]).kind).toBe('invalid');
  });
});

describe('payoutTrackerEmailTarget (environment guard)', () => {
  it('LIVE=true → live; else internal test address → test; else off', () => {
    expect(payoutTrackerEmailTarget({ PAYOUT_TRACKER_EMAIL_LIVE: 'true' })).toEqual({ mode: 'live' });
    expect(payoutTrackerEmailTarget({ PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: ' QA@gifsy.in ' })).toEqual({ mode: 'test', to: 'qa@gifsy.in' });
    expect(payoutTrackerEmailTarget({})).toEqual({ mode: 'off' });
  });
  it('a non-internal test address is refused (invalid-test), never used', () => {
    expect(payoutTrackerEmailTarget({ PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT: 'someone@bajaj.com' })).toEqual({ mode: 'invalid-test', value: 'someone@bajaj.com' });
  });
});

describe('validateRecipientList', () => {
  it('cleans valid lists and throws on junk / empty', () => {
    expect(validateRecipientList(['A@x.com', 'a@x.com'])).toEqual(['a@x.com']);
    expect(() => validateRecipientList(['nope'])).toThrow(/not a valid email/);
    expect(() => validateRecipientList([])).toThrow(/empty/);
  });
});
