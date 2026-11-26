'use client';

/**
 * Payout status breakdown of ONE upload (every admin role): per upload and per field line — Paid, In bank file,
 * Pending, Failed, Reversed, Cancelled (amount + rows) + a Total that must equal the payout rows; points separately;
 * the Fund Reconciliation view of the same rows; every server note shown (amber); a red warning when the figures
 * don't reconcile. Clicking a status filters the row list below (onPick).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiJson, BUCKET_ORDER, inr, plural,
  type Breakdown, type BucketKey, type Money, type PayoutStatusData,
} from './payout-cancel-shared';

const BUCKET_LABEL: Record<BucketKey, string> = {
  PAID:       'Paid',
  PROCESSING: 'In bank file (awaiting bank result)',
  PENDING:    'Pending (not yet in a bank file)',
  FAILED:     'Failed',
  REVERSED:   'Reversed',
  CANCELLED:  'Cancelled',
};

interface Props {
  batchId: string;
  /** Bumped by the parent after a cancellation so the figures reload. */
  refreshKey: number;
  /** A status (and optionally a field) was clicked — filter the row list to it. */
  onPick: (status: BucketKey, fieldId?: string) => void;
  /** The loaded figures (the parent uses the field list for its filter). */
  onLoaded?: (data: PayoutStatusData) => void;
}

export default function PayoutStatusBreakdown({ batchId, refreshKey, onPick, onLoaded }: Props) {
  const [data, setData] = useState<PayoutStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    const r = await apiJson<PayoutStatusData>(`/api/admin/credits/batches/${encodeURIComponent(batchId)}/payout-status`);
    if (req !== reqRef.current) return;
    setLoading(false);
    if (!r.ok || !r.data?.overall) {
      setError(r.ok ? 'The status breakdown came back empty.' : r.error);
      return;
    }
    setData(r.data);
    onLoadedRef.current?.(r.data);
  }, [batchId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (error) {
    return (
      <div role="alert" data-testid="payout-status-error" className="mx-5 my-3 flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
        <span>Couldn&apos;t load the payout status breakdown: {error}</span>
        <button type="button" onClick={() => void load()} className="px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50">
          Retry loading the status breakdown
        </button>
      </div>
    );
  }
  if (!data) {
    return <p role="status" className="px-5 py-3 text-xs text-gray-500 animate-pulse">Loading payout status…</p>;
  }

  const p = data.points;
  return (
    <section
      aria-label="Payout status breakdown"
      data-testid="payout-status-breakdown"
      className={`px-5 py-4 border-b border-gray-100 space-y-3 ${loading ? 'opacity-60' : ''}`}
      aria-busy={loading || undefined}
    >
      <h4 className="text-sm font-semibold text-gray-900">Payout status</h4>

      {!data.reconciles && (
        <div role="alert" data-testid="payout-status-not-reconciled" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-800">
          <p className="font-semibold">These figures do not add up.</p>
          <p data-testid="payout-status-not-reconciled-figures">
            Upload total {inr(data.uploadTotalPaise)} vs payout rows {inr(data.entriesTotalPaise)} (difference{' '}
            {inr(Math.abs(data.uploadTotalPaise - data.entriesTotalPaise))}).
          </p>
          {data.notes.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5" data-testid="payout-status-not-reconciled-notes">
              {data.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          <p>Do not act on this upload until Gifsy tech has checked it.</p>
        </div>
      )}

      {/* When the figures don't reconcile the notes are shown inside the red warning above (not twice). */}
      {data.reconciles && data.notes.length > 0 && (
        <ul data-testid="payout-status-notes" className="space-y-1">
          {data.notes.map((n, i) => (
            <li key={i} className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">{n}</li>
          ))}
        </ul>
      )}

      {data.overall.total.count > 0 || data.fields.length > 0 ? (
        <>
          <BreakdownTable
            title={data.fields.length === 1 ? `This upload — one field: ${data.fields[0].fieldName}` : 'This upload — all fields'}
            testId="breakdown-overall"
            b={data.overall}
            onPick={(s) => onPick(s)}
          />
          {data.fields.length > 1 &&
            data.fields.map((f) => (
              <BreakdownTable
                key={f.fieldId}
                title={`Field: ${f.fieldName}`}
                testId={`breakdown-field-${f.fieldId}`}
                b={f.breakdown}
                onPick={(s) => onPick(s, f.fieldId)}
              />
            ))}
        </>
      ) : (
        <p className="text-xs text-gray-500" data-testid="payout-status-no-money">This upload has no money payout rows.</p>
      )}

      <div className="text-xs text-gray-700 space-y-1" data-testid="payout-status-reconciliation">
        <p>
          Payout rows total <strong>{inr(data.overall.total.paise)}</strong> ({plural(data.overall.total.count, 'row', 'rows')}) = sum of the statuses above.
        </p>
        <p>
          Fund Reconciliation for these rows: committed <strong>{inr(data.fund.committed.paise)}</strong> / paid{' '}
          <strong>{inr(data.fund.paid.paise)}</strong> / returned (incl. cancelled) <strong>{inr(data.fund.returned.paise)}</strong>
        </p>
        {data.fund.excludedVendorImport.count > 0 && (
          <p className="text-amber-800">
            {plural(data.fund.excludedVendorImport.count, 'row', 'rows')} ({inr(data.fund.excludedVendorImport.paise)}) imported from the
            earlier vendor are not part of the Fund Reconciliation.
          </p>
        )}
      </div>

      {(p.creditedRows > 0 || p.notCreditedRows > 0 || p.deductedRows > 0) && (
        <div className="text-xs text-gray-700 space-y-0.5" data-testid="payout-status-points">
          <p>
            Points credited {p.creditedPoints.toLocaleString('en-IN')} pts to {plural(p.creditedRows, 'outlet', 'outlets')} — points, not money.
          </p>
          {p.notCreditedRows > 0 && (
            <p className="text-amber-800">
              Points NOT credited: {p.notCreditedPoints.toLocaleString('en-IN')} pts ({plural(p.notCreditedRows, 'row', 'rows')}).
            </p>
          )}
          {p.deductedRows > 0 && (
            <p>Points deducted: {p.deductedPoints.toLocaleString('en-IN')} pts ({plural(p.deductedRows, 'row', 'rows')}).</p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Only the FAILED rows not held elsewhere go into the next bank file; the held ones are listed with why (never
 * implied to be re-banked). A part with no rows is omitted.
 */
function FailedNote({ failed, b }: { failed: Money; b: Breakdown }) {
  const rev = b.failedHeldByReversal ?? { count: 0, paise: 0 };
  const kyc = b.failedKycHold ?? { count: 0, paise: 0 };
  const eligible = {
    count: Math.max(0, failed.count - rev.count - kyc.count),
    paise: Math.max(0, failed.paise - rev.paise - kyc.paise),
  };
  return (
    <>
      {eligible.count > 0 && (
        <span className="block text-gray-500" data-testid="failed-rebank">
          {plural(eligible.count, 'row', 'rows')} ({inr(eligible.paise)}) will be re-banked in the next bank file
        </span>
      )}
      {rev.count > 0 && (
        <span className="block text-amber-700" data-testid="failed-held-reversal">
          {plural(rev.count, 'row', 'rows')} ({inr(rev.paise)}) held by a pending reversal request
        </span>
      )}
      {kyc.count > 0 && (
        <span className="block text-amber-700" data-testid="failed-kyc-hold">
          {plural(kyc.count, 'row', 'rows')} ({inr(kyc.paise)}) on KYC / partner hold — not re-banked until KYC is approved
        </span>
      )}
    </>
  );
}

function BreakdownTable({ title, testId, b, onPick }: { title: string; testId: string; b: Breakdown; onPick: (s: BucketKey) => void }) {
  return (
    <div data-testid={testId} className="border border-gray-200 rounded-lg overflow-hidden">
      <p className="px-3 py-1.5 bg-gray-50 text-xs font-semibold text-gray-700">{title}</p>
      <table className="w-full text-xs">
        <thead className="sr-only">
          <tr><th>Status</th><th>Rows</th><th>Amount</th></tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {BUCKET_ORDER.map((k) => {
            const m = b.buckets[k] ?? { count: 0, paise: 0 };
            return (
              <tr key={k} data-testid={`${testId}-${k}`}>
                <td className="px-3 py-1.5 text-gray-700">
                  {m.count > 0 ? (
                    <button
                      type="button"
                      onClick={() => onPick(k)}
                      className="text-left text-[var(--brand-primary)] hover:underline"
                      aria-label={`${BUCKET_LABEL[k]} — show these rows`}
                    >
                      {BUCKET_LABEL[k]}
                    </button>
                  ) : (
                    <span>{BUCKET_LABEL[k]}</span>
                  )}
                  {k === 'PAID' && b.paidTdsWithheldPaise > 0 && (
                    <span className="block text-gray-500">incl. TDS withheld {inr(b.paidTdsWithheldPaise)}</span>
                  )}
                  {k === 'PAID' && b.paidSettledByTds.count > 0 && (
                    <span className="block text-gray-500">
                      {plural(b.paidSettledByTds.count, 'row', 'rows')} ({inr(b.paidSettledByTds.paise)}) settled by TDS (no bank payment)
                    </span>
                  )}
                  {k === 'PENDING' && b.pendingHeldByReversal.count > 0 && (
                    <span className="block text-amber-700">
                      {plural(b.pendingHeldByReversal.count, 'row', 'rows')} ({inr(b.pendingHeldByReversal.paise)}) held by a pending reversal
                    </span>
                  )}
                  {k === 'FAILED' && m.count > 0 && <FailedNote failed={m} b={b} />}
                </td>
                <td className="px-3 py-1.5 text-right text-gray-600 whitespace-nowrap">{plural(m.count, 'row', 'rows')}</td>
                <td className="px-3 py-1.5 text-right text-gray-900 whitespace-nowrap">{inr(m.paise)}</td>
              </tr>
            );
          })}
          {b.other.count > 0 && (
            <tr data-testid={`${testId}-OTHER`} className="bg-amber-50">
              <td className="px-3 py-1.5 text-amber-900">Other status</td>
              <td className="px-3 py-1.5 text-right text-amber-900">{plural(b.other.count, 'row', 'rows')}</td>
              <td className="px-3 py-1.5 text-right text-amber-900">{inr(b.other.paise)}</td>
            </tr>
          )}
          <tr data-testid={`${testId}-TOTAL`} className="bg-gray-50 font-semibold">
            <td className="px-3 py-1.5 text-gray-900">Total</td>
            <td className="px-3 py-1.5 text-right text-gray-900 whitespace-nowrap">{plural(b.total.count, 'row', 'rows')}</td>
            <td className="px-3 py-1.5 text-right text-gray-900 whitespace-nowrap">{inr(b.total.paise)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
