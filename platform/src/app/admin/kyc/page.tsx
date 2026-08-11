'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Download,
  AlertTriangle,
  Clock,
  CheckCircle,
  XCircle,
  Filter,
  ChevronRight,
  Eye,
} from 'lucide-react';
import Link from 'next/link';
import { Spinner } from '@/components/ui/spinner';
import { authHeader } from '@/lib/api-client';
import { useAdminSession } from '@/lib/admin-session';
import { fetchKycSlaTargets } from '@/lib/kyc-sla';
import {
  kycStageSla,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
  type KycSlaTargets,
  type KycSlaResult,
} from '@/lib/kyc-sla-stage';
import { fetchHolidayDateSet } from '@/lib/holidays';
import { downloadBlob } from '@/lib/download';

type KYCStatusType = 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'RESUBMISSION_REQUIRED';

interface KYCEntry {
  id: string;
  outletName: string;
  ownerName: string;
  mobile: string;
  salesUser: string;
  status: KYCStatusType;
  submittedDate: string;
  // Stage-aware SLA result — which clock (field/gifsy/none), the business-hours age,
  // the per-stage target, and whether it has breached. Drives the list's SLA badge.
  sla: KycSlaResult;
}

/* ─── API mapping ────────────────────────────────────────────────────────────── */

interface ApiKycSub {
  id: string;
  status: string;
  submittedAt?: string | null;
  createdAt?: string;
  // Decision timestamps — the SLA clock STOPS at the decision, not at "now".
  reviewedAt?: string | null; // set when a reviewer acts (reject / request-resubmit / forward)
  approvedAt?: string | null; // set only on final approval
  updatedAt?: string | null;  // last-write fallback for a decided row missing the above
  gifsyEnteredAt?: string | null; // ISO of the LATEST PENDING_GIFSY entry (null when never reached Gifsy)
  user: { id: string; name: string; phone: string };
  partner?: {
    id: string;
    businessName: string;
    ownerName?: string;
    phone?: string;
    outlets?: { name: string; outletCode: string; phone?: string }[];
  } | null;
  documents?: { id: string; documentType: string; status: string }[];
}

const DB_STATUS_MAP: Record<string, KYCStatusType> = {
  SUBMITTED: 'PENDING', PENDING_SO_APPROVAL: 'PENDING',
  PENDING_ASM_APPROVAL: 'PENDING', PENDING_RSM_APPROVAL: 'PENDING',
  PENDING_GIFSY: 'PENDING', UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED', REJECTED: 'REJECTED',
  RESUBMISSION_REQUIRED: 'RESUBMISSION_REQUIRED',
};

function mapApiKyc(s: ApiKycSub, targets: KycSlaTargets, holidays: Set<string>): KYCEntry {
  const submittedAt = s.submittedAt ?? s.createdAt ?? '';
  // Two-stage, business-hours SLA (kycStageSla): a row sits on the FIELD clock
  // (submission → reaching Gifsy) or the GIFSY clock (latest PENDING_GIFSY entry →
  // decision), frozen once decided, or 'none' for a draft/terminal row. Pass the RAW
  // backend status so the stage is resolved correctly (not the mapped KYCStatusType).
  const sla = kycStageSla(
    {
      status: s.status,
      submittedAt,
      gifsyEnteredAt: s.gifsyEnteredAt ?? null,
      approvedAt: s.approvedAt ?? null,
      reviewedAt: s.reviewedAt ?? null,
      updatedAt: s.updatedAt ?? null,
      nowMs: Date.now(),
    },
    targets,
    holidays,
  );
  return {
    id:            s.id,
    outletName:    s.partner?.outlets?.[0]?.name ?? s.partner?.businessName ?? '',
    ownerName:     s.partner?.ownerName ?? '',
    mobile:        s.partner?.outlets?.[0]?.phone ?? s.partner?.phone ?? '',
    salesUser:     s.user.name,
    status:        DB_STATUS_MAP[s.status] ?? 'PENDING',
    submittedDate: submittedAt.slice(0, 10),
    sla,
  };
}


const STATUS_STYLES: Record<KYCStatusType, string> = {
  PENDING: 'bg-amber-100 text-amber-700',
  UNDER_REVIEW: 'bg-blue-100 text-blue-700',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  RESUBMISSION_REQUIRED: 'bg-orange-100 text-orange-700',
};

const STATUS_LABELS: Record<KYCStatusType, string> = {
  PENDING: 'Pending',
  UNDER_REVIEW: 'Under Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RESUBMISSION_REQUIRED: 'Re-upload Required',
};

/** "Awaiting review" = PENDING or UNDER_REVIEW. Shared by the Pending stat CARD
 *  and the list's Pending FILTER so the card count and the rows shown reconcile. */
const isPending = (s: KYCStatusType) => s === 'PENDING' || s === 'UNDER_REVIEW';

export default function KYCPage() {
  // Role gate: GET /api/kyc/review-dump is @Roles('GIFSY_ADMIN') only.
  const adminSession = useAdminSession();
  const isGifsyAdmin = adminSession.role === 'GIFSY_ADMIN';

  const [kycList, setKycList] = useState<KYCEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<KYCStatusType | 'ALL'>('ALL');
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch the SLA targets + holiday calendar alongside the list so the stage-aware
    // badge is computed in business hours from the first render. Both fall back to
    // safe defaults on any error (fieldHrs/gifsyHrs → 24/96, holidays → empty set —
    // still weekend-aware), so a config read never blocks the list.
    const DEFAULT_TARGETS: KycSlaTargets = { fieldHrs: KYC_FIELD_SLA_DEFAULT, gifsyHrs: KYC_GIFSY_SLA_DEFAULT };
    Promise.all([
      fetch('/api/kyc?limit=500', { headers: { ...authHeader() } }).then((r) => r.json()),
      fetchHolidayDateSet().catch(() => new Set<string>()),
      fetchKycSlaTargets().catch(() => DEFAULT_TARGETS),
    ])
      .then(([json, holidays, targets]: [
        { success: boolean; data?: { submissions: ApiKycSub[] }; error?: string },
        Set<string>,
        KycSlaTargets,
      ]) => {
        if (json.success && json.data) {
          setKycList(json.data.submissions.map((s) => mapApiKyc(s, targets, holidays)));
        } else {
          setError(json.error ?? 'Failed to load KYC submissions');
        }
      })
      .catch(() => setError('Failed to load KYC submissions'))
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => ({
    total:    kycList.length,
    pending:  kycList.filter((k) => isPending(k.status)).length,
    approved: kycList.filter((k) => k.status === 'APPROVED').length,
    rejected: kycList.filter((k) => k.status === 'REJECTED').length,
  }), [kycList]);

  const filtered = useMemo(() => {
    return kycList.filter((k) => {
      const matchSearch =
        !search ||
        k.outletName.toLowerCase().includes(search.toLowerCase()) ||
        k.ownerName.toLowerCase().includes(search.toLowerCase()) ||
        k.mobile.includes(search) ||
        k.salesUser.toLowerCase().includes(search.toLowerCase());
      const matchStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'PENDING' ? isPending(k.status) : k.status === statusFilter);
      return matchSearch && matchStatus;
    });
  }, [search, statusFilter, kycList]);

  const handleExport = async () => {
    setExportLoading(true);
    setExportError(null);
    try {
      // On the Rejected filter, export the "Rejected outlets" report (full KYC +
      // which fields the admin rejected + per-field remark); otherwise the Lane A
      // review-dump of pending submissions.
      const rejected = statusFilter === 'REJECTED';
      const url = rejected ? '/api/kyc/rejected-export' : '/api/kyc/review-dump';
      const filePrefix = rejected ? 'kyc-rejected' : 'kyc-review-dump';
      const res = await fetch(url, {
        headers: { ...authHeader() },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      downloadBlob(blob, `${filePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExportLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen px-6 text-center text-sm text-red-500">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total', value: stats.total, icon: Filter, color: 'text-gray-600 bg-gray-100', filter: 'ALL' },
          { label: 'Pending', value: stats.pending, icon: Clock, color: 'text-amber-600 bg-amber-100', filter: 'PENDING' },
          { label: 'Approved', value: stats.approved, icon: CheckCircle, color: 'text-green-600 bg-green-100', filter: 'APPROVED' },
          { label: 'Rejected', value: stats.rejected, icon: XCircle, color: 'text-red-600 bg-red-100', filter: 'REJECTED' },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              onClick={() => setStatusFilter(s.filter as KYCStatusType | 'ALL')}
              className={`bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-3 hover:shadow-md transition-all text-left ${
                statusFilter === s.filter ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/20' : ''
              }`}
            >
              <div className={`p-2 rounded-lg ${s.color}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xl font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Filters & actions */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <div className="flex flex-col sm:flex-row gap-3 flex-1">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search outlet, mobile, sales user..."
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as KYCStatusType | 'ALL')}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            >
              <option value="ALL">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="UNDER_REVIEW">Under Review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="RESUBMISSION_REQUIRED">Re-upload Required</option>
            </select>
          </div>
          {isGifsyAdmin && (
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={handleExport}
                disabled={exportLoading}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                {exportLoading ? 'Exporting...' : 'Export Excel'}
              </button>
              {exportError && (
                <span className="flex items-center gap-1 text-xs text-red-600">
                  <AlertTriangle className="w-3 h-3" />{exportError}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Outlet</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Mobile</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Sales User</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Submitted</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Age (hrs)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                    No KYC records match your filters
                  </td>
                </tr>
              ) : (
                filtered.map((k) => {
                  // Stage-aware SLA badge: which clock the row is on (Field = sales chain,
                  // Gifsy = final approval), its business-hours age, and breach vs THIS stage's
                  // configured target. A 'none' row (draft/terminal-without-Gifsy) shows no badge.
                  const sla = k.sla;
                  const showSla = sla.clock !== 'none' && sla.targetHrs != null;
                  const target = sla.targetHrs ?? 0;
                  const breached = sla.breached;
                  const amber = !breached && target > 0 && sla.ageHrs > target * 0.75; // warning band = last 25%
                  const slaPct = target > 0 ? Math.min(Math.round((sla.ageHrs / target) * 100), 100) : 0;
                  const slaBarColor = breached ? 'bg-red-400' : amber ? 'bg-amber-400' : 'bg-emerald-400';
                  const stageTag = sla.clock === 'gifsy' ? 'Gifsy' : 'Field';
                  return (
                  <tr key={k.id} className={`hover:bg-gray-50 transition-colors ${breached ? 'border-l-2 border-l-red-400' : ''}`}>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900">{k.outletName}</p>
                      {k.ownerName && <p className="text-xs text-gray-400">Owner: {k.ownerName}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{k.mobile}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{k.salesUser}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[k.status]}`}>
                        {STATUS_LABELS[k.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{k.submittedDate}</td>
                    <td className="px-4 py-3">
                      {showSla ? (
                        <div className="space-y-1 min-w-[72px]">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-sm font-bold ${breached ? 'text-red-600' : amber ? 'text-amber-600' : 'text-gray-700'}`}>
                              {sla.ageHrs}h
                            </span>
                            <span
                              className={`text-[9px] font-semibold px-1 py-0.5 rounded ${
                                sla.clock === 'gifsy' ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-600'
                              }`}
                              title={sla.clock === 'gifsy' ? 'Gifsy SLA — final approval clock' : 'Field SLA — sales-chain clock'}
                            >
                              {stageTag}
                            </span>
                            {breached && (
                              <span className="text-[9px] font-bold bg-red-100 text-red-600 px-1 py-0.5 rounded">SLA!</span>
                            )}
                          </div>
                          <div className="h-1 bg-gray-100 rounded-full overflow-hidden w-16">
                            <div className={`h-full rounded-full ${slaBarColor}`} style={{ width: `${slaPct}%` }} />
                          </div>
                          <p className="text-[9px] text-gray-400">{slaPct}% of {target}h SLA</p>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/kyc/${k.id}`}
                        className="inline-flex items-center gap-1 text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Review
                        <ChevronRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <p className="text-xs text-gray-500">
            Showing {filtered.length} of {kycList.length} KYC submissions
          </p>
        </div>
      </div>
    </div>
  );
}
