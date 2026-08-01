'use client';

/**
 * VisibilityCaptureQueue — the REAL GIFSY_ADMIN approve/reject queue for Visibility
 * (POSM) captures (VISIBILITY-POSM-DESIGN.md D12). Replaces the dead fake photo queue.
 *
 * A filterable capture list (window / status / outlet) + a detail drawer (cloned-and-
 * adapted from the Scheme EnrollmentDrawer) showing:
 *   - captured field values,
 *   - a media grid (auth-gated via rewriteMediaViewPath),
 *   - a geo pin + geo-fence badge (distanceMeters + ok / outside / unverifiable),
 *   - duplicate-photo matches ("same photo also on outlet X / window Y"),
 *   - the append-only submission history,
 *   - approve, and reject-with-reason (controlled reason code + optional free text).
 *
 * It does NOT import the scheme feature.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardList, AlertCircle, X, Loader2, MapPin, ExternalLink, History,
  Image as ImageIcon, XCircle, CheckCircle2, Filter, Copy,
} from 'lucide-react';
import {
  visibilityApi, rewriteMediaViewPath,
} from '@/lib/visibility';
import type {
  AdminListCapturesQuery,
} from '@/lib/visibility';
import {
  VISIBILITY_REJECT_REASON_CODES,
  VISIBILITY_REJECT_REASON_LABELS,
  type Pagination,
  type PhotoFenceStatus,
  type VisibilityCaptureDetail,
  type VisibilityCaptureRow,
  type VisibilityCaptureStatus,
  type VisibilityGeoRef,
  type VisibilityRejectReasonCode,
} from '@/lib/visibility-types';

const STATUS_STYLES: Record<string, string> = {
  SUBMITTED: 'bg-amber-100 text-amber-700',
  APPROVED:  'bg-green-100 text-green-700',
  REJECTED:  'bg-red-100 text-red-600',
};

export function VisibilityCaptureQueue() {
  const [rows, setRows] = useState<VisibilityCaptureRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [status, setStatus] = useState<VisibilityCaptureStatus | ''>('SUBMITTED');
  const [windowKey, setWindowKey] = useState('');
  const [outletCode, setOutletCode] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useMemo<AdminListCapturesQuery>(() => ({
    page,
    limit: 25,
    status: (status || undefined) as VisibilityCaptureStatus | undefined,
    windowKey: windowKey || undefined,
    outletCode: outletCode || undefined,
  }), [page, status, windowKey, outletCode]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await visibilityApi.listCaptures(query);
    if (res.success) {
      setRows(res.data.captures);
      setPagination(res.data.pagination ?? null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [query]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, windowKey, outletCode]);

  const hasFilters = !!(windowKey || outletCode || status);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 flex flex-wrap items-end gap-3">
        <FilterField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as VisibilityCaptureStatus | '')} className={selCls}>
            <option value="">All</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </FilterField>
        <FilterField label="Window (YYYY-MM-Pn)"><input value={windowKey} onChange={(e) => setWindowKey(e.target.value)} className={selCls} placeholder="2026-07-P2" /></FilterField>
        <FilterField label="Outlet code"><input value={outletCode} onChange={(e) => setOutletCode(e.target.value)} className={selCls} placeholder="outlet code" /></FilterField>
        {hasFilters && (
          <button onClick={() => { setStatus(''); setWindowKey(''); setOutletCode(''); }}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-500 pb-1.5"><X className="w-3.5 h-3.5" /> Clear</button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" /></div>
      ) : error ? (
        <div className="py-16 text-center"><p className="text-sm text-red-500">{error}</p><button onClick={load} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button></div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 py-16 px-6 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center mx-auto mb-4"><ClipboardList className="w-6 h-6 text-gray-300" /></div>
          <p className="text-sm font-semibold text-gray-700">No captures{hasFilters ? ' match these filters' : ' yet'}</p>
          <p className="text-xs text-gray-500 mt-1">{hasFilters ? 'Adjust or clear the filters above.' : 'Captures appear here as reps submit them.'}</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Outlet', 'Window', 'Geo-fence', 'Rep', 'Status', ''].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-gray-900">{r.outletName || <span className="text-gray-400 italic">Unnamed</span>}</p>
                      <p className="text-xs text-gray-400 font-mono">{r.outletCode}</p>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 font-mono">{r.windowKey}</td>
                    <td className="px-4 py-2.5"><GeoBadge geoFenceOk={r.geoFenceOk} distanceMeters={r.distanceMeters} /></td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 font-mono">{r.submittedBy?.employeeCode ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-600'}`}>{r.status}{r.currentVersion > 1 ? ` · v${r.currentVersion}` : ''}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => setOpenId(r.id)} className="text-xs text-[var(--brand-primary)] font-medium hover:underline">Review</button>
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
        <CaptureDrawer captureId={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </div>
  );
}

const selCls = 'border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]';

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] text-gray-500 mb-1 flex items-center gap-1"><Filter className="w-2.5 h-2.5" />{label}</label>
      {children}
    </div>
  );
}

/** Geo-fence badge: ok (green) / outside (red) / unverifiable (amber, null). */
function GeoBadge({ geoFenceOk, distanceMeters }: { geoFenceOk: boolean | null; distanceMeters: number | null }) {
  const dist = distanceMeters != null
    ? (distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${Math.round(distanceMeters)} m`)
    : null;
  if (geoFenceOk === true) {
    return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-green-50 text-green-700 border border-green-200">In fence{dist ? ` · ${dist}` : ''}</span>;
  }
  if (geoFenceOk === false) {
    return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-600 border border-red-200">Outside{dist ? ` · ${dist}` : ''}</span>;
  }
  return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-200">Unverifiable</span>;
}

/** Per-photo fence badge (per-photo geotag): inside / outside / unverifiable. */
function PhotoFenceBadge({ status }: { status: PhotoFenceStatus }) {
  if (status === 'inside') {
    return <span className="px-1.5 py-0.5 rounded-full font-medium bg-green-50 text-green-700 border border-green-200">In fence</span>;
  }
  if (status === 'outside') {
    return <span className="px-1.5 py-0.5 rounded-full font-medium bg-red-50 text-red-600 border border-red-200">Outside</span>;
  }
  return <span className="px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-200">Unverifiable</span>;
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

function CaptureDrawer({
  captureId, onClose, onChanged,
}: { captureId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<VisibilityCaptureDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<VisibilityRejectReasonCode>('BLURRY');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await visibilityApi.getCapture(captureId);
    if (res.success) setDetail(res.data.capture);
    else setError(res.error);
    setLoading(false);
  }, [captureId]);

  useEffect(() => { void load(); }, [load]);

  const approve = async () => {
    setBusy(true);
    setActionError(null);
    const res = await visibilityApi.approveCapture(captureId);
    setBusy(false);
    if (res.success) { await load(); onChanged(); }
    else setActionError(res.error);
  };

  const submitReject = async () => {
    setBusy(true);
    setActionError(null);
    const res = await visibilityApi.rejectCapture(captureId, { reasonCode, reason: reason.trim() || undefined });
    setBusy(false);
    if (res.success) { setRejectOpen(false); setReason(''); await load(); onChanged(); }
    else setActionError(res.error);
  };

  const captured = (detail?.formValues ?? {}) as Record<string, unknown>;
  const specialIds = new Set<string>([...(detail?.media ?? []).map((m) => m.fieldId), ...(detail?.geo ?? []).map((g) => g.fieldId)]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} aria-hidden />
      <div className="w-full max-w-lg bg-white h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between z-10">
          <h2 className="text-sm font-bold text-gray-900">Capture review</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" /></div>
        ) : error || !detail ? (
          <div className="py-20 text-center"><p className="text-sm text-red-500">{error ?? 'Not found'}</p></div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Outlet + status */}
            <div>
              <div className="flex items-center justify-between">
                <p className="text-base font-bold text-gray-900">{detail.outletName || 'Outlet'}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[detail.status] ?? 'bg-gray-100 text-gray-600'}`}>{detail.status}</span>
              </div>
              <p className="text-xs text-gray-400 font-mono">{detail.outletCode}</p>
              <p className="text-xs text-gray-500 mt-1">
                Window <span className="font-mono">{detail.windowKey}</span> · v{detail.currentVersion}
                {detail.receivedAt ? ` · ${new Date(detail.receivedAt).toLocaleString('en-IN')}` : ''}
              </p>
              {detail.status === 'REJECTED' && (detail.rejectionReason || detail.rejectionReasonCode) && (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-600">
                  <strong>Rejected:</strong> {detail.rejectionReasonCode ? (VISIBILITY_REJECT_REASON_LABELS[detail.rejectionReasonCode as VisibilityRejectReasonCode] ?? detail.rejectionReasonCode) : ''}{detail.rejectionReason ? ` — ${detail.rejectionReason}` : ''}
                </div>
              )}
            </div>

            {/* Geo-fence */}
            <Section title="Geo-fence">
              <div className="flex items-center gap-2 mb-2">
                <GeoBadge geoFenceOk={detail.geoFence.geoFenceOk} distanceMeters={detail.geoFence.distanceMeters} />
                {detail.geoFence.captureAccuracy != null && <span className="text-[11px] text-gray-500">±{Math.round(detail.geoFence.captureAccuracy)} m accuracy</span>}
              </div>
              {detail.geo.map((g) => (
                <GeoPin key={g.fieldId} geo={g} distanceMeters={detail.geoFence.distanceMeters} />
              ))}
              {detail.geo.length === 0 && detail.geoFence.captureLat != null && detail.geoFence.captureLng != null && (
                <GeoPin geo={{ fieldId: 'submit', label: 'Capture location', value: { lat: detail.geoFence.captureLat, lng: detail.geoFence.captureLng, accuracy: detail.geoFence.captureAccuracy ?? undefined } }} distanceMeters={detail.geoFence.distanceMeters} />
              )}
            </Section>

            {/* Media */}
            {detail.media.length > 0 && (
              <Section title={`Photos (${detail.media.length})`}>
                <div className="grid grid-cols-2 gap-2">
                  {detail.media.map((m) => {
                    const href = rewriteMediaViewPath(m.viewPath);
                    return (
                      <a key={m.fieldId + m.key} href={href} target="_blank" rel="noopener noreferrer"
                        className="border border-gray-200 rounded-lg overflow-hidden hover:border-[var(--brand-primary)] transition-colors group">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={href} alt={m.label} className="w-full h-24 object-cover bg-gray-50" />
                        <div className="px-2 py-1.5 flex items-center gap-1 text-[10px] text-gray-600">
                          <ImageIcon className="w-3 h-3" />
                          <span className="truncate flex-1">{m.label}</span>
                          <ExternalLink className="w-3 h-3 text-gray-300 group-hover:text-[var(--brand-primary)]" />
                        </div>
                        {/* Per-photo geotag: this photo's own GPS + its fence status (in
                            addition to the aggregate geo-fence badge above). Absent for a
                            legacy bare-string photo (no geo, no per-photo status). */}
                        {(m.geo || m.fenceStatus) && (
                          <div className="px-2 pb-1.5 flex items-center justify-between gap-1 text-[10px]">
                            {m.geo ? (
                              <span className="inline-flex items-center gap-0.5 text-gray-500">
                                <MapPin className="w-2.5 h-2.5" />
                                {m.geo.lat.toFixed(5)}, {m.geo.lng.toFixed(5)}
                              </span>
                            ) : (
                              <span />
                            )}
                            {m.fenceStatus && <PhotoFenceBadge status={m.fenceStatus} />}
                          </div>
                        )}
                      </a>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* Duplicate photo matches */}
            {detail.duplicateMatches.length > 0 && (
              <Section title={`Duplicate photo matches (${detail.duplicateMatches.length})`}>
                <div className="space-y-1.5">
                  {detail.duplicateMatches.map((d) => (
                    <div key={d.captureId + d.hash} className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                      <Copy className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>Same photo also on outlet <strong className="font-mono">{d.outletCode}</strong> · window <strong className="font-mono">{d.windowKey}</strong></span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Captured values */}
            <Section title="Captured values">
              {Object.keys(captured).filter((k) => !specialIds.has(k)).length === 0 ? (
                <p className="text-xs text-gray-400">No text values captured.</p>
              ) : (
                <dl className="space-y-1.5">
                  {Object.entries(captured).filter(([k]) => !specialIds.has(k)).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 text-xs">
                      <dt className="text-gray-500 font-mono truncate">{k}</dt>
                      <dd className="text-gray-800 font-medium text-right break-words">{formatValue(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Section>

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
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {actionError && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{actionError}</p>}

            {/* Actions */}
            {detail.status !== 'APPROVED' && (
              <div className="border-t border-gray-100 pt-4 space-y-3">
                {rejectOpen ? (
                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-gray-700">Rejection reason</label>
                    <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as VisibilityRejectReasonCode)}
                      aria-label="Rejection reason code"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400">
                      {VISIBILITY_REJECT_REASON_CODES.map((c) => (
                        <option key={c} value={c}>{VISIBILITY_REJECT_REASON_LABELS[c]}</option>
                      ))}
                    </select>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                      placeholder="Optional detail — the rep re-captures for this window (D11)."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none" />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => { setRejectOpen(false); setActionError(null); }} className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50">Cancel</button>
                      <button onClick={submitReject} disabled={busy}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-60">
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />} Reject capture
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={approve} disabled={busy}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-60">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve
                    </button>
                    <button onClick={() => setRejectOpen(true)} disabled={busy}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 border border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors disabled:opacity-60">
                      <XCircle className="w-4 h-4" /> Reject
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
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

// ── Geo pin (captured point + server distance) ────────────────────────────────

function isGps(v: unknown): v is { lat: number; lng: number; accuracy?: number } {
  return !!v && typeof v === 'object' && typeof (v as { lat: unknown }).lat === 'number' && typeof (v as { lng: unknown }).lng === 'number';
}

function GeoPin({ geo, distanceMeters }: { geo: VisibilityGeoRef; distanceMeters: number | null }) {
  if (!isGps(geo.value)) return <p className="text-xs text-gray-400">{geo.label}: no fix captured.</p>;
  const cap = geo.value;
  const osm = `https://www.openstreetmap.org/?mlat=${cap.lat}&mlon=${cap.lng}#map=17/${cap.lat}/${cap.lng}`;
  const dist = distanceMeters != null
    ? (distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${Math.round(distanceMeters)} m`)
    : null;
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700 flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-green-500" />{geo.label}</span>
        <a href={osm} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[var(--brand-primary)] hover:underline flex items-center gap-0.5">Map <ExternalLink className="w-2.5 h-2.5" /></a>
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-600 space-y-0.5">
        <p><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1" />Captured: {cap.lat.toFixed(6)}, {cap.lng.toFixed(6)}{cap.accuracy != null ? ` (±${Math.round(cap.accuracy)}m)` : ''}</p>
        {dist != null && <p className="text-gray-500">{dist} from the outlet&apos;s registered location</p>}
      </div>
    </div>
  );
}

export default VisibilityCaptureQueue;
