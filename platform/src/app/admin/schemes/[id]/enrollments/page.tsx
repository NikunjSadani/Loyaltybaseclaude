'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Download, ClipboardList, AlertCircle, X, Loader2, MapPin, FileText,
  Image as ImageIcon, XCircle, Filter, ExternalLink, History, Pencil, Trash2, Save, Undo2,
} from 'lucide-react';
import {
  schemeApi, rewriteMediaViewPath,
  type AdminEnrollmentRow, type AdminEnrollmentDetail, type AdminListEnrollmentsQuery,
  type Pagination, type SchemeReport, type DeletedEnrollmentRow,
} from '@/lib/schemes';
import type { GpsCapture } from '@/lib/scheme-types';

// ─────────────────────────────────────────────────────────────────────────────
// Real per-scheme Enrollments view (D25) — replaces the empty export-only page.
// Stat tiles from the live report; a filterable roster list; a detail drawer with
// captured field values, media (auth-gated), geo pins, submission history and
// reject-with-reason; plus the xlsx export (auth-gated media links, D30).
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  SUBMITTED: 'bg-green-100 text-green-700',
  REJECTED:  'bg-red-100 text-red-600',
};

export default function EnrollmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);

  const [report, setReport]   = useState<SchemeReport | null>(null);
  const [rows, setRows]       = useState<AdminEnrollmentRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [page, setPage]       = useState(1);

  // Filters
  const [status, setStatus]         = useState('');
  const [programName, setProgram]   = useState('');
  const [zone, setZone]             = useState('');
  const [stateF, setStateF]         = useState('');
  const [outletTypeId, setOutletTypeId] = useState('');
  const [from, setFrom]             = useState('');
  const [to, setTo]                 = useState('');

  const [exporting, setExporting]   = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [openId, setOpenId]         = useState<string | null>(null);
  // After a soft-delete the drawer closes and this "deleted — Undo" toast appears; Undo
  // restores the enrollment (the admin list hides deleted rows, so this is the primary
  // way back). Auto-dismisses.
  const [undoToast, setUndoToast]   = useState<{ enrollmentId: string } | null>(null);
  const [restoring, setRestoring]   = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Persistent "Show deleted" recovery view — the durable path back for a soft-deleted enrollment
  // (the 8s Undo toast is only for the just-deleted one). Fetches the dedicated deleted-only list.
  const [showDeleted, setShowDeleted]     = useState(false);
  const [deletedRows, setDeletedRows]     = useState<DeletedEnrollmentRow[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [deletedError, setDeletedError]   = useState<string | null>(null);
  const [restoringId, setRestoringId]     = useState<string | null>(null);

  const query = useMemo<AdminListEnrollmentsQuery>(() => ({
    page,
    limit: 25,
    status: (status || undefined) as AdminListEnrollmentsQuery['status'],
    programName: programName || undefined,
    zone: zone || undefined,
    state: stateF || undefined,
    outletTypeId: outletTypeId || undefined,
    from: from || undefined,
    to: to || undefined,
  }), [page, status, programName, zone, stateF, outletTypeId, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [listRes, reportRes] = await Promise.all([
      schemeApi.listEnrollments(schemeId, query),
      schemeApi.getReport(schemeId),
    ]);
    if (listRes.success) {
      setRows(listRes.data.enrollments);
      setPagination(listRes.data.pagination ?? null);
    } else {
      setError(listRes.error);
    }
    if (reportRes.success) setReport(reportRes.data);
    setLoading(false);
  }, [schemeId, query]);

  const loadDeleted = useCallback(async () => {
    setDeletedLoading(true);
    setDeletedError(null);
    const res = await schemeApi.listDeletedEnrollments(schemeId);
    setDeletedLoading(false);
    if (res.success) setDeletedRows(res.data.enrollments);
    else setDeletedError(res.error);
  }, [schemeId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, programName, zone, stateF, outletTypeId, from, to]);

  // Auto-dismiss the undo toast after 8s.
  useEffect(() => {
    if (!undoToast) return;
    const t = setTimeout(() => setUndoToast(null), 8000);
    return () => clearTimeout(t);
  }, [undoToast]);

  const handleDeleted = useCallback((enrollmentId: string) => {
    setOpenId(null);
    setRestoreError(null);
    setUndoToast({ enrollmentId });
    void load();
    if (showDeleted) void loadDeleted();
  }, [load, showDeleted, loadDeleted]);

  const handleUndo = useCallback(async () => {
    if (!undoToast) return;
    setRestoring(true);
    setRestoreError(null);
    const res = await schemeApi.restoreEnrollment(schemeId, undoToast.enrollmentId);
    setRestoring(false);
    if (res.success) { setUndoToast(null); void load(); if (showDeleted) void loadDeleted(); }
    else setRestoreError(res.error);
  }, [undoToast, schemeId, load, showDeleted, loadDeleted]);

  const toggleDeleted = useCallback(() => {
    setShowDeleted((prev) => {
      const next = !prev;
      if (next) void loadDeleted();
      return next;
    });
  }, [loadDeleted]);

  // Restore from the persistent deleted view: un-delete, then refresh both lists.
  const handleRestoreRow = useCallback(async (enrollmentId: string) => {
    setRestoringId(enrollmentId);
    setDeletedError(null);
    const res = await schemeApi.restoreEnrollment(schemeId, enrollmentId);
    setRestoringId(null);
    if (res.success) { await loadDeleted(); void load(); }
    else setDeletedError(res.error);
  }, [schemeId, loadDeleted, load]);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const res = await schemeApi.downloadExport(schemeId);
    setExporting(false);
    if (!res.success) setExportError(res.error);
  };

  const resetFilters = () => { setStatus(''); setProgram(''); setZone(''); setStateF(''); setOutletTypeId(''); setFrom(''); setTo(''); };
  const hasFilters = !!(status || programName || zone || stateF || outletTypeId || from || to);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/admin/schemes/${schemeId}`} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"><ArrowLeft className="w-4 h-4" /></Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Enrollments</h1>
            <p className="text-xs text-gray-500">{report?.scheme.name ?? `Scheme ${schemeId}`} · captured data</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <button onClick={toggleDeleted}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${showDeleted ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
              <Trash2 className="w-4 h-4" />
              {showDeleted ? 'Hide deleted' : 'Show deleted'}
            </button>
            <button onClick={handleExport} disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
          {exportError && <p className="text-xs text-red-500 flex items-center gap-1 mt-1"><AlertCircle className="w-3 h-3" />{exportError}</p>}
        </div>
      </div>

      {/* Deleted (recovery) panel — persistent path back for any soft-deleted enrollment */}
      {showDeleted && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-gray-400" />
            <span className="text-xs font-semibold text-gray-700">Deleted enrollments</span>
            <span className="text-xs text-gray-400">— restore to bring the captured data back</span>
          </div>
          {deletedError && <p className="text-xs text-red-500 flex items-center gap-1 px-4 py-2"><AlertCircle className="w-3 h-3" />{deletedError}</p>}
          {deletedLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 text-gray-300 animate-spin" /></div>
          ) : deletedRows.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-400">No deleted enrollments.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-white border-b border-gray-100">
                <tr>{['Outlet', 'Status', 'Deleted at', ''].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {deletedRows.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-gray-900">{d.outletName || <span className="text-gray-400 italic">Unnamed</span>}</p>
                      <p className="text-xs text-gray-400 font-mono">{d.outletRef ?? ''}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[d.status] ?? 'bg-gray-100 text-gray-600'}`}>{d.status}{d.currentVersion > 1 ? ` · v${d.currentVersion}` : ''}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{d.deletedAt ? new Date(d.deletedAt).toLocaleString('en-IN') : '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => handleRestoreRow(d.id)} disabled={restoringId === d.id}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--brand-primary)] hover:underline disabled:opacity-60">
                        {restoringId === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Stat tiles (live report — no more hardcoded —) */}
      {report && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label="In roster" value={report.summary.rosterCount} />
          <StatTile label="Enrolled" value={report.summary.enrolledCount} tone="green" />
          <StatTile label="Submitted" value={report.summary.submittedCount} tone="green" />
          <StatTile label="Rejected" value={report.summary.rejectedCount} tone="red" />
          <StatTile label="Coverage" value={`${report.summary.coveragePct}%`} tone="blue" />
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 flex flex-wrap items-end gap-3">
        <FilterField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls}>
            <option value="">All</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </FilterField>
        <FilterField label="Program"><input value={programName} onChange={(e) => setProgram(e.target.value)} className={selCls} placeholder="program" /></FilterField>
        <FilterField label="Zone"><input value={zone} onChange={(e) => setZone(e.target.value)} className={selCls} placeholder="zone" /></FilterField>
        <FilterField label="State"><input value={stateF} onChange={(e) => setStateF(e.target.value)} className={selCls} placeholder="state" /></FilterField>
        <FilterField label="Outlet type id"><input value={outletTypeId} onChange={(e) => setOutletTypeId(e.target.value)} className={selCls} placeholder="type id" /></FilterField>
        <FilterField label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={selCls} /></FilterField>
        <FilterField label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={selCls} /></FilterField>
        {hasFilters && (
          <button onClick={resetFilters} className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-500 pb-1.5"><X className="w-3.5 h-3.5" /> Clear</button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" /></div>
      ) : error ? (
        <div className="py-16 text-center"><p className="text-sm text-red-500">{error}</p><button onClick={load} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button></div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 py-16 px-6 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center mx-auto mb-4"><ClipboardList className="w-6 h-6 text-gray-300" /></div>
          <p className="text-sm font-semibold text-gray-700">No enrollments{hasFilters ? ' match these filters' : ' yet'}</p>
          <p className="text-xs text-gray-500 mt-1">{hasFilters ? 'Adjust or clear the filters above.' : 'Roster rows appear here as outlets are enrolled.'}</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Outlet', 'Type', 'Program / Zone', 'Tagged rep', 'Status', ''].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.schemeOutletId} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-gray-900">{r.outletName || <span className="text-gray-400 italic">Unnamed</span>}</p>
                      <p className="text-xs text-gray-400 font-mono">{r.outletRef}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      {r.standalone
                        ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200">Standalone</span>
                        : <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">Matched</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">
                      {r.matchedOutlet?.programName ?? '—'}{r.matchedOutlet?.zone ? ` · ${r.matchedOutlet.zone}` : ''}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 font-mono">{r.taggedSalesUser?.employeeCode ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      {r.enrollment
                        ? <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[r.enrollment.status] ?? 'bg-gray-100 text-gray-600'}`}>{r.enrollment.status}{r.enrollment.currentVersion > 1 ? ` · v${r.enrollment.currentVersion}` : ''}</span>
                        : <span className="text-xs text-gray-400">Not enrolled</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {r.enrollment && (
                        <button onClick={() => setOpenId(r.enrollment!.id)} className="text-xs text-[var(--brand-primary)] font-medium hover:underline">View</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination && pagination.pages > 1 && (
            <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500 px-4 py-3 border-t border-gray-100">
              <span>Page <strong className="text-gray-700">{pagination.page}</strong> of <strong className="text-gray-700">{pagination.pages}</strong> · {pagination.total} total</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pagination.page <= 1} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Previous</button>
                <button onClick={() => setPage((p) => p + 1)} disabled={pagination.page >= pagination.pages} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </div>
      )}

      {openId && (
        <EnrollmentDrawer schemeId={schemeId} enrollmentId={openId} onClose={() => setOpenId(null)} onChanged={load} onDeleted={handleDeleted} />
      )}

      {/* Deleted — Undo toast (soft-delete recovery) */}
      {undoToast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-1">
          <div className="flex items-center gap-3 bg-gray-900 text-white text-sm rounded-xl shadow-lg px-4 py-2.5">
            <Trash2 className="w-4 h-4 text-gray-300" />
            <span>Enrollment deleted</span>
            <button onClick={handleUndo} disabled={restoring}
              className="flex items-center gap-1.5 text-[var(--brand-primary)] font-semibold hover:underline disabled:opacity-60">
              {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Undo
            </button>
            <button onClick={() => setUndoToast(null)} className="ml-1 text-gray-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>
          </div>
          {restoreError && <p className="text-xs text-red-500 bg-white rounded px-2 py-0.5 shadow">{restoreError}</p>}
        </div>
      )}
    </div>
  );
}

const editInputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]';

// Field types the admin cannot edit inline — their captured value (media object key,
// GPS fix, computed/display) is preserved untouched on the new version.
const UNEDITABLE_FIELD_TYPES = new Set<string>([
  'DOCUMENT', 'IMAGE', 'CAMERA', 'UPI_QR_SCAN', 'SIGNATURE', 'GPS_POINT',
  'CALCULATED', 'LOOKUP', 'SECTION', 'DATA_DISPLAY',
  // PHONE_OTP is the consented number — server-pinned / carried-forward on edit, never editable here.
  'PHONE_OTP',
]);

const selCls = 'border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]';

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] text-gray-500 mb-1 flex items-center gap-1"><Filter className="w-2.5 h-2.5" />{label}</label>
      {children}
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: 'green' | 'red' | 'blue' }) {
  const cls = tone === 'green' ? 'text-green-600' : tone === 'red' ? 'text-red-500' : tone === 'blue' ? 'text-blue-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className={`text-2xl font-bold ${cls}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

function EnrollmentDrawer({
  schemeId, enrollmentId, onClose, onChanged, onDeleted,
}: { schemeId: string; enrollmentId: string; onClose: () => void; onChanged: () => void; onDeleted: (enrollmentId: string) => void }) {
  const [detail, setDetail] = useState<AdminEnrollmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await schemeApi.getEnrollment(schemeId, enrollmentId);
    if (res.success) setDetail(res.data.enrollment);
    else setError(res.error);
    setLoading(false);
  }, [schemeId, enrollmentId]);

  useEffect(() => { void load(); }, [load]);

  const submitReject = async () => {
    if (!reason.trim()) { setRejectError('A reason is required.'); return; }
    setRejecting(true);
    setRejectError(null);
    const res = await schemeApi.reject(schemeId, enrollmentId, reason.trim());
    setRejecting(false);
    if (res.success) { setRejectOpen(false); setReason(''); await load(); onChanged(); }
    else setRejectError(res.error);
  };

  const submitDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    const res = await schemeApi.deleteEnrollment(schemeId, enrollmentId);
    setDeleting(false);
    if (res.success) onDeleted(enrollmentId); // parent closes drawer + refreshes + shows Undo toast
    else setDeleteError(res.error);
  };

  const onEditSaved = async () => { setMode('view'); await load(); onChanged(); };

  const outlet = detail?.schemeOutlet;
  const captured = (detail?.formValues ?? {}) as Record<string, unknown>;
  // Field ids surfaced as media/geo — so the raw-values list can skip them.
  const specialIds = new Set<string>([...(detail?.media ?? []).map((m) => m.fieldId), ...(detail?.geo ?? []).map((g) => g.fieldId)]);
  // Field id → human label for the captured form version (H5) — fall back to the raw id.
  const labelFor = (id: string) => detail?.formFields?.find((f) => f.id === id)?.label ?? id;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} aria-hidden />
      <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between z-10">
          <h2 className="text-sm font-bold text-gray-900">Enrollment detail</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" /></div>
        ) : error || !detail ? (
          <div className="py-20 text-center"><p className="text-sm text-red-500">{error ?? 'Not found'}</p></div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Outlet + status */}
            <div>
              <div className="flex items-center justify-between">
                <p className="text-base font-bold text-gray-900">{outlet?.matchedOutlet?.name ?? outlet?.outletName ?? 'Outlet'}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[detail.status] ?? 'bg-gray-100 text-gray-600'}`}>{detail.status}</span>
              </div>
              <p className="text-xs text-gray-400 font-mono">{outlet?.matchedOutlet?.outletCode ?? ''}</p>
              <p className="text-xs text-gray-500 mt-1">
                Mode {detail.enrollmentMode} · v{detail.currentVersion} · {new Date(detail.enrolledAt).toLocaleString('en-IN')}
              </p>
              {detail.status === 'REJECTED' && detail.rejectionReason && (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-600">
                  <strong>Rejected:</strong> {detail.rejectionReason}
                </div>
              )}
            </div>

            {mode === 'edit' ? (
              <EnrollmentEditForm
                schemeId={schemeId}
                enrollmentId={enrollmentId}
                detail={detail}
                onSaved={onEditSaved}
                onCancel={() => setMode('view')}
              />
            ) : (
             <>
            {/* Admin actions — Edit / Delete (Reject stays below) */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => { setMode('edit'); setConfirmDelete(false); }}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                {!confirmDelete ? (
                  <button onClick={() => { setConfirmDelete(true); setDeleteError(null); }}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-600">Delete this enrollment? It frees the roster row to re-enroll.</span>
                    <button onClick={submitDelete} disabled={deleting}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-60">
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Confirm
                    </button>
                    <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                      className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-60">Cancel</button>
                  </div>
                )}
              </div>
              {deleteError && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{deleteError}</p>}
            </div>

            {/* Captured values */}
            <Section title="Captured values">
              {Object.keys(captured).filter((k) => !specialIds.has(k)).length === 0 ? (
                <p className="text-xs text-gray-400">No text values captured.</p>
              ) : (
                <dl className="space-y-1.5">
                  {Object.entries(captured).filter(([k]) => !specialIds.has(k)).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 text-xs">
                      <dt className="text-gray-500 truncate">{labelFor(k)}</dt>
                      <dd className="text-gray-800 font-medium text-right break-words">{formatValue(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Section>

            {/* Media */}
            {detail.media.length > 0 && (
              <Section title={`Photos & documents (${detail.media.length})`}>
                <div className="grid grid-cols-2 gap-2">
                  {detail.media.map((m) => {
                    const href = rewriteMediaViewPath(m.viewPath);
                    const isImage = /IMAGE|CAMERA|SIGNATURE|UPI/i.test(m.type);
                    return (
                      <a key={m.fieldId + m.key} href={href} target="_blank" rel="noopener noreferrer"
                        className="border border-gray-200 rounded-lg overflow-hidden hover:border-[var(--brand-primary)] transition-colors group">
                        {isImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={href} alt={m.label} className="w-full h-24 object-cover bg-gray-50" />
                        ) : (
                          <div className="w-full h-24 flex items-center justify-center bg-gray-50"><FileText className="w-6 h-6 text-gray-300" /></div>
                        )}
                        <div className="px-2 py-1.5 flex items-center gap-1 text-[10px] text-gray-600">
                          {isImage ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                          <span className="truncate flex-1">{m.label}</span>
                          <ExternalLink className="w-3 h-3 text-gray-300 group-hover:text-[var(--brand-primary)]" />
                        </div>
                      </a>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* Geo */}
            {detail.geo.length > 0 && (
              <Section title="Location">
                {detail.geo.map((g) => (
                  <GeoPin key={g.fieldId} label={g.label} value={g.value}
                    registered={typeof outlet?.matchedOutlet?.latitude === 'number' && typeof outlet?.matchedOutlet?.longitude === 'number' ? { lat: outlet.matchedOutlet.latitude, lng: outlet.matchedOutlet.longitude } : null} />
                ))}
              </Section>
            )}

            {/* Submission history */}
            {detail.submissions.length > 0 && (
              <Section title={`Submission history (${detail.submissions.length})`}>
                <ul className="space-y-2">
                  {detail.submissions.map((s) => (
                    <li key={s.id} className="flex items-start gap-2 text-xs">
                      <History className="w-3.5 h-3.5 text-gray-300 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium text-gray-700">v{s.version}</span>
                        <span className={`ml-2 px-1.5 py-0.5 rounded-full ${STATUS_STYLES[s.status] ?? 'bg-gray-100 text-gray-600'}`}>{s.status}</span>
                        <span className="ml-2 text-gray-400">{new Date(s.createdAt).toLocaleString('en-IN')}</span>
                        {s.status === 'REJECTED' && s.rejectionReason && (
                          <p className="text-red-500 mt-0.5"><span className="font-medium">Reason:</span> {s.rejectionReason}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Reject */}
            {detail.status !== 'REJECTED' && (
              <div className="border-t border-gray-100 pt-4">
                {rejectOpen ? (
                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-gray-700">Rejection reason</label>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                      placeholder="Explain why — the filler resubmits the whole form (D10)."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none" />
                    {rejectError && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{rejectError}</p>}
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => { setRejectOpen(false); setRejectError(null); }} className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50">Cancel</button>
                      <button onClick={submitReject} disabled={rejecting}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-60">
                        {rejecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />} Reject enrollment
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setRejectOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
                    <XCircle className="w-3.5 h-3.5" /> Reject with reason
                  </button>
                )}
              </div>
            )}
             </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Admin inline edit form (minimal field editor from formFields + formValues) ──
//
// A lightweight editor — NOT the full SchemeFormRenderer, which submits via the
// enrollee `enroll` path. This edits scalar captured values and PUTs them via
// `adminEditEnrollment` (saved as a new version). Media / GPS / computed fields are
// shown read-only; the payload starts from the FULL current formValues so those
// untouched values are preserved on the new version.

function EnrollmentEditForm({
  schemeId, enrollmentId, detail, onSaved, onCancel,
}: {
  schemeId: string;
  enrollmentId: string;
  detail: AdminEnrollmentDetail;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const fields = useMemo<NonNullable<AdminEnrollmentDetail['formFields']>>(
    () =>
      detail.formFields ??
      Object.keys((detail.formValues ?? {}) as Record<string, unknown>).map((id) => ({ id, label: id, type: 'TEXT' })),
    [detail],
  );
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...((detail.formValues ?? {}) as Record<string, unknown>) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, v: unknown) => setValues((p) => ({ ...p, [id]: v }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await schemeApi.adminEditEnrollment(schemeId, enrollmentId, { formValues: values });
    setSaving(false);
    if (res.success) await onSaved();
    else setError(res.error);
  };

  const isOn = (v: unknown) => v === true || v === 'true' || v === 'yes' || v === '1';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-[11px] text-blue-700">
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        Saving creates a NEW version of this enrollment. Photos, signatures and location can’t be edited here — their captured values are kept.
      </div>

      <div className="space-y-3">
        {fields.map((f) => {
          const v = values[f.id];
          // Any object-valued field (media key, GPS fix) is uneditable regardless of type — this
          // also covers the `formFields`-absent fallback where every field is typed TEXT (B-LOW-1),
          // so a captured media/GPS object never renders as an editable "[object Object]" text box.
          // EXCEPTION (H2): a MULTI_SELECT value is a `string[]`, which is also `typeof 'object'`.
          // Left unqualified, every non-empty MULTI_SELECT would be caught here and shown as
          // uneditable, so the ENR-M7 checkbox editor below would never render for real data. Exempt
          // ONLY a MULTI_SELECT array — a plain object `{}` / media / GPS object is still caught.
          const isObjectVal = v != null && typeof v === 'object' && !(f.type === 'MULTI_SELECT' && Array.isArray(v));
          if (UNEDITABLE_FIELD_TYPES.has(f.type) || isObjectVal) {
            const isObj = isObjectVal;
            return (
              <div key={f.id}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                <div className="text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  {isObj ? 'Captured value kept (not editable here)' : v == null || v === '' ? '—' : String(v)}
                </div>
              </div>
            );
          }
          if (f.type === 'TOGGLE') {
            return (
              <div key={f.id}>
                <label htmlFor={`edit-${f.id}`} className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input id={`edit-${f.id}`} type="checkbox" checked={isOn(v)} onChange={(e) => set(f.id, e.target.checked)} />
                  {isOn(v) ? 'Yes' : 'No'}
                </label>
              </div>
            );
          }
          if (f.type === 'MULTI_SELECT') {
            // ENR-M7: render options as real checkboxes (mirrors SchemeFormRenderer's
            // MULTI_SELECT), writing the SAME string[] shape the backend expects — never a
            // hand-typed comma string. Legacy comma-string values are read tolerantly.
            //
            // The H5 formFields snapshot on the wire now carries the declared `options` list
            // (typed, additive) alongside {id,label,type}. We union any declared options with
            // the values already selected so nothing captured is lost, and fall back to the
            // prior comma input only when NO option set can be derived at all (empty enrollment
            // + no declared options) — no regression.
            const selected = Array.isArray(v)
              ? (v as string[])
              : typeof v === 'string' && v
                ? v.split(',').map((s) => s.trim()).filter(Boolean)
                : [];
            const declared = f.options ?? [];
            const options = Array.from(new Set([...declared, ...selected]));
            const toggle = (opt: string) =>
              set(f.id, selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt]);
            if (options.length === 0) {
              return (
                <div key={f.id}>
                  <label htmlFor={`edit-${f.id}`} className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                  <input id={`edit-${f.id}`} type="text" className={editInputCls} placeholder="comma-separated"
                    value={selected.join(', ')}
                    onChange={(e) => set(f.id, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
                </div>
              );
            }
            return (
              <div key={f.id}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                <div className="space-y-1.5">
                  {options.map((opt) => (
                    <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={selected.includes(opt)}
                        onChange={() => toggle(opt)} aria-label={`${f.label}: ${opt}`} />
                      {opt}
                    </label>
                  ))}
                </div>
              </div>
            );
          }
          const inputType = f.type === 'NUMBER' ? 'number' : f.type === 'DATE' ? 'date' : f.type === 'EMAIL' ? 'email' : 'text';
          return (
            <div key={f.id}>
              <label htmlFor={`edit-${f.id}`} className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
              <input id={`edit-${f.id}`} type={inputType} className={editInputCls}
                value={v == null ? '' : String(v)} onChange={(e) => set(f.id, e.target.value)} />
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{error}</p>}

      <div className="flex gap-2 justify-end border-t border-gray-100 pt-3">
        <button onClick={onCancel} disabled={saving}
          className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-60">Cancel</button>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] disabled:opacity-60">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save changes
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-700 mb-2">{title}</p>
      {children}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── Simple geo pin map ────────────────────────────────────────────────────────

function isGps(v: unknown): v is GpsCapture {
  return !!v && typeof v === 'object' && typeof (v as GpsCapture).lat === 'number' && typeof (v as GpsCapture).lng === 'number';
}

function GeoPin({ label, value, registered }: { label: string; value: unknown; registered: { lat: number; lng: number } | null }) {
  if (!isGps(value)) return <p className="text-xs text-gray-400">{label}: no fix captured.</p>;
  const cap = value;
  // Distance between captured + registered (haversine, metres) — flag outliers.
  let distance: number | null = null;
  if (registered) {
    const R = 6371e3;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(cap.lat - registered.lat);
    const dLng = toRad(cap.lng - registered.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(registered.lat)) * Math.cos(toRad(cap.lat)) * Math.sin(dLng / 2) ** 2;
    distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }
  // Normalize the two points into a small SVG viewport for a "simple map".
  const pts = [{ lat: cap.lat, lng: cap.lng, kind: 'cap' as const }, ...(registered ? [{ ...registered, kind: 'reg' as const }] : [])];
  const lats = pts.map((p) => p.lat); const lngs = pts.map((p) => p.lng);
  const spanLat = Math.max(0.0005, Math.max(...lats) - Math.min(...lats));
  const spanLng = Math.max(0.0005, Math.max(...lngs) - Math.min(...lngs));
  const nx = (lng: number) => 10 + ((lng - Math.min(...lngs)) / spanLng) * 200;
  const ny = (lat: number) => 90 - ((lat - Math.min(...lats)) / spanLat) * 70;
  const osm = `https://www.openstreetmap.org/?mlat=${cap.lat}&mlon=${cap.lng}#map=17/${cap.lat}/${cap.lng}`;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700 flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-green-500" />{label}</span>
        <a href={osm} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[var(--brand-primary)] hover:underline flex items-center gap-0.5">Map <ExternalLink className="w-2.5 h-2.5" /></a>
      </div>
      <svg viewBox="0 0 220 100" className="w-full bg-slate-50" style={{ maxHeight: 110 }}>
        {registered && <line x1={nx(registered.lng)} y1={ny(registered.lat)} x2={nx(cap.lng)} y2={ny(cap.lat)} stroke="#cbd5e1" strokeDasharray="3 3" />}
        {registered && <circle cx={nx(registered.lng)} cy={ny(registered.lat)} r={4} fill="#3b82f6" />}
        <circle cx={nx(cap.lng)} cy={ny(cap.lat)} r={5} fill="#ef4444" />
      </svg>
      <div className="px-3 py-2 text-[11px] text-gray-600 space-y-0.5">
        <p><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1" />Captured: {cap.lat.toFixed(6)}, {cap.lng.toFixed(6)}{cap.accuracy != null ? ` (±${cap.accuracy}m)` : ''}</p>
        {registered && <p><span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1" />Registered outlet location</p>}
        {distance != null && (
          <p className={distance > 500 ? 'text-amber-600 font-medium' : 'text-gray-500'}>
            {distance > 500 && <AlertCircle className="w-3 h-3 inline mr-1" />}
            {distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${distance} m`} from registered location{distance > 500 ? ' — review' : ''}
          </p>
        )}
      </div>
    </div>
  );
}
