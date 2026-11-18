import * as fs from 'fs';
import * as path from 'path';

/**
 * TRIPWIRE for the Daily Operations Digest's "recorded time" clocks (DAILY-OPS-DIGEST.md, H1 / D5):
 *   - credit payouts PAID / FAILED are counted by CreditPayoutEntry.updatedAt,
 *   - redemption payouts FAILED / REVERSED by PayoutTransaction.updatedAt.
 * That is only correct while NO code path writes a row that is already PAID (credit entry) or already
 * FAILED / REVERSED (payout transaction) without changing its status — any such write would bump updatedAt
 * and re-count an old payment / failure in a later digest.
 *
 * This spec lists EVERY Prisma update / updateMany / upsert / raw-SQL UPDATE on the two tables and requires
 * each to match a reviewed site whose guard keeps it off those rows. A NEW write site (e.g. the wallet
 * reversal engine) fails here until it is reviewed: either guard it off PAID / FAILED rows and add it below
 * with the reason, or give the digest a dedicated stamp (e.g. `paidRecordedAt`) and switch the digest to it.
 */
const SRC = path.resolve(__dirname, '../..');

interface Site {
  file: string;
  /** Must appear in the call's next lines — the guard that keeps it off already-settled rows. */
  fingerprint: RegExp;
  reason: string;
}

const CREDIT_ENTRY_SITES: Site[] = [
  {
    file: 'credits/credits.service.ts',
    fingerprint: /status: \{ in: \['PENDING', 'FAILED'\] \}/,
    reason: 'bank-file download claim: only PENDING / FAILED → PROCESSING',
  },
  {
    file: 'credits/credits.service.ts',
    fingerprint: /data: \{ tdsDeductedPaise: d\.tdsDeductedPaise \}/,
    reason: 'TDS stamp in the SAME download tx, only for entries that tx just claimed (PROCESSING)',
  },
  {
    file: 'credits/credits.service.ts',
    fingerprint: /status: 'PROCESSING' \}/,
    reason: 'UTR apply: the only PROCESSING → PAID / FAILED flip',
  },
  {
    file: 'credits/credits.service.ts',
    fingerprint: /status: cur\.status as CreditEntryStatus/,
    reason: 'reversal: PENDING / FAILED → REVERSED (a PAID entry is skipped before this, untouched)',
  },
  {
    file: 'credits/credits.service.ts',
    fingerprint: /status: 'PROCESSING', downloadId: rec\.id \}/,
    reason:
      'A-H2 settle-by-TDS in the download tx: PROCESSING (claimed by THIS download) → PAID — a status change; the digest ' +
      'counts it as "settled by TDS withholding" (utr TDS-WITHHELD-…), never as paid money',
  },
  {
    file: 'credits/credits.service.ts',
    fingerprint: /status: 'PAID', tdsDeductedPaise: withheld \}/,
    reason: 'reversal of a FULLY withheld entry: PAID → REVERSED (a status change, guarded on the withholding read)',
  },
  {
    file: 'invoices/invoices.service.ts',
    fingerprint: /where: \{ id: \{ in: info\.entryIds \} \},\s*data: \{ autoInvoiceId: existing\.id \}/,
    reason: 'generateForBatch: links entries created moments ago in the same confirm tx (PENDING)',
  },
  {
    file: 'invoices/invoices.service.ts',
    fingerprint: /where: \{ id: \{ in: info\.entryIds \} \},\s*data: \{ autoInvoiceId: created\.id \}/,
    reason: 'generateForBatch: links entries created moments ago in the same confirm tx (PENDING)',
  },
];

const PAYOUT_TXN_SITES: Site[] = [
  {
    file: 'payouts/payouts.service.ts',
    fingerprint: /batchId: null,\s*status: 'PENDING'/,
    reason: 'assign to batch: PENDING only',
  },
  {
    file: 'payouts/payouts.service.ts',
    fingerprint: /where: \{ id: vt\.id, status: 'PENDING' \}/,
    reason: 'disburse: PENDING → INITIATED only',
  },
  {
    file: 'payouts/payouts.service.ts',
    fingerprint: /where: \{ id: txn\.id, status: txn\.status \}/,
    reason: 'UTR report: terminal rows are skipped, except FAILED/REVERSED → SUCCESS (paid off-platform) — the status changes',
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** Every write call on `model` (Prisma client accessor) with the next ~14 lines of source. */
function writeSites(model: string): Array<{ file: string; line: number; snippet: string }> {
  const call = new RegExp(`\\.${model}\\s*\\.\\s*(update|updateMany|upsert)\\s*\\(`, 'g');
  const out: Array<{ file: string; line: number; snippet: string }> = [];
  for (const abs of sourceFiles(SRC)) {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let m = call.exec(text); m; m = call.exec(text)) {
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      out.push({ file: path.relative(SRC, abs).replace(/\\/g, '/'), line, snippet: lines.slice(line - 1, line + 14).join('\n') });
    }
  }
  return out;
}

function check(model: string, sites: Site[]) {
  const found = writeSites(model);
  const unmatched = found.filter((f) => !sites.some((s) => s.file === f.file && s.fingerprint.test(f.snippet)));
  expect(unmatched.map((u) => `${u.file}:${u.line}`)).toEqual([]);
  for (const s of sites) {
    const hits = found.filter((f) => f.file === s.file && s.fingerprint.test(f.snippet));
    expect({ site: s.reason, hits: hits.length }).toEqual({ site: s.reason, hits: 1 });
  }
  expect(found).toHaveLength(sites.length);
}

describe('Digest recorded-time clocks — no code path rewrites a settled payout row', () => {
  it('CreditPayoutEntry: every write site is reviewed and never touches a PAID entry', () => {
    check('creditPayoutEntry', CREDIT_ENTRY_SITES);
  });

  it('PayoutTransaction: every write site is reviewed and never rewrites a FAILED / REVERSED row in place', () => {
    check('payoutTransaction', PAYOUT_TXN_SITES);
  });

  it('no raw-SQL UPDATE on either table', () => {
    const raw = /UPDATE\s+"?(credit_payout_entries|payout_transactions)"?/i;
    const hits = sourceFiles(SRC).filter((f) => raw.test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((h) => path.relative(SRC, h))).toEqual([]);
  });

  it('the tripwire itself catches a new unguarded write (self-test on a synthetic snippet)', () => {
    const snippet = 'await tx.creditPayoutEntry.updateMany({\n  where: { batchId },\n  data: { narration: "x" },\n});';
    expect(CREDIT_ENTRY_SITES.some((s) => s.fingerprint.test(snippet))).toBe(false);
  });
});
