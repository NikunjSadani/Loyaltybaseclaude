'use client';

/**
 * SchemeReportView — shared read-only report renderer for a scheme's coverage
 * aggregates (D26). Used by BOTH the GIFSY report page and the tenant read-only
 * report page. Renders coverage tiles + by-zone / by-program / by-outlet-type
 * breakdowns, and (tenant view) an optional per-outlet row list. NO raw media.
 */

import type { SchemeReport, TenantSchemeReport, ReportBucket } from '@/lib/schemes';

const ROW_STATUS_STYLES: Record<string, string> = {
  SUBMITTED:    'bg-green-100 text-green-700',
  REJECTED:     'bg-red-100 text-red-600',
  NOT_ENROLLED: 'bg-gray-100 text-gray-500',
};

export function SchemeReportView({ report }: { report: SchemeReport | TenantSchemeReport }) {
  const rows = 'rows' in report ? report.rows : null;
  return (
    <div className="space-y-5">
      {/* Coverage tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Coverage" value={`${report.summary.coveragePct}%`} tone="blue" />
        <Tile label="Enrolled" value={`${report.summary.enrolledCount} / ${report.coverageDenominator}`} tone="green" />
        <Tile label="Submitted" value={report.summary.submittedCount} tone="green" />
        <Tile label="Rejected" value={report.summary.rejectedCount} tone="red" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Breakdown title="By zone" buckets={report.byZone} />
        <Breakdown title="By program" buckets={report.byProgram} />
        <Breakdown title="By outlet type" buckets={report.byOutletType} />
      </div>

      {rows && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100"><p className="text-sm font-semibold text-gray-800">Outlets ({rows.length})</p></div>
          <div className="overflow-x-auto max-h-[32rem]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                <tr>{['Outlet', 'Zone', 'Program', 'Type', 'Status'].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.outletRef} className="hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <p className="text-gray-900">{r.outletName || <span className="text-gray-400 italic">Unnamed</span>}</p>
                      <p className="text-[11px] text-gray-400 font-mono">{r.outletRef}{r.matched ? '' : ' · standalone'}</p>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">{r.zone ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">{r.program ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">{r.outletType ?? '—'}</td>
                    <td className="px-4 py-2"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROW_STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-500'}`}>{r.status.replace('_', ' ')}</span></td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-gray-400">No outlets in the audience yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: 'green' | 'red' | 'blue' }) {
  const cls = tone === 'green' ? 'text-green-600' : tone === 'red' ? 'text-red-500' : tone === 'blue' ? 'text-blue-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className={`text-2xl font-bold ${cls}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

function Breakdown({ title, buckets }: { title: string; buckets: ReportBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.rosterCount));
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs font-semibold text-gray-700 mb-3">{title}</p>
      {buckets.length === 0 ? (
        <p className="text-xs text-gray-400">No data.</p>
      ) : (
        <ul className="space-y-2.5">
          {buckets.map((b) => {
            const pct = b.rosterCount === 0 ? 0 : Math.round((b.enrolledCount / b.rosterCount) * 100);
            return (
              <li key={b.key}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-gray-700 truncate">{b.key || '—'}</span>
                  <span className="text-gray-400">{b.enrolledCount}/{b.rosterCount} · {pct}%</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-[var(--brand-primary)] rounded-full" style={{ width: `${Math.round((b.rosterCount / max) * 100)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default SchemeReportView;
