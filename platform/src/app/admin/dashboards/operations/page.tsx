'use client';

/* ─── Admin Operations Dashboard (REAL data) ─────────────────────────────────────
   100% wired to GET /api/admin/dashboard/operations (proxy → backend
   /v1/admin/dashboard/operations). Every number comes from that endpoint — there are
   NO hardcoded metric constants or fabricated arrays. On fetch failure or an empty
   payload an explicit error state is shown (never a mock fallback). Metrics the backend
   cannot source (e.g. first-response when the ticket flow never writes firstResponseAt)
   arrive as null and render as "—". The visibility card renders ONLY when the payload's
   `visibility` block is non-null (tenant has the feature enabled).
   Mirrors the fetch/loading/error/styling pattern of /admin/dashboards/kyc/page.tsx.
──────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote, CheckCircle, XCircle, Clock, AlertCircle,
  Ticket as TicketIcon, Timer, ShieldCheck, Loader2, Eye,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';

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

interface VisibilityBlock {
  enabled: boolean;
  submitted: number;
  approved: number;
  rejected: number;
  flagged: number;
  approvalRatePct: number;
  fraudFlagPct: number;
  participationPct: number;
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
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ─── Small presentational pieces (chrome only, fully prop-driven) ──────────── */

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  valColor: string;
}

function StatCard({ label, value, sub, icon: Icon, iconBg, iconColor, valColor }: StatCardProps) {
  return (
    <Card className="border border-gray-100 shadow-sm rounded-2xl">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm text-gray-500">{label}</p>
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

      {/* ── Visibility funnel — rendered ONLY when the feature is enabled (payload non-null) ── */}
      {visibility && (
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
                value={fmtPct(visibility.approvalRatePct)}
                sub={`${fmtInt(visibility.approved)} approved`}
                icon={CheckCircle} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700"
              />
              <StatCard
                label="Fraud Flag Rate"
                value={fmtPct(visibility.fraudFlagPct)}
                sub="flagged submissions"
                icon={AlertCircle} iconBg="bg-red-100" iconColor="text-red-600" valColor="text-red-700"
              />
              <StatCard
                label="Participation"
                value={fmtPct(visibility.participationPct)}
                sub="of addressable outlets"
                icon={Eye} iconBg="bg-purple-100" iconColor="text-purple-600" valColor="text-purple-700"
              />
              <StatCard
                label="Submitted"
                value={fmtInt(visibility.submitted)}
                sub="entered review"
                icon={TicketIcon} iconBg="bg-blue-100" iconColor="text-blue-600" valColor="text-blue-700"
              />
            </div>
            <BarList
              rows={[
                { label: 'Submitted', value: visibility.submitted },
                { label: 'Approved', value: visibility.approved },
                { label: 'Rejected', value: visibility.rejected },
                { label: 'Flagged', value: visibility.flagged },
              ]}
              color="#8b5cf6"
            />
          </CardContent>
        </Card>
      )}

    </div>
  );
}
