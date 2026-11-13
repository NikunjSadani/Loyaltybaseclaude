import * as fs from 'fs';
import * as path from 'path';
import { buildDailyOpsDigest, digestWindow, kycPendingBuckets, needsAttention } from './daily-ops-digest-report';
import type { DigestInput, SectionResult, TenantDigest } from './report.types';

const IST = 330 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Build a UTC-ms instant from an IST wall-clock. */
const ist = (y: number, mo: number, d: number, h = 9, mi = 30) => Date.UTC(y, mo - 1, d, h, mi) - IST;
const ok = <T,>(data: T): SectionResult<T> => ({ ok: true, data });

const zeroBucket = { pending: 0, within: 0, nearing: 0, breached: 0 };

/** A tenant with every section loaded and empty. */
function quietTenant(clientId: string, name: string): TenantDigest {
  return {
    clientId,
    name,
    kyc: ok({ submitted: 0, approved: 0, rejected: 0, field: { ...zeroBucket }, gifsy: { ...zeroBucket } }),
    points: ok({ credited: 0, redeemed: 0, expired: 0, negativeWallets: 0 }),
    redemptions: ok({ requested: 0, completed: 0, failed: 0, failedRows: [] }),
    payouts: ok({
      batchesConfirmed: 0,
      batchPoints: 0,
      batchPayoutPaise: 0n,
      creditPaid: 0,
      creditPaidPaise: 0n,
      redemptionPaid: 0,
      redemptionPaidPaise: 0n,
      failedOrReturned: 0,
      awaitingUtr: 0,
      awaitingUtrPaise: 0n,
    }),
    messages: ok({ otpFailed: 0, smsFailed: 0, whatsappFailed: 0, broadcastFailed: 0 }),
  };
}

/** Realistic busy tenant (Bajaj-like: Hubble + Sales Import + Visibility). */
function busyTenant(): TenantDigest {
  return {
    clientId: 'bajaj',
    name: 'Bajaj Consumer Care',
    kyc: ok({
      submitted: 46,
      approved: 31,
      rejected: 4,
      field: { pending: 58, within: 30, nearing: 16, breached: 12 },
      gifsy: { pending: 21, within: 18, nearing: 1, breached: 2 },
    }),
    points: ok({ credited: 184250, redeemed: 96400, expired: 1200, negativeWallets: 5 }),
    redemptions: ok({
      requested: 37,
      completed: 29,
      failed: 3,
      failedRows: [
        { outlet: 'Shree Ganesh Traders (BJ-10421)', reward: 'Amazon Pay Voucher ₹500', reason: 'Hubble: insufficient balance' },
        { outlet: 'Maa Durga General Store (BJ-22870)', reward: 'Amazon Pay Voucher ₹1,000', reason: 'Hubble: product unavailable' },
        { outlet: 'Patel & Sons <Wholesale> (BJ-31002)', reward: 'Bank transfer ₹2,000', reason: 'Beneficiary account closed' },
      ],
    }),
    vouchers: ok({ issued: 22, failed: 2, stuckProcessing: 1, needsReconcile: 0 }),
    payouts: ok({
      batchesConfirmed: 2,
      batchPoints: 184250,
      batchPayoutPaise: 1_25_000_00n,
      creditPaid: 412,
      creditPaidPaise: 8_43_500_00n,
      redemptionPaid: 9,
      redemptionPaidPaise: 18_000_00n,
      failedOrReturned: 3,
      awaitingUtr: 120,
      awaitingUtrPaise: 2_40_000_00n,
    }),
    messages: ok({ otpFailed: 5, smsFailed: 0, whatsappFailed: 3, broadcastFailed: 0 }),
    visibility: ok({ submitted: 140, approved: 118, rejected: 9, pending: 63 }),
    salesImport: ok({
      processed: 1,
      failed: 0,
      openMonths: [
        { month: '2026-11', lastAppliedAtMs: ist(2026, 11, 12, 18, 5), targetsChangedSinceApply: true },
        { month: '2026-10', lastAppliedAtMs: ist(2026, 11, 3, 11, 0), targetsChangedSinceApply: false },
      ],
    }),
  };
}

const NOW = ist(2026, 11, 13); // Fri 13 Nov 2026, 09:30 IST

function input(tenants: TenantDigest[], extra: Partial<DigestInput> = {}): DigestInput {
  return { window: digestWindow(NOW), dateLabel: '13 Nov 2026', tenants, ...extra };
}

describe('digestWindow', () => {
  it('Tue–Sat: the last 24 h', () => {
    const tue = ist(2026, 11, 17);
    expect(digestWindow(tue)).toEqual({
      startMs: tue - 24 * HOUR,
      endMs: tue,
      label: 'Mon 16 Nov, 09:30 → Tue 17 Nov, 09:30 IST',
    });
    const sat = ist(2026, 11, 14);
    expect(digestWindow(sat).startMs).toBe(sat - 24 * HOUR);
    expect(digestWindow(sat).label).toBe('Fri 13 Nov, 09:30 → Sat 14 Nov, 09:30 IST');
  });

  it('Monday: reaches back to Saturday at the same time (covers Sunday)', () => {
    const mon = ist(2026, 11, 16);
    const w = digestWindow(mon);
    expect(w.startMs).toBe(mon - 48 * HOUR);
    expect(w.label).toBe('Sat 14 Nov, 09:30 → Mon 16 Nov, 09:30 IST');
  });

  it('uses the IST weekday, not the UTC one, at the day boundary', () => {
    // Mon 00:10 IST = Sun 18:40 UTC → still Monday in IST → 48 h.
    const monEarly = ist(2026, 11, 16, 0, 10);
    expect(new Date(monEarly).getUTCDay()).toBe(0);
    expect(digestWindow(monEarly).startMs).toBe(monEarly - 48 * HOUR);
    // Sun 23:50 IST = Sun 18:20 UTC → Sunday → 24 h.
    const sunLate = ist(2026, 11, 15, 23, 50);
    expect(digestWindow(sunLate).startMs).toBe(sunLate - 24 * HOUR);
  });
});

describe('kycPendingBuckets (reuses the two-stage business-hours SLA)', () => {
  const targets = { fieldHrs: 24, gifsyHrs: 96 };
  // Fri 13 Nov 2026 18:00 IST — the business clock counts Mon–Fri, so Thu/Fri submissions age normally.
  const now = ist(2026, 11, 13, 18, 0);

  it('splits field vs Gifsy and within / nearing / breached', () => {
    const rows = [
      { status: 'SUBMITTED', submittedAt: new Date(now - 2 * HOUR) }, // field, 2h → within
      { status: 'PENDING_SO_APPROVAL', submittedAt: new Date(now - 20 * HOUR) }, // field, 20h → nearing (≥18)
      { status: 'PENDING_ASM_APPROVAL', submittedAt: new Date(ist(2026, 11, 9, 9, 0)) }, // field, ~105h → breached
      {
        status: 'PENDING_GIFSY',
        submittedAt: new Date(ist(2026, 11, 2, 9, 0)),
        statusHistory: [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 3 * HOUR) }],
      }, // gifsy, 3h → within
      { status: 'APPROVED', submittedAt: new Date(now - 3 * HOUR) }, // decided → ignored
      { status: 'DRAFT', submittedAt: null }, // none → ignored
    ];
    const { field, gifsy } = kycPendingBuckets(rows, targets, new Set(), now);
    expect(field).toEqual({ pending: 3, within: 1, nearing: 1, breached: 1 });
    expect(gifsy).toEqual({ pending: 1, within: 1, nearing: 0, breached: 0 });
  });

  it('holidays pause the clock (a holiday-spanning field row is not breached)', () => {
    const rows = [{ status: 'SUBMITTED', submittedAt: new Date(ist(2026, 11, 12, 9, 0)) }]; // Thu 09:00 → Fri 18:00
    expect(kycPendingBuckets(rows, targets, new Set(), now).field.breached).toBe(1); // 33h > 24
    expect(kycPendingBuckets(rows, targets, new Set(['2026-11-12']), now).field.breached).toBe(0);
  });
});

describe('needsAttention', () => {
  it('a quiet tenant has nothing', () => {
    expect(needsAttention(quietTenant('deoleo', 'Deoleo'))).toEqual([]);
  });

  it('aggregates every abnormal item of a busy tenant', () => {
    expect(needsAttention(busyTenant())).toEqual([
      '2 KYCs breaching the Gifsy SLA',
      '12 KYCs breaching the field SLA',
      '5 negative wallets',
      '3 redemptions failed',
      'Hubble: 2 vouchers failed',
      'Hubble: 1 voucher stuck in processing > 30 min',
      '3 payouts failed or returned',
      '8 messages failed delivery',
      'Targets changed — recalculate November 2026',
    ]);
  });

  it('a failed section is itself an attention item', () => {
    const t = quietTenant('deoleo', 'Deoleo');
    t.points = { ok: false, error: 'timeout' };
    expect(needsAttention(t)).toEqual(["Couldn't load the Points section"]);
  });

  it('sales-import failures and Hubble reconcile flags count', () => {
    const t = quietTenant('x', 'X');
    t.vouchers = ok({ issued: 0, failed: 0, stuckProcessing: 0, needsReconcile: 2 });
    t.salesImport = ok({ processed: 0, failed: 1, openMonths: [] });
    expect(needsAttention(t)).toEqual(['Hubble: 2 orders need reconcile', 'Sales Import: 1 import failed']);
  });
});

describe('buildDailyOpsDigest', () => {
  it('subject carries the date and the number of tenants needing attention', () => {
    const r = buildDailyOpsDigest(input([busyTenant(), quietTenant('deoleo', 'Deoleo')]));
    expect(r.subject).toBe('Gifsy daily operations — 13 Nov 2026 — 1 need attention');
    expect(r.key).toBe('dailyDigest');
    expect(r.tenantsNeedingAttention).toBe(1);
    expect(r.attentionItems).toBe(9);
  });

  it('all quiet → still a full email that says so', () => {
    const r = buildDailyOpsDigest(input([quietTenant('deoleo', 'Deoleo')]));
    expect(r.subject).toBe('Gifsy daily operations — 13 Nov 2026 — 0 need attention');
    expect(r.html).toContain('All quiet — no tenant needs attention.');
    expect(r.html).toContain('All quiet — nothing to report.');
  });

  it('a quiet tenant renders as just its name + one line (every section hidden)', () => {
    const html = buildDailyOpsDigest(input([quietTenant('deoleo', 'Deoleo')])).html;
    const block = html.slice(html.indexOf('data-tenant="deoleo"'));
    expect(block).not.toContain('data-section=');
    expect(block).not.toContain('Needs attention');
    expect(block).toContain('All quiet — nothing to report.');
  });

  it('hides an empty section but shows a non-empty one', () => {
    const t = quietTenant('deoleo', 'Deoleo');
    t.points = ok({ credited: 500, redeemed: 0, expired: 0, negativeWallets: 0 });
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain('data-section="Points"');
    expect(html).not.toContain('data-section="Redemptions"');
    expect(html).not.toContain('All quiet — nothing to report.');
  });

  it('orders tenants by needs-attention desc, then name', () => {
    const a = quietTenant('a', 'Alpha');
    const z = quietTenant('z', 'Zulu');
    z.redemptions = ok({ requested: 1, completed: 0, failed: 1, failedRows: [] });
    const m = quietTenant('m', 'Mike');
    const html = buildDailyOpsDigest(input([a, m, z])).html;
    const pos = (id: string) => html.indexOf(`data-tenant="${id}"`);
    expect(pos('z')).toBeLessThan(pos('a'));
    expect(pos('a')).toBeLessThan(pos('m'));
    // The summary table follows the same order.
    expect(html.indexOf('>Zulu<')).toBeLessThan(html.indexOf('>Alpha<'));
  });

  it('escapes every dynamic value', () => {
    const t = busyTenant();
    t.name = '<script>alert(1)</script>';
    const r = buildDailyOpsDigest(input([t]));
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('Patel &amp; Sons &lt;Wholesale&gt;');
  });

  it('a failed section renders "couldn\'t load this section" (escaped reason) and the rest still renders', () => {
    const t = busyTenant();
    t.messages = { ok: false, error: 'relation "x" <does not exist>' };
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain("Couldn't load this section (relation &quot;x&quot; &lt;does not exist&gt;).");
    expect(html).toContain("Couldn&#39;t load the Messages section");
    expect(html).toContain('data-section="KYC"');
    expect(html).toContain('data-section="Payouts"');
  });

  it('gates Hubble / Visibility / Sales Import on their presence', () => {
    const quiet = buildDailyOpsDigest(input([quietTenant('deoleo', 'Deoleo')])).html;
    expect(quiet).not.toContain('Vouchers (Hubble)');
    expect(quiet).not.toContain('data-section="Visibility"');
    expect(quiet).not.toContain('data-section="Sales Import"');
    const busy = buildDailyOpsDigest(input([busyTenant()])).html;
    expect(busy).toContain('Vouchers (Hubble)');
    expect(busy).toContain('data-section="Visibility"');
    expect(busy).toContain('data-section="Sales Import"');
    expect(busy).toContain('Yes — recalculate');
  });

  it('lists failed redemptions and caps the rows at 10', () => {
    const t = quietTenant('x', 'X');
    const rows = Array.from({ length: 14 }, (_, i) => ({ outlet: `Outlet ${i}`, reward: 'R', reason: 'why' }));
    t.redemptions = ok({ requested: 14, completed: 0, failed: 14, failedRows: rows });
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain('Outlet 9<');
    expect(html).not.toContain('Outlet 10<');
    expect(html).toContain('Showing the latest 10 of 14.');
  });

  it('surfaces pre-login OTP failures (or their load failure) in the summary', () => {
    const r1 = buildDailyOpsDigest(input([quietTenant('d', 'D')], { unattributedOtpFailed: ok(4) }));
    expect(r1.html).toContain('4 OTPs failed delivery before login');
    expect(r1.html).not.toContain('All quiet — no tenant needs attention.');
    const r2 = buildDailyOpsDigest(input([quietTenant('d', 'D')], { unattributedOtpFailed: { ok: false, error: 'boom' } }));
    expect(r2.html).toContain("Couldn't load the pre-login OTP failures (boom).");
  });

  /**
   * The committed owner-facing sample (platform/docs/plans/samples/daily-ops-digest-sample.html) is a
   * golden file of this fixture. Regenerate after an intentional layout change with:
   *   UPDATE_DIGEST_SAMPLE=1 npx jest src/reports/scheduled/daily-ops-digest-report.spec.ts
   */
  it('matches the committed sample HTML (busy Bajaj-like + quiet Deoleo-like tenant)', () => {
    const quietDeoleo = quietTenant('deoleo', 'Deoleo India');
    const html = buildDailyOpsDigest(
      input([quietDeoleo, busyTenant()], { unattributedOtpFailed: ok(0) }),
    ).html;
    const file = path.resolve(__dirname, '../../../../platform/docs/plans/samples/daily-ops-digest-sample.html');
    if (process.env.UPDATE_DIGEST_SAMPLE === '1') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html, 'utf8');
    }
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(html.replace(/\r\n/g, '\n'));
  });
});
