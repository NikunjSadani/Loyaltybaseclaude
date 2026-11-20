'use client';

/**
 * VisibilityReportView — the MONTH-WISE Visibility (POSM) report (VISIBILITY-POSM-DESIGN.md §Metrics).
 * Shared by the GIFSY admin report tab (`variant="admin"`, with the Excel export) and the tenant read-only
 * report page (`variant="tenant"`).
 *
 *   - Pick any month (default = the current IST month; imported old-app records count in their own month) and,
 *     for a tenant capturing more than once a month, one window of it (default = every window).
 *   - Tiles: In scope · Approved · Waiting for review · Needs re-take · Rejected · Not approved — window closed ·
 *     Not captured yet · Missed · Coverage. "Missed" only ever counts windows that have closed with no capture;
 *     a re-take / rejection left when the window closed is "Not approved — window closed" (can't be resubmitted).
 *   - Imported months (before the portal went live — the API decides): only the visits the old app recorded;
 *     coverage / Not captured / Missed show "Not tracked" with the one-line reason.
 *   - Definitions are toggletips (keyboard + touch), the breakdown tabs are real tabs (arrow keys), and the
 *     coverage bar has a text alternative + visible legend.
 *   - Breakdowns by Programme / Sub-programme, Rep and Manager (first active manager above the rep).
 *   - Tap a tile or a breakdown row → the outlets behind it (paged) with status, rep, captured on, reviewed by/on.
 *   - Captures the report does NOT count (outlet no longer in scope / a window the current frequency does not
 *     have) are called out above the tiles — never dropped silently.
 *   - Excel export on BOTH variants: one window, or the whole selected month (background → Downloads page);
 *     the server pins a client admin to their own tenant.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Download, Info, Loader2, X } from 'lucide-react';
import { Toggletip } from '@/components/ui/toggletip';
import { visibilityApi } from '@/lib/visibility';
import {
  BreakdownRow,
  MonthReport,
  PLAIN_STATUS_HINT,
  PLAIN_STATUS_LABEL,
  PlainStatus,
  ReportGroup,
  ReportOutletsPage,
  currentIstMonth,
  monthLabel,
  monthOptions,
  visibilityReportApi,
  windowShortLabel,
} from '@/lib/visibility-report';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

type Variant = 'admin' | 'tenant';

/** What the outlet list is showing: a tile (status / all) and/or a breakdown row. */
interface ListFilter {
  status?: PlainStatus;
  group?: ReportGroup;
  groupKey?: string;
  title: string;
}

const PAGE_SIZE = 50;

const GROUP_LABEL: Record<ReportGroup, string> = {
  programme: 'Programme / Sub-programme',
  rep: 'Rep',
  manager: 'Manager',
};

const STATUS_TONE: Record<PlainStatus, string> = {
  APPROVED: 'text-green-700',
  WAITING: 'text-amber-600',
  NEEDS_RETAKE: 'text-orange-600',
  REJECTED: 'text-red-600',
  CLOSED_NOT_APPROVED: 'text-red-800',
  NOT_CAPTURED: 'text-gray-600',
  MISSED: 'text-red-700',
  NOT_TRACKED: 'text-gray-500',
};

const BADGE_TONE: Record<PlainStatus, string> = {
  APPROVED: 'bg-green-50 text-green-700 border-green-200',
  WAITING: 'bg-amber-50 text-amber-700 border-amber-200',
  NEEDS_RETAKE: 'bg-orange-50 text-orange-700 border-orange-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  CLOSED_NOT_APPROVED: 'bg-red-50 text-red-800 border-red-300',
  NOT_CAPTURED: 'bg-gray-50 text-gray-600 border-gray-200',
  MISSED: 'bg-red-50 text-red-800 border-red-300',
  NOT_TRACKED: 'bg-gray-50 text-gray-500 border-gray-200',
};

type CountField = 'approved' | 'waiting' | 'needsRetake' | 'rejected' | 'closedNotApproved' | 'notCaptured' | 'missed';

/** Tiles in order. `trackedOnly` = hidden for an imported month (no denominator → never "Missed"). */
const TILE_ORDER: Array<{ status: PlainStatus; field: CountField; trackedOnly?: boolean }> = [
  { status: 'APPROVED', field: 'approved' },
  { status: 'WAITING', field: 'waiting' },
  { status: 'NEEDS_RETAKE', field: 'needsRetake' },
  { status: 'REJECTED', field: 'rejected' },
  { status: 'CLOSED_NOT_APPROVED', field: 'closedNotApproved' },
  { status: 'NOT_CAPTURED', field: 'notCaptured', trackedOnly: true },
  { status: 'MISSED', field: 'missed', trackedOnly: true },
];

const NOT_TRACKED_TEXT = 'Not tracked for imported months';
const fmtCoverage = (pct: number | null) => (pct === null ? 'Not tracked' : `${pct}%`);

const fmtInt = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-IN');

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

export function VisibilityReportView({ variant }: { variant: Variant }) {
  const [month, setMonth] = useState<string>(() => currentIstMonth());
  const [windowKey, setWindowKey] = useState<string>(''); // '' = every window of the month
  const [report, setReport] = useState<MonthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<ReportGroup>('programme');
  const [list, setList] = useState<ListFilter | null>(null);
  const exportAction = useDownloadAction();
  const monthAction = useDownloadAction();
  const reqId = useRef(0);

  const months = useMemo(() => monthOptions(), []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const res = await visibilityReportApi.getReport(variant, { month, windowKey: windowKey || undefined });
    if (id !== reqId.current) return; // a newer selection superseded this response
    if (res.success) setReport(res.data);
    else {
      setReport(null);
      setError(res.error);
    }
    setLoading(false);
  }, [variant, month, windowKey]);

  useEffect(() => { void load(); }, [load]);

  // The single window to export: the picked one, or the month's only window. A month with several windows and
  // "All windows" picked has no single window → the button asks for one (the export works per window).
  const exportWindow = windowKey || (report && report.windows.length === 1 ? report.windows[0].key : '');

  const handleExport = () => {
    if (!exportWindow) return;
    void exportAction.run(async () => {
      const res = await visibilityApi.downloadExport(exportWindow);
      if (!res.success) return { kind: 'error', message: res.error };
      if (res.queued) return { kind: 'queued', ...res.queued };
      return { kind: 'downloaded', fileName: '' };
    });
  };

  // The whole selected month's Visibility report (always prepared in the background → Downloads page).
  const handleMonthExport = () => {
    void monthAction.run(async () => {
      const res = await visibilityApi.downloadExport(undefined, month);
      if (!res.success) return { kind: 'error', message: res.error };
      if (res.queued) return { kind: 'queued', ...res.queued };
      return { kind: 'downloaded', fileName: '' };
    });
  };

  const changeMonth = (m: string) => {
    setMonth(m);
    setWindowKey('');
    setList(null);
  };

  const s = report?.summary;
  const multiWindow = (report?.windows.length ?? 0) > 1;
  const showWindowCol = multiWindow && !windowKey;
  const notCountedTotal = report ? report.notCounted.outOfScope + report.notCounted.otherWindow : 0;
  const imported = report?.importedMonth === true;
  const tiles = TILE_ORDER.filter((t) => !(imported && t.trackedOnly));
  const groups = Object.keys(GROUP_LABEL) as ReportGroup[];
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // WAI-ARIA tabs: Left/Right (and Home/End) move between the breakdown tabs and select them.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % groups.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + groups.length) % groups.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = groups.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setGroup(groups[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="space-y-5">
      {/* Header: month + window pickers, export */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Month</span>
            <select
              value={month}
              onChange={(e) => changeMonth(e.target.value)}
              aria-label="Report month"
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            >
              {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          {multiWindow && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">Window</span>
              <select
                value={windowKey}
                onChange={(e) => { setWindowKey(e.target.value); setList(null); }}
                aria-label="Report window"
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              >
                <option value="">All windows</option>
                {report!.windows.map((w) => (
                  <option key={w.key} value={w.key}>{windowShortLabel(w.key)}{w.closed ? ' (closed)' : ' (open)'}</option>
                ))}
              </select>
            </label>
          )}
          {report && !multiWindow && (
            <span className="text-[11px] px-2 py-0.5 mb-1.5 rounded-full bg-gray-100 text-gray-600">
              {report.windowClosed ? 'Window closed' : 'Window open'}
            </span>
          )}
        </div>
        {/* Excel export on BOTH variants (owner 2026-11-20: client admins download their own tenant's file;
            GET report/export allows GIFSY_ADMIN + CLIENT_ADMIN and pins a client admin to their own clientId). */}
        {(
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={handleExport}
              disabled={exportAction.blocked || !exportWindow}
              title={exportWindow ? undefined : 'Pick one window to export'}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60"
            >
              {exportAction.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {downloadButtonLabel(exportAction, 'Export Excel')}
            </button>
            {!exportWindow && report && <p className="text-[11px] text-gray-500">Pick one window to export.</p>}
            <DownloadActionStatus action={exportAction} className="mt-1 max-w-sm" />
            <button
              onClick={handleMonthExport}
              disabled={monthAction.blocked || month > currentIstMonth()}
              className="mt-2 flex items-center gap-2 px-3 py-1.5 border border-[var(--brand-primary)] text-[var(--brand-primary)] text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
            >
              {monthAction.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {downloadButtonLabel(monthAction, `Export ${monthLabel(month)}`)}
            </button>
            <DownloadActionStatus action={monthAction} className="mt-1 max-w-sm" />
          </div>
        )}
      </div>

      {loading && !report ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" /></div>
      ) : error || !report || !s ? (
        <div className="py-16 text-center" role="alert">
          <p className="text-sm text-red-600">Couldn&apos;t load the report — {error ?? 'no data was returned.'}</p>
          <button onClick={() => void load()} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button>
        </div>
      ) : (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
          {notCountedTotal > 0 && (
            <div role="status" data-testid="report-not-counted" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {fmtInt(notCountedTotal)} capture{notCountedTotal === 1 ? '' : 's'} in {monthLabel(report.month)} {notCountedTotal === 1 ? 'is' : 'are'} not counted below
                {report.notCounted.outOfScope > 0 && ` — ${fmtInt(report.notCounted.outOfScope)} for outlets no longer in scope (deactivated, not KYC-approved, or outside the visibility scope)`}
                {report.notCounted.otherWindow > 0 && ` — ${fmtInt(report.notCounted.otherWindow)} in a window this month no longer has (the capture frequency changed)`}.
                {/* The month export reads every window key P1..P4 of the month and every capture (in scope or not),
                    so every capture not counted here IS in that file (visibility-captures export kind). */}
                {` They are all still in the month's Excel export (Export ${monthLabel(report.month)}).`}
              </span>
            </div>
          )}

          {imported && (
            <div role="note" data-testid="report-imported-month" className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <strong>{monthLabel(report.month)} is an imported month.</strong>{' '}
                {report.importedMonthNote ?? `${NOT_TRACKED_TEXT} — the old app only kept approved visits.`}{' '}
                The numbers below are the visits the old app recorded.
              </span>
            </div>
          )}

          {/* Tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Tile
              label={imported ? 'Visits recorded (old app)' : 'In scope'}
              value={fmtInt(s.inScope)}
              sub={
                imported
                  ? 'approved visits the old app kept'
                  : multiWindow && !windowKey ? `${fmtInt(report.outletsInScope)} outlets × ${report.windows.length} windows` : 'outlets'
              }
              hint={
                imported
                  ? 'The visits the old app recorded for this month (it kept only approved visits).'
                  : 'KYC-approved, active outlets in the visibility scope — every visit due this period.'
              }
              onClick={() => setList({ title: imported ? 'Visits recorded (old app)' : 'All outlets in scope' })}
            />
            {tiles.map((t) => (
              <Tile
                key={t.status}
                label={PLAIN_STATUS_LABEL[t.status]}
                value={fmtInt(s[t.field])}
                tone={STATUS_TONE[t.status]}
                hint={PLAIN_STATUS_HINT[t.status]}
                onClick={() => setList({ status: t.status, title: PLAIN_STATUS_LABEL[t.status] })}
              />
            ))}
            {imported && (
              <Tile
                label="Not captured / Missed"
                value="Not tracked"
                tone="text-gray-500"
                hint={report.importedMonthNote ?? NOT_TRACKED_TEXT}
              />
            )}
            <Tile
              label="Coverage"
              value={fmtCoverage(s.coveragePct)}
              tone={s.coveragePct === null ? 'text-gray-500' : 'text-blue-600'}
              hint={s.coveragePct === null ? report.importedMonthNote ?? NOT_TRACKED_TEXT : 'Approved ÷ in scope.'}
            />
          </div>

          {/* Coverage bar (hidden for an imported month — there is no "in scope" denominator to fill) */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-[var(--brand-primary)]" aria-hidden="true" />
              <p className="text-xs font-semibold text-gray-700">
                Coverage — {monthLabel(report.month)}{windowKey ? ` · ${windowShortLabel(windowKey)}` : ''}
              </p>
            </div>
            {imported ? (
              <p className="text-xs text-gray-600" data-testid="report-coverage-not-tracked">{report.importedMonthNote ?? NOT_TRACKED_TEXT}</p>
            ) : (
              <>
                <div
                  className="h-3 bg-gray-100 rounded-full overflow-hidden flex"
                  role="img"
                  aria-label={coverageBarText(s)}
                  data-testid="report-coverage-bar"
                >
                  <div className="h-full bg-green-500" style={{ width: `${pct(s.approved, s.inScope)}%` }} />
                  <div className="h-full bg-amber-400" style={{ width: `${pct(s.waiting, s.inScope)}%` }} />
                  <div className="h-full bg-orange-400" style={{ width: `${pct(s.needsRetake, s.inScope)}%` }} />
                  <div className="h-full bg-red-400" style={{ width: `${pct(s.rejected, s.inScope)}%` }} />
                  <div className="h-full bg-red-800" style={{ width: `${pct(s.closedNotApproved, s.inScope)}%` }} />
                  <div className="h-full bg-red-700" style={{ width: `${pct(s.missed, s.inScope)}%` }} />
                </div>
                {/* The same figures in words (visible legend = the bar's text alternative). */}
                <p className="text-[11px] text-gray-600 mt-2" aria-hidden="true">{coverageBarText(s)}</p>
              </>
            )}
            <p className="text-[11px] text-gray-500 mt-2">
              Scope: {report.outletScope.length ? report.outletScope.join(', ') : '—'}
              {report.programs?.length ? ` · Programs: ${report.programs.join(', ')}` : ''}
              {report.subPrograms?.length ? ` · Sub-Programs: ${report.subPrograms.join(', ')}` : ''}
              {' · '}{report.frequencyPerMonth}× per month
            </p>
          </div>

          {/* Breakdowns */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center gap-1 border-b border-gray-100 px-3 pt-3 overflow-x-auto" role="tablist" aria-label="Breakdown">
              {groups.map((g, i) => (
                <button
                  key={g}
                  ref={(el) => { tabRefs.current[i] = el; }}
                  type="button"
                  role="tab"
                  id={`vis-breakdown-tab-${g}`}
                  aria-selected={group === g}
                  aria-controls="vis-breakdown-panel"
                  tabIndex={group === g ? 0 : -1}
                  onClick={() => setGroup(g)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={`px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] ${group === g ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >
                  By {GROUP_LABEL[g]}
                </button>
              ))}
            </div>
            <div role="tabpanel" id="vis-breakdown-panel" aria-labelledby={`vis-breakdown-tab-${group}`} tabIndex={0} className="focus:outline-none">
              <BreakdownTable
                rows={report.breakdowns[group]}
                firstCol={GROUP_LABEL[group]}
                imported={imported}
                onPick={(r) => setList({ group, groupKey: r.key, title: r.label })}
              />
            </div>
          </div>

          {list && (
            <OutletList
              // A new tile / row / period remounts the list → it starts again at page 1.
              key={`${report.month}|${windowKey}|${list.status ?? ''}|${list.group ?? ''}|${list.groupKey ?? ''}`}
              variant={variant}
              month={report.month}
              windowKey={windowKey}
              filter={list}
              showWindow={showWindowCol}
              onClose={() => setList(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function pct(n: number | undefined, d: number): number {
  if (!d || d <= 0 || !n) return 0;
  return Math.min(100, Math.round((n / d) * 100));
}

/** The coverage bar in words — its text alternative and visible legend. */
function coverageBarText(s: MonthReport['summary']): string {
  const parts: Array<[string, number]> = [
    [PLAIN_STATUS_LABEL.APPROVED, s.approved],
    [PLAIN_STATUS_LABEL.WAITING, s.waiting],
    [PLAIN_STATUS_LABEL.NEEDS_RETAKE, s.needsRetake],
    [PLAIN_STATUS_LABEL.REJECTED, s.rejected],
    [PLAIN_STATUS_LABEL.CLOSED_NOT_APPROVED, s.closedNotApproved],
    [PLAIN_STATUS_LABEL.NOT_CAPTURED, s.notCaptured],
    [PLAIN_STATUS_LABEL.MISSED, s.missed],
  ];
  return `Coverage ${fmtCoverage(s.coveragePct)} of ${fmtInt(s.inScope)} visits due: ${parts.map(([l, n]) => `${l} ${fmtInt(n)}`).join(', ')}.`;
}

/**
 * A stat tile. The definition (`hint`) is a keyboard / touch reachable toggletip beside the number — never only a
 * mouse-hover `title`. A tile with `onClick` opens the outlets behind it; the toggletip is a SIBLING button (never
 * nested inside the tile button).
 */
function Tile({ label, value, sub, tone, hint, onClick }: {
  label: string; value: string; sub?: string; tone?: string; hint?: string; onClick?: () => void;
}) {
  const body = (
    <>
      <p className={`text-2xl font-bold ${tone ?? 'text-gray-900'}`}>{value}</p>
      <p className="text-xs text-gray-600 mt-0.5 pr-5">{label}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </>
  );
  const tip = hint ? <Toggletip label={label} text={hint} className="absolute top-2 right-2" /> : null;
  if (!onClick) {
    return <div className="relative bg-white rounded-xl border border-gray-200 p-3">{body}{tip}</div>;
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}: ${value}. Show outlets`}
        className="w-full h-full text-left bg-white rounded-xl border border-gray-200 p-3 hover:border-[var(--brand-primary)] hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] transition"
      >
        {body}
      </button>
      {tip}
    </div>
  );
}

function BreakdownTable({ rows, firstCol, imported, onPick }: {
  rows: BreakdownRow[]; firstCol: string; imported: boolean; onPick: (r: BreakdownRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-xs text-gray-500">
        {imported ? 'The old app recorded no visits for this period.' : 'No outlets in scope for this period.'}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="px-3 py-2 font-medium">{firstCol}</th>
            <th className="px-3 py-2 font-medium text-right">{imported ? 'Visits recorded' : 'In scope'}</th>
            <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.APPROVED}</th>
            <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.WAITING}</th>
            <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.NEEDS_RETAKE}</th>
            <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.REJECTED}</th>
            <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.CLOSED_NOT_APPROVED}</th>
            {!imported && <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.NOT_CAPTURED}</th>}
            {!imported && <th className="px-3 py-2 font-medium text-right">{PLAIN_STATUS_LABEL.MISSED}</th>}
            <th className="px-3 py-2 font-medium text-right">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2">
                <button type="button" onClick={() => onPick(r)} className="text-left text-[var(--brand-primary)] hover:underline">
                  {r.label}
                </button>
              </td>
              <td className="px-3 py-2 text-right">{fmtInt(r.inScope)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.approved)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.waiting)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.needsRetake)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.rejected)}</td>
              <td className="px-3 py-2 text-right">{fmtInt(r.closedNotApproved ?? 0)}</td>
              {!imported && <td className="px-3 py-2 text-right">{fmtInt(r.notCaptured)}</td>}
              {!imported && <td className="px-3 py-2 text-right">{fmtInt(r.missed)}</td>}
              <td className="px-3 py-2 text-right font-medium">{fmtCoverage(r.coveragePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutletList({ variant, month, windowKey, filter, showWindow, onClose }: {
  variant: Variant; month: string; windowKey: string; filter: ListFilter; showWindow: boolean; onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ReportOutletsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    void visibilityReportApi
      .getOutlets(variant, {
        month,
        windowKey: windowKey || undefined,
        status: filter.status,
        group: filter.group,
        groupKey: filter.groupKey,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((res) => {
        if (id !== reqId.current) return;
        if (res.success) setData(res.data);
        else { setData(null); setError(res.error); }
        setLoading(false);
      });
  }, [variant, month, windowKey, filter, page]);

  const pg = data?.pagination;

  return (
    <section className="bg-white border border-gray-200 rounded-xl" aria-label="Outlet list" data-testid="report-outlet-list">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-800 truncate">{filter.title}</h3>
          <p className="text-[11px] text-gray-500">
            {monthLabel(month)}{windowKey ? ` · ${windowShortLabel(windowKey)}` : ''}
            {pg ? ` · ${fmtInt(pg.total)} outlet${showWindow ? '-window' : ''}${pg.total === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close outlet list" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100">
          <X className="w-4 h-4" />
        </button>
      </div>
      {error ? (
        <p className="px-4 py-6 text-xs text-red-600" role="alert">Couldn&apos;t load the outlets — {error}</p>
      ) : !data && loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 text-gray-300 animate-spin" aria-label="Loading outlets" /></div>
      ) : data && data.rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-gray-500">No outlets.</p>
      ) : data ? (
        <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="px-3 py-2 font-medium">Outlet</th>
                <th className="px-3 py-2 font-medium">Programme</th>
                {showWindow && <th className="px-3 py-2 font-medium">Window</th>}
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Rep</th>
                <th className="px-3 py-2 font-medium">Captured</th>
                <th className="px-3 py-2 font-medium">Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.outletId}|${r.windowKey}`} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2">
                    <p className="font-medium text-gray-800">{r.outletName}</p>
                    <p className="text-gray-500">{r.outletCode}</p>
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.programme ?? '—'}{r.subProgramme ? ` / ${r.subProgramme}` : ''}
                  </td>
                  {showWindow && <td className="px-3 py-2 text-gray-700">{windowShortLabel(r.windowKey)}</td>}
                  <td className="px-3 py-2">
                    <span className={`inline-block whitespace-nowrap px-2 py-0.5 rounded-full border text-[11px] ${BADGE_TONE[r.status]}`}>
                      {PLAIN_STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.rep ?? 'No rep assigned'}
                    {r.manager && <p className="text-gray-500">Manager: {r.manager}</p>}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.capturedBy ? (
                      <>
                        <p>{fmtDate(r.capturedOn)}</p>
                        <p className="text-gray-500">{r.capturedBy}</p>
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.reviewedBy || r.reviewedOn ? (
                      <>
                        <p>{fmtDate(r.reviewedOn)}</p>
                        <p className="text-gray-500">{r.reviewedBy ?? '—'}</p>
                      </>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {pg && pg.pages > 1 && (
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-gray-100 text-xs text-gray-600">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
          <span>Page {pg.page} of {pg.pages}</span>
          <button type="button" disabled={page >= pg.pages || loading} onClick={() => setPage((p) => p + 1)} aria-label="Next page"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
        </div>
      )}
    </section>
  );
}

export default VisibilityReportView;
