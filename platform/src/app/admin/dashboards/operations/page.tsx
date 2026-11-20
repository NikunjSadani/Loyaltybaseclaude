'use client';

/* ─── Admin Operations Dashboard (REAL data) ─────────────────────────────────────
   100% wired to GET /api/admin/dashboard/operations (proxy → backend
   /v1/admin/dashboard/operations). Every number comes from that endpoint — there are
   NO hardcoded metric constants or fabricated arrays. On fetch failure or an empty
   payload an explicit error state is shown (never a mock fallback). Metrics the backend
   cannot source (e.g. first-response when the ticket flow never writes firstResponseAt)
   arrive as null and render as "—". The visibility card renders ONLY when the payload's
   `visibility` block is non-null (tenant has the feature enabled). PHOTO_APPROVAL tenants get a MONTH-WISE funnel
   (`mode: 'PHOTO_APPROVAL'`, month picker → GET /api/admin/dashboard/operations/visibility?month=) with real
   duplicate / outside-fence flags (list → .../operations/visibility/flags); AMOUNT_UPLOAD tenants keep the old card.
   Mirrors the fetch/loading/error/styling pattern of /admin/dashboards/kyc/page.tsx.
──────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote, CheckCircle, XCircle, Clock, AlertCircle,
  Ticket as TicketIcon, Timer, ShieldCheck, Loader2, Eye, X,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';
import { Toggletip } from '@/components/ui/toggletip';
import { PLAIN_STATUS_LABEL, PlainStatus, monthLabel, monthOptions, windowShortLabel } from '@/lib/visibility-report';

const DARK_NAVY = '#1A1A2E';

/* ─── API response model (precise to the endpoint contract) ─────────────────── */

interface LatencyByMode { mode: string; avgHours: number; sampleSize: number }

interface CountRow { count: number }
interface StatusRow extends CountRow { status: string }
interface PriorityRow extends CountRow { priority: string }
interface CategoryRow extends CountRow { category: string }
interface AgeBucket extends CountRow { bucket: string }

interface PayoutsBlock {
  total: number;
  success: number;
  failed: number;
  pending: number;
  successRatePct: number;
  failureRatePct: number;
  pendingValueRupees: number;
  latencyByMode: LatencyByMode[];
}

interface TicketsBlock {
  open: number;
  byStatus: StatusRow[];
  byPriority: PriorityRow[];
  byCategory: CategoryRow[];
  mttrHours: number | null;
  firstResponseHours: number | null;
  slaCompliancePct: number;
  sampleSize: number;
  ageBuckets: AgeBucket[];
}

/** AMOUNT_UPLOAD tenants — the unchanged all-time funnel. */
interface LegacyVisibilityBlock {
  enabled: boolean;
  mode?: undefined;
  submitted: number;
  approved: number;
  rejected: number;
  flagged: number;
  approvalRatePct: number;
  fraudFlagPct: number;
  participationPct: number;
}

/** PHOTO_APPROVAL tenants — one month, in-scope outlets (VISIBILITY-POSM-DESIGN.md §17). */
interface PhotoVisibilityBlock {
  enabled: true;
  mode: 'PHOTO_APPROVAL';
  month: string;
  submitted: number;
  approved: number;
  waiting: number;
  /** Gifsy's whole review queue (any month) and the part of it from months before `month`. */
  waitingAllMonths?: number;
  waitingEarlierMonths?: number;
  /** Open window only (the rep can still redo it). */
  needsRetake: number;
  rejected: number;
  /** Re-take / rejection left when the window closed — final. */
  closedNotApproved?: number;
  /** approved ÷ every decided capture; null when nothing has been decided yet. */
  approvalRatePct: number | null;
  flagged: number;
  duplicate: number;
  outsideFence: number;
  /** flagged ÷ submitted; null when nothing was submitted. */
  fraudFlagPct: number | null;
  /** true = this caller may open the flagged-capture list (Gifsy roles only for now). */
  flagDetailsAvailable?: boolean;
  /** A month before the portal went live — participation is not tracked. */
  importedMonth?: boolean;
  importedMonthNote?: string;
  participatingOutlets: number;
  inScopeOutlets: number;
  /** null for an imported month (not tracked). */
  participationPct: number | null;
}

type VisibilityBlock = LegacyVisibilityBlock | PhotoVisibilityBlock;

interface FlagRow {
  captureId: string;
  outletCode: string;
  outletName: string;
  windowKey: string;
  status: PlainStatus;
  reasons: Array<'DUPLICATE_PHOTO' | 'OUTSIDE_FENCE'>;
  /** At most 10 listed; duplicateCount is the full figure. */
  duplicateOf: Array<{ outletCode: string; windowKey: string }>;
  duplicateCount?: number;
  outsidePhotos: string[];
}

interface FlagsPage {
  month: string;
  flagged: number;
  rows: FlagRow[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

interface SettlementBlock {
  avgLatencyHours: number;
  sampleSize: number;
}

interface OperationsData {
  scope: { tenant: string; generatedAt: string };
  payouts: PayoutsBlock;
  tickets: TicketsBlock;
  visibility: VisibilityBlock | null;
  settlement: SettlementBlock;
}

/* ─── Formatting helpers ─────────────────────────────────────────────────────── */

const fmtInt = (n: number) => n.toLocaleString('en-IN');
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtHours = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}h`);
const fmtRupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ─── Small presentational pieces (chrome only, fully prop-driven) ──────────── */

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  /** A plain-words definition, shown by a keyboard / touch reachable toggletip beside the label. */
  hint?: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  valColor: string;
}

function StatCard({ label, value, sub, hint, icon: Icon, iconBg, iconColor, valColor }: StatCardProps) {
  return (
    <Card className="border border-gray-100 shadow-sm rounded-2xl">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm text-gray-500 flex items-center gap-1">
              {label}
              {hint && <Toggletip label={label} text={hint} />}
            </p>
            <p className={`text-3xl font-bold mt-1 ${valColor}`}>{value}</p>
            {sub && <p className="text-[11px] text-gray-400 mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-xl ${iconBg} shrink-0`}>
            <Icon className={`w-6 h-6 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Horizontal labelled bar list (used for latency-by-mode, status/priority/category, age). */
function BarList({
  rows, color,
}: {
  rows: { label: string; value: number; caption?: string }[];
  color: string;
}) {
  const max = rows.length ? Math.max(...rows.map((r) => r.value), 1) : 1;
  if (rows.length === 0) {
    return <p className="text-xs text-gray-400">No data.</p>;
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const w = (r.value / max) * 100;
        return (
          <div key={r.label} className="flex items-center gap-3">
            <span className="text-xs font-medium text-gray-600 w-32 shrink-0 truncate" title={r.label}>
              {r.label}
            </span>
            <div className="flex-1 h-5 bg-gray-100 rounded-lg overflow-hidden flex items-center">
              <div
                className="h-full rounded-lg flex items-center justify-end pr-2 min-w-[2rem]"
                style={{ width: `${w}%`, backgroundColor: color }}
              >
                <span className="text-[10px] font-bold text-white whitespace-nowrap">
                  {fmtInt(r.value)}
                </span>
              </div>
            </div>
            {r.caption && (
              <span className="text-[10px] text-gray-400 w-16 shrink-0 text-right">{r.caption}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminOperationsDashboardPage() {
  const [data, setData] = useState<OperationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/admin/dashboard/operations', { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        // The endpoint may return the bare shape or wrap it as { success, data }.
        const payload = (json && typeof json === 'object' && 'data' in json)
          ? (json as { data: OperationsData }).data
          : (json as OperationsData);
        if (!payload || typeof payload !== 'object' || !('payouts' in payload)) {
          throw new Error('Empty or malformed response');
        }
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load operations dashboard');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const latencyRows = useMemo(
    () => (data ? data.payouts.latencyByMode.map((m) => ({
      label: m.mode,
      value: Math.round(m.avgHours),
      caption: `n=${m.sampleSize}`,
    })) : []),
    [data],
  );

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-gray-400" data-testid="operations-dashboard-loading">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Loading operations dashboard…</p>
      </div>
    );
  }

  /* ── Error / empty state — NEVER fabricated numbers ── */
  if (error || !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            Operations Dashboard
          </h1>
        </div>
        <Card className="border border-red-100 shadow-sm rounded-2xl" data-testid="operations-dashboard-error">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <AlertCircle className="w-8 h-8 text-red-500" />
            <p className="text-sm font-semibold text-red-600">Couldn&apos;t load the operations dashboard</p>
            <p className="text-xs text-gray-500 max-w-md">
              {error ?? 'No data was returned by the server.'} Please refresh or try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { scope, payouts, tickets, visibility, settlement } = data;
  const photoVisibility = visibility && visibility.mode === 'PHOTO_APPROVAL' ? visibility : null;
  const legacyVisibility = visibility && visibility.mode !== 'PHOTO_APPROVAL' ? visibility : null;

  return (
    <div className="space-y-6" data-testid="operations-dashboard">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            Operations Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {scope.tenant} · Payout fulfilment, support SLA &amp; settlement health
          </p>
        </div>
        <p className="text-xs text-gray-400">as of {fmtTimestamp(scope.generatedAt)}</p>
      </div>

      {/* ── Payout headline cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Payout Success Rate"
          value={fmtPct(payouts.successRatePct)}
          sub={`${fmtInt(payouts.success)} / ${fmtInt(payouts.total)} transactions`}
          icon={CheckCircle} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700"
        />
        <StatCard
          label="Failure Rate"
          value={fmtPct(payouts.failureRatePct)}
          sub={`${fmtInt(payouts.failed)} failed / reversed`}
          icon={XCircle} iconBg="bg-red-100" iconColor="text-red-600" valColor="text-red-700"
        />
        <StatCard
          label="Pending Payouts"
          value={fmtInt(payouts.pending)}
          sub={`${fmtRupees(payouts.pendingValueRupees)} awaiting disbursal`}
          icon={Clock} iconBg="bg-amber-100" iconColor="text-amber-600" valColor="text-amber-700"
        />
        <StatCard
          label="Settlement Latency"
          value={fmtHours(settlement.sampleSize > 0 ? settlement.avgLatencyHours : null)}
          sub={`redeem → payout · n=${fmtInt(settlement.sampleSize)}`}
          icon={Banknote} iconBg="bg-blue-100" iconColor="text-blue-600" valColor="text-blue-700"
        />
      </div>

      {/* ── Payout latency by mode ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <CardTitle>Payout Latency by Mode</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">
            Average hours from creation to completion, per disbursal mode (terminal txns)
          </p>
        </CardHeader>
        <CardContent className="pb-5">
          <BarList rows={latencyRows} color="var(--brand-primary)" />
        </CardContent>
      </Card>

      {/* ── Ticket SLA ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Open Tickets"
          value={fmtInt(tickets.open)}
          sub="open / in-progress / pending / escalated"
          icon={TicketIcon} iconBg="bg-indigo-100" iconColor="text-indigo-600" valColor="text-indigo-700"
        />
        <StatCard
          label="Mean Time to Resolve"
          value={fmtHours(tickets.mttrHours)}
          sub="avg over resolved tickets"
          icon={Timer} iconBg="bg-purple-100" iconColor="text-purple-600" valColor="text-purple-700"
        />
        <StatCard
          label="First Response"
          value={fmtHours(tickets.firstResponseHours)}
          sub="avg time to first reply"
          icon={Clock} iconBg="bg-cyan-100" iconColor="text-cyan-600" valColor="text-cyan-700"
        />
        <StatCard
          label="SLA Compliance"
          value={fmtPct(tickets.slaCompliancePct)}
          sub={`across ${fmtInt(tickets.sampleSize)} resolved / closed`}
          icon={ShieldCheck} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader><CardTitle>Tickets by Status</CardTitle></CardHeader>
          <CardContent className="pb-5">
            <BarList
              rows={tickets.byStatus.map((s) => ({ label: s.status, value: s.count }))}
              color="#6366f1"
            />
          </CardContent>
        </Card>
        <Card className="border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader><CardTitle>Tickets by Priority</CardTitle></CardHeader>
          <CardContent className="pb-5">
            <BarList
              rows={tickets.byPriority.map((s) => ({ label: s.priority, value: s.count }))}
              color="#f59e0b"
            />
          </CardContent>
        </Card>
        <Card className="border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader><CardTitle>Tickets by Category</CardTitle></CardHeader>
          <CardContent className="pb-5">
            <BarList
              rows={tickets.byCategory.map((s) => ({ label: s.category, value: s.count }))}
              color="#0891b2"
            />
          </CardContent>
        </Card>
      </div>

      {/* ── Open-ticket age histogram ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <CardTitle>Open Ticket Age</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">How long open tickets have been waiting</p>
        </CardHeader>
        <CardContent className="pb-5">
          <BarList
            rows={tickets.ageBuckets.map((b) => ({ label: b.bucket, value: b.count }))}
            color="#ef4444"
          />
        </CardContent>
      </Card>

      {/* ── Visibility funnel — PHOTO_APPROVAL tenants: month-wise card with real fraud flags ── */}
      {photoVisibility && <PhotoVisibilityCard initial={photoVisibility} />}

      {/* ── Visibility funnel (AMOUNT_UPLOAD) — rendered ONLY when the feature is enabled (payload non-null) ── */}
      {legacyVisibility && (
        <Card className="border border-gray-100 shadow-sm rounded-2xl" data-testid="operations-visibility-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-purple-600" />
              <CardTitle>Visibility Program Funnel</CardTitle>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Submission review funnel, fraud-flag rate &amp; outlet participation
            </p>
          </CardHeader>
          <CardContent className="pb-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <StatCard
                label="Approval Rate"
                value={fmtPct(legacyVisibility.approvalRatePct)}
                sub={`${fmtInt(legacyVisibility.approved)} approved`}
                icon={CheckCircle} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700"
              />
              <StatCard
                label="Fraud Flag Rate"
                value={fmtPct(legacyVisibility.fraudFlagPct)}
                sub="flagged submissions"
                icon={AlertCircle} iconBg="bg-red-100" iconColor="text-red-600" valColor="text-red-700"
              />
              <StatCard
                label="Participation"
                value={fmtPct(legacyVisibility.participationPct)}
                sub="of addressable outlets"
                icon={Eye} iconBg="bg-purple-100" iconColor="text-purple-600" valColor="text-purple-700"
              />
              <StatCard
                label="Submitted"
                value={fmtInt(legacyVisibility.submitted)}
                sub="entered review"
                icon={TicketIcon} iconBg="bg-blue-100" iconColor="text-blue-600" valColor="text-blue-700"
              />
            </div>
            <BarList
              rows={[
                { label: 'Submitted', value: legacyVisibility.submitted },
                { label: 'Approved', value: legacyVisibility.approved },
                { label: 'Rejected', value: legacyVisibility.rejected },
                { label: 'Flagged', value: legacyVisibility.flagged },
              ]}
              color="#8b5cf6"
            />
          </CardContent>
        </Card>
      )}

    </div>
  );
}

/* ─── Visibility (PHOTO_APPROVAL) — month-wise funnel + real fraud flags ───────── */

const APPROVAL_RATE_HINT =
  'Approved ÷ every capture a reviewer has decided this month (Approved + Needs re-take + Rejected + Not approved — window closed). Captures still waiting for review are not counted until a reviewer decides.';
const FRAUD_RATE_HINT =
  'Flagged ÷ Submitted. A capture is flagged when one of its photos is also used in another capture (duplicate photo), or a photo was taken outside the outlet’s fence.';
const PARTICIPATION_HINT =
  'In-scope outlets (KYC-approved, in the visibility scope) with at least one capture this month ÷ all in-scope outlets.';

const REASON_LABEL: Record<FlagRow['reasons'][number], string> = {
  DUPLICATE_PHOTO: 'Duplicate photo',
  OUTSIDE_FENCE: 'Photo outside the outlet fence',
};

const fmtPctOrDash = (n: number | null) => (n === null ? '—' : fmtPct(n));

function PhotoVisibilityCard({ initial }: { initial: PhotoVisibilityBlock }) {
  const [v, setV] = useState<PhotoVisibilityBlock>(initial);
  const [month, setMonth] = useState(initial.month);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFlags, setShowFlags] = useState(false);
  const months = useMemo(() => {
    const opts = monthOptions();
    // Keep the server's month selectable even if the local clock disagrees.
    return opts.some((o) => o.value === initial.month) ? opts : [{ value: initial.month, label: monthLabel(initial.month) }, ...opts];
  }, [initial.month]);
  const reqId = React.useRef(0);

  const pick = (m: string) => {
    setMonth(m);
    setShowFlags(false);
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/dashboard/operations/visibility?month=${encodeURIComponent(m)}`, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        const payload = (json && typeof json === 'object' && 'data' in json ? (json as { data: unknown }).data : json) as
          | { visibility?: VisibilityBlock | null }
          | null;
        const next = payload?.visibility;
        if (!next || next.mode !== 'PHOTO_APPROVAL') throw new Error('No visibility data was returned.');
        if (id === reqId.current) setV(next);
      })
      .catch((e: unknown) => { if (id === reqId.current) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  };

  return (
    <Card className="border border-gray-100 shadow-sm rounded-2xl" data-testid="operations-visibility-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-purple-600" />
            <CardTitle>Visibility Program Funnel</CardTitle>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-500">
            Month
            <select
              aria-label="Visibility funnel month"
              value={month}
              onChange={(e) => pick(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            >
              {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Loading" />}
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">
          {monthLabel(v.month)} · captures for in-scope outlets: review funnel, fraud flags &amp; outlet participation
        </p>
      </CardHeader>
      <CardContent className="pb-6">
        {error && (
          <p role="alert" className="mb-4 text-xs text-red-600">Couldn&apos;t load {monthLabel(month)} — {error} Showing {monthLabel(v.month)}.</p>
        )}
        <div className={`grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <StatCard
            label="Approval Rate"
            value={fmtPctOrDash(v.approvalRatePct)}
            sub={`${fmtInt(v.approved)} approved of ${fmtInt(v.approved + v.needsRetake + v.rejected + (v.closedNotApproved ?? 0))} reviewed`}
            hint={APPROVAL_RATE_HINT}
            icon={CheckCircle} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700"
          />
          <StatCard
            label="Fraud Flag Rate"
            value={fmtPctOrDash(v.fraudFlagPct)}
            sub={`${fmtInt(v.flagged)} flagged · ${fmtInt(v.duplicate)} duplicate · ${fmtInt(v.outsideFence)} outside fence`}
            hint={FRAUD_RATE_HINT}
            icon={AlertCircle} iconBg="bg-red-100" iconColor="text-red-600" valColor="text-red-700"
          />
          <StatCard
            label="Participation"
            value={v.participationPct === null ? 'Not tracked' : fmtPct(v.participationPct)}
            sub={
              v.participationPct === null
                ? 'imported month'
                : `${fmtInt(v.participatingOutlets)} of ${fmtInt(v.inScopeOutlets)} in-scope outlets`
            }
            hint={v.participationPct === null ? v.importedMonthNote ?? 'Not tracked for imported months.' : PARTICIPATION_HINT}
            icon={Eye} iconBg="bg-purple-100" iconColor="text-purple-600" valColor="text-purple-700"
          />
          <StatCard
            label="Submitted"
            value={fmtInt(v.submitted)}
            sub="captures this month"
            icon={TicketIcon} iconBg="bg-blue-100" iconColor="text-blue-600" valColor="text-blue-700"
          />
        </div>
        <BarList
          rows={[
            { label: 'Submitted', value: v.submitted },
            { label: PLAIN_STATUS_LABEL.APPROVED, value: v.approved },
            { label: PLAIN_STATUS_LABEL.WAITING, value: v.waiting },
            { label: PLAIN_STATUS_LABEL.NEEDS_RETAKE, value: v.needsRetake },
            { label: PLAIN_STATUS_LABEL.REJECTED, value: v.rejected },
            { label: PLAIN_STATUS_LABEL.CLOSED_NOT_APPROVED, value: v.closedNotApproved ?? 0 },
            { label: 'Flagged', value: v.flagged },
          ]}
          color="#8b5cf6"
        />
        {(v.waitingAllMonths ?? 0) > v.waiting && (
          <p className="mt-3 text-xs text-amber-700" data-testid="operations-visibility-waiting-all">
            {fmtInt(v.waitingAllMonths ?? 0)} captures are waiting for review across all months
            {(v.waitingEarlierMonths ?? 0) > 0 ? ` — ${fmtInt(v.waitingEarlierMonths ?? 0)} from months before ${monthLabel(v.month)}` : ''}.
          </p>
        )}
        {v.importedMonth && (
          <p className="mt-3 text-xs text-blue-800" role="note" data-testid="operations-visibility-imported">
            {monthLabel(v.month)} is an imported month. {v.importedMonthNote ?? 'Not tracked for imported months.'}
          </p>
        )}
        <div className="mt-4">
          {v.flagDetailsAvailable === false ? (
            // Owner decision pending: outlet-level fraud detail (outlet codes) stays with Gifsy for now.
            <p className="text-xs text-gray-500" data-testid="operations-visibility-flags-gifsy-only">
              {v.flagged === 0
                ? 'No flagged captures this month.'
                : `${fmtInt(v.flagged)} flagged capture${v.flagged === 1 ? '' : 's'} this month. The outlet-level list is available to Gifsy only.`}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setShowFlags((x) => !x)}
              disabled={v.flagged === 0}
              aria-expanded={showFlags}
              className="text-xs font-medium text-[var(--brand-primary)] hover:underline disabled:text-gray-400 disabled:no-underline"
            >
              {v.flagged === 0 ? 'No flagged captures this month' : showFlags ? 'Hide flagged captures' : `See the ${fmtInt(v.flagged)} flagged capture${v.flagged === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
        {showFlags && v.flagDetailsAvailable !== false && <FlagList month={v.month} onClose={() => setShowFlags(false)} />}
      </CardContent>
    </Card>
  );
}

function FlagList({ month, onClose }: { month: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FlagsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/dashboard/operations/visibility/flags?month=${encodeURIComponent(month)}&page=${page}&pageSize=50`, {
      headers: { ...authHeader() },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        const payload = (json && typeof json === 'object' && 'data' in json ? (json as { data: unknown }).data : json) as FlagsPage;
        if (!payload || !Array.isArray(payload.rows)) throw new Error('No data was returned.');
        if (!cancelled) setData(payload);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, page]);

  return (
    <section className="mt-4 border border-gray-100 rounded-xl" aria-label="Flagged captures" data-testid="operations-visibility-flags">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-700">Flagged captures — {monthLabel(month)}</p>
        <button type="button" onClick={onClose} aria-label="Close flagged captures" className="p-1 rounded hover:bg-gray-100 text-gray-500">
          <X className="w-4 h-4" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-4 text-xs text-red-600">Couldn&apos;t load the flagged captures — {error}</p>
      ) : !data ? (
        <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-gray-300" aria-label="Loading flagged captures" /></div>
      ) : (
        <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="px-3 py-2 font-medium">Outlet</th>
                <th className="px-3 py-2 font-medium">Window</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Why it is flagged</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.captureId} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2"><p className="font-medium text-gray-800">{r.outletName}</p><p className="text-gray-500">{r.outletCode}</p></td>
                  <td className="px-3 py-2 text-gray-700">{windowShortLabel(r.windowKey)}</td>
                  <td className="px-3 py-2 text-gray-700">{PLAIN_STATUS_LABEL[r.status] ?? r.status}</td>
                  <td className="px-3 py-2 text-gray-700">
                    <ul className="space-y-0.5">
                      {r.reasons.map((reason) => (
                        <li key={reason}>
                          <span className="font-medium">{REASON_LABEL[reason]}</span>
                          {reason === 'DUPLICATE_PHOTO' && r.duplicateOf.length > 0 && (
                            <span className="text-gray-500"> — same photo as {r.duplicateOf.slice(0, 3).map((d) => `${d.outletCode} (${monthLabel(d.windowKey.slice(0, 7))})`).join(', ')}{(r.duplicateCount ?? r.duplicateOf.length) > 3 ? ` +${(r.duplicateCount ?? r.duplicateOf.length) - 3} more` : ''}</span>
                          )}
                          {reason === 'OUTSIDE_FENCE' && (
                            <span className="text-gray-500"> — {r.outsidePhotos.length ? r.outsidePhotos.join(', ') : 'recorded outside at capture'}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.pagination.pages > 1 && (
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-100 text-xs text-gray-600">
              <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-40">Previous</button>
              <span>Page {data.pagination.page} of {data.pagination.pages}</span>
              <button type="button" disabled={page >= data.pagination.pages || loading} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded hover:bg-gray-100 disabled:opacity-40">Next</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
