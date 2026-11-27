import {
  MAX_RECIPIENTS_PER_EMAIL,
  MAX_TOTAL_RECIPIENTS,
  chunkRecipients,
  maxRecipientsPerEmail,
  parsePayoutTrackerConfig,
  payoutTrackerEmailTarget,
  validateRecipientList,
} from './payout-tracker.config';

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
  it('cleans valid lists and throws on junk / empty / over 1,000', () => {
    expect(validateRecipientList(['A@x.com', 'a@x.com'])).toEqual(['a@x.com']);
    expect(() => validateRecipientList(['nope'])).toThrow(/not a valid email/);
    expect(() => validateRecipientList([])).toThrow(/empty/);
    expect(validateRecipientList(many(1000))).toHaveLength(1000);
    expect(() => validateRecipientList(many(1001))).toThrow(/1001 distinct.*at most 1000/);
  });
});

const many = (n: number, prefix = 'u') => Array.from({ length: n }, (_, i) => `${prefix}${i}@bajaj.com`);

describe('config: total recipient ceiling (1,000) + every address valid', () => {
  it('to + cc ≤ 1,000 distinct is fine (duplicates do not count); > 1,000 is invalid', () => {
    expect(parsePayoutTrackerConfig({ enabled: true, recipients: many(10), cc: [...many(990, 'c'), ...many(10)] }).kind).toBe('on');
    const r = parsePayoutTrackerConfig({ enabled: true, recipients: many(10), cc: many(991, 'c') });
    expect(r).toEqual({ kind: 'invalid', error: expect.stringMatching(/1001 distinct addresses — at most 1000/) });
    expect(MAX_TOTAL_RECIPIENTS).toBe(1000);
  });
  it('one bad address in a large cc list → invalid, naming it', () => {
    const r = parsePayoutTrackerConfig({ enabled: true, recipients: many(3), cc: [...many(300, 'c'), 'broken@'] });
    expect(r).toEqual({ kind: 'invalid', error: expect.stringMatching(/cc: "broken@" is not a valid email/) });
  });
});

describe('maxRecipientsPerEmail', () => {
  it('default 50; env override 1..500; anything else is an error', () => {
    expect(MAX_RECIPIENTS_PER_EMAIL).toBe(50);
    expect(maxRecipientsPerEmail({})).toEqual({ ok: true, cap: 50 });
    expect(maxRecipientsPerEmail({ PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL: ' 1 ' })).toEqual({ ok: true, cap: 1 });
    expect(maxRecipientsPerEmail({ PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL: '500' })).toEqual({ ok: true, cap: 500 });
    for (const bad of ['0', '501', '-5', '1e2', '20.5', 'fifty']) {
      expect(maxRecipientsPerEmail({ PAYOUT_TRACKER_MAX_RECIPIENTS_PER_EMAIL: bad })).toEqual({ ok: false, error: expect.stringMatching(/1\.\.500/) });
    }
  });
});

describe('chunkRecipients', () => {
  it('within the cap → ONE message, to/cc as given', () => {
    expect(chunkRecipients(['a@x.com'], ['c@x.com'], 50)).toEqual([{ to: ['a@x.com'], cc: ['c@x.com'] }]);
  });
  it('358 → 8 messages: first = all To then Cc fill; later chunks in To; order kept', () => {
    const to = many(3, 't');
    const cc = many(355, 'c');
    const chunks = chunkRecipients(to, cc, 50);
    expect(chunks).toHaveLength(8);
    expect(chunks[0]).toEqual({ to, cc: cc.slice(0, 47) });
    expect(chunks[1]).toEqual({ to: cc.slice(47, 97), cc: [] });
    expect(chunks[7]).toEqual({ to: cc.slice(347), cc: [] });
    expect(chunks.flatMap((c) => [...c.to, ...c.cc])).toEqual([...to, ...cc]);
  });
  it('a To list longer than the cap spans messages; dedupe is case-insensitive across to + cc', () => {
    const chunks = chunkRecipients(['A@x.com', 'b@x.com', 'a@X.com', 'c@x.com'], ['B@X.COM', 'd@x.com'], 2);
    expect(chunks).toEqual([
      { to: ['a@x.com', 'b@x.com'], cc: [] },
      { to: ['c@x.com', 'd@x.com'], cc: [] },
    ]);
  });
  it('only cc left (retry after the To addresses went) → they go in To', () => {
    expect(chunkRecipients([], ['c@x.com', 'd@x.com'], 50)).toEqual([{ to: ['c@x.com', 'd@x.com'], cc: [] }]);
    expect(chunkRecipients([], [], 50)).toEqual([]);
  });
});
