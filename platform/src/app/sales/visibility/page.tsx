'use client';

/**
 * Sales Visibility (POSM) — the rep's current-window capture list
 * (VISIBILITY-POSM-DESIGN.md §5 / D8 / D14). Replaces the old view-only "My
 * Submissions" page (which read a dead `/api/visibility/submissions` and had a
 * no-op Submit button).
 *
 * PHOTO_APPROVAL mode: lists the rep's in-scope downline outlets for the CURRENT
 * window from `visibilityApi.getSalesEligible` — each row shows its window state
 * (due / awaiting / approved / rejected / late). An outlet the rep may capture
 * (`canCapture`, D8) that is not yet satisfied (due / rejected / late) gets a
 * "Capture" affordance opening `VisibilityCaptureSheet`; everything else is
 * read-only status. `?outletId=` opens the sheet preselected (deep-link from the
 * Tasks group + the outlet-view card).
 *
 * AMOUNT_UPLOAD mode: reps do not capture in-app (visibility is recorded via the
 * back-office Excel path), so the page shows a read-only note instead of a list.
 */

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import Link from '@/components/navigation/no-prefetch-link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Camera, CheckCircle, Clock, Eye, AlertTriangle, XCircle, Loader2, Search, Image as ImageIcon,
} from 'lucide-react';
import { SalesCapturePhotosSheet } from '@/components/visibility/SalesPhotoViewer';
import { visibilityApi } from '@/lib/visibility';
import {
  isResubmitCapture,
  isChangesRequested,
  CAPTURE_UI_STATE_LABELS,
  actionableStateLabel,
  type CaptureUiState, type SalesEligibleOutlet, type SalesEligibleResponse,
} from '@/lib/visibility-types';
import { useGifsySettings, useGifsySettingsReady } from '@/lib/gifsy-settings';
import { VisibilityCaptureSheet } from './VisibilityCaptureSheet';

/* ─── Window-state presentation ──────────────────────────────────────────────── */

const STATE_CONFIG: Record<
  CaptureUiState,
  { label: string; badge: string; icon: React.ReactNode }
> = {
  // Labels = the shared plain status words (CAPTURE_UI_STATE_LABELS) — never re-typed here.
  due:      { label: CAPTURE_UI_STATE_LABELS.due,      badge: 'bg-amber-50 text-amber-700 border-amber-200',
             icon: <Clock className="h-3.5 w-3.5 text-amber-500" /> },
  awaiting: { label: CAPTURE_UI_STATE_LABELS.awaiting, badge: 'bg-blue-50 text-blue-700 border-blue-200',
             icon: <Eye className="h-3.5 w-3.5 text-blue-500" /> },
  approved: { label: CAPTURE_UI_STATE_LABELS.approved, badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
             icon: <CheckCircle className="h-3.5 w-3.5 text-emerald-500" /> },
  rejected: { label: CAPTURE_UI_STATE_LABELS.rejected, badge: 'bg-red-50 text-red-700 border-red-200',
             icon: <XCircle className="h-3.5 w-3.5 text-red-500" /> },
  changes_requested: { label: CAPTURE_UI_STATE_LABELS.changes_requested, badge: 'bg-orange-50 text-orange-700 border-orange-200',
             icon: <AlertTriangle className="h-3.5 w-3.5 text-orange-500" /> },
  late:     { label: CAPTURE_UI_STATE_LABELS.late,     badge: 'bg-orange-50 text-orange-700 border-orange-200',
             icon: <AlertTriangle className="h-3.5 w-3.5 text-orange-500" /> },
};

/** An outlet is capturable now when the rep may capture (D8) and the window is unsatisfied. */
function isActionable(state: CaptureUiState, canCapture: boolean): boolean {
  return canCapture && (state === 'due' || state === 'rejected' || state === 'changes_requested' || state === 'late');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1–15 Jul '26" label for a windowKey (YYYY-MM-Pn) + its day bounds. */
function windowLabel(windowKey: string, window: { startDay: number; endDay: number }): string {
  const m = /^(\d{4})-(\d{2})-P\d+$/.exec(windowKey);
  if (!m) return `Day ${window.startDay}–${window.endDay}`;
  const year = m[1].slice(2);
  const abbr = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${window.startDay}–${window.endDay} ${abbr} '${year}`;
}

/* ─── Photo chips (sales photo view only) ────────────────────────────────────── */

type PhotoChip = 'all' | 'waiting' | 'approved' | 'retake';

const PHOTO_CHIPS: { key: PhotoChip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'retake', label: 'Needs re-take' },
];

/** Which photo chip a row falls in (null = no capture yet → only under "All"). */
function photoBucketOf(state: CaptureUiState, status: string | null): Exclude<PhotoChip, 'all'> | null {
  if (state === 'awaiting') return 'waiting';
  if (state === 'approved') return 'approved';
  if (state === 'rejected' || state === 'changes_requested') return 'retake';
  // A closed window keeps its capture's status.
  if (status === 'SUBMITTED') return 'waiting';
  if (status === 'APPROVED') return 'approved';
  if (status === 'REJECTED' || status === 'CHANGES_REQUESTED') return 'retake';
  return null;
}

/* ─── Filter pill (shared select styling, matches the Outlets filter strip) ────── */

function FilterPill({
  value, onChange, active, children, widthClass,
}: {
  value: string;
  onChange: (v: string) => void;
  active: boolean;
  children: React.ReactNode;
  /** Optional max-width cap so a long member/program name can't blow out the filter row. */
  widthClass?: string;
}) {
  return (
    <div className={`relative shrink-0 ${widthClass ?? ''}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none max-w-full truncate text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1.5 bg-white focus:outline-none transition-colors cursor-pointer ${
          active ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'
        }`}
      >
        {children}
      </select>
      <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${active ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

/* ─── Content ────────────────────────────────────────────────────────────────── */

function SalesVisibilityContent() {
  const settings = useGifsySettings();
  // false only while hydrating (settings = SSR defaults) — see useGifsySettingsReady.
  const settingsReady = useGifsySettingsReady();
  const captureMode = settings.visibilityCaptureMode ?? 'PHOTO_APPROVAL';
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectId = searchParams.get('outletId');

  const [eligible, setEligible] = useState<SalesEligibleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Filters (mirroring the KYC-submissions list): status · program · team member.
  const [statusFilter, setStatusFilter] = useState<CaptureUiState | 'ALL'>('ALL');
  const [programFilter, setProgramFilter] = useState<string>('ALL');
  // Team Member filter — a manager's direct report (value = member id; '' = all team).
  const [memberFilter, setMemberFilter] = useState<string>('');
  // Session read-back of a fresh capture — outletId → its new window state.
  const [captured, setCaptured] = useState<Record<string, CaptureUiState>>({});
  const [activeOutletId, setActiveOutletId] = useState<string | null>(null);
  // Sales photo view: quick photo-status chip + the outlet whose photos are open (loaded on demand).
  const [photoChip, setPhotoChip] = useState<PhotoChip>('all');
  const [photosFor, setPhotosFor] = useState<{ captureId: string; outletName: string } | null>(null);

  const isPhotoMode = settings.visibilityEnabled === true && captureMode === 'PHOTO_APPROVAL';

  useEffect(() => {
    // Never decide on the SSR-default settings (Visibility OFF) — wait for the client cache.
    if (!settingsReady) return;
    if (!isPhotoMode) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    visibilityApi
      .getSalesEligible()
      .then((r) => {
        if (cancelled) return;
        if (r.success) setEligible(r.data);
        else setError(r.error);
      })
      .catch(() => { if (!cancelled) setError('Failed to load visibility outlets.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isPhotoMode, settingsReady]);

  // Sales photo view: after a capture, quietly re-read the list so the new capture's id (→ its Photos button) shows.
  // No spinner, and a failed re-read keeps the current list. Photo-view tenants only — everyone else is unchanged.
  const refreshQuietly = () => {
    visibilityApi
      .getSalesEligible()
      .then((r) => { if (r.success) setEligible(r.data); })
      .catch(() => { /* keep the list on screen */ });
  };

  // Effective state — a fresh session capture overrides the server row; otherwise a
  // per-photo CHANGES_REQUESTED capture maps to the 'changes_requested' label (robust to
  // either backend windowState mapping, via the capture status).
  const stateOf = (o: SalesEligibleOutlet): CaptureUiState =>
    captured[o.outletId] ?? (isChangesRequested(o) ? 'changes_requested' : o.windowState);

  // Manager-only Team Member filter options (empty for a leaf rep → the filter is hidden).
  const members = eligible?.members ?? [];
  // The selected member's whole branch (self + downline) as a Set of login-User ids. An outlet
  // matches when its assignedUserId is in this set — SAME sub-tree semantics as the Outlets
  // screen's member filter.
  const selectedMemberUserIds = useMemo(
    () => (memberFilter ? new Set(members.find((m) => m.id === memberFilter)?.submitterUserIds ?? []) : null),
    [memberFilter, members],
  );

  // Filter option lists, derived from the loaded outlets.
  const programOptions = useMemo(
    () => Array.from(new Set((eligible?.outlets ?? []).map((o) => o.programName).filter((p): p is string => !!p))).sort(),
    [eligible],
  );
  const statusOptions = useMemo(() => {
    const present = new Set<CaptureUiState>();
    for (const o of eligible?.outlets ?? []) present.add(stateOf(o));
    // Fixed display order (action-needed states first).
    return (['due', 'changes_requested', 'rejected', 'late', 'awaiting', 'approved'] as CaptureUiState[])
      .filter((s) => present.has(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, captured]);

  const anyFilter =
    search.trim() !== '' || statusFilter !== 'ALL' || programFilter !== 'ALL' || memberFilter !== '' || photoChip !== 'all';

  // If the selected status leaves the option set (e.g. the last outlet of that status was just
  // captured), fall back to "All" so the list doesn't get stuck on an empty, blank-select state.
  useEffect(() => {
    if (statusFilter !== 'ALL' && !statusOptions.includes(statusFilter)) setStatusFilter('ALL');
  }, [statusOptions, statusFilter]);

  // Sales photo view (tenant-scoped): the backend flags it only when this tenant lets the caller's level see photos.
  const photoView = eligible?.photoView === true;

  // Rows after search / status / program / member — the photo chips filter (and count) on top of these.
  const filteredRows = useMemo(() => {
    const list = eligible?.outlets ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((o) => {
      if (q && !(o.outletName.toLowerCase().includes(q) || o.outletCode.toLowerCase().includes(q))) return false;
      if (statusFilter !== 'ALL' && stateOf(o) !== statusFilter) return false;
      if (programFilter !== 'ALL' && o.programName !== programFilter) return false;
      // Team Member: match an outlet whose assigned rep (assignedUserId) is in the selected
      // member's sub-tree (mirrors the Outlets-screen member filter).
      if (selectedMemberUserIds && !(o.assignedUserId && selectedMemberUserIds.has(o.assignedUserId))) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, search, captured, statusFilter, programFilter, selectedMemberUserIds]);

  // Photo chips (All / Waiting / Approved / Needs re-take) with counts over the rows above — photo view only.
  const chipCounts = useMemo(() => {
    const c: Record<PhotoChip, number> = { all: filteredRows.length, waiting: 0, approved: 0, retake: 0 };
    for (const o of filteredRows) {
      const b = photoBucketOf(stateOf(o), o.status ?? null);
      if (b) c[b]++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows]);

  // The selected chip lost its last outlet (e.g. it was just captured, or another filter narrowed it) → back to All,
  // the same rule as the status filter, so the list never sticks on an empty chip.
  useEffect(() => {
    if (photoChip !== 'all' && chipCounts[photoChip] === 0) setPhotoChip('all');
  }, [photoChip, chipCounts]);

  const outlets = useMemo(() => {
    const rows = photoView && photoChip !== 'all'
      ? filteredRows.filter((o) => photoBucketOf(stateOf(o), o.status ?? null) === photoChip)
      : filteredRows;
    const actionRank = (o: SalesEligibleOutlet) =>
      Number(isActionable(captured[o.outletId] ?? o.windowState, o.canCapture));
    return [...rows].sort((a, b) => {
      // Actionable (due/rejected/late & canCapture) first, then by name.
      const d = actionRank(b) - actionRank(a);
      return d !== 0 ? d : a.outletName.localeCompare(b.outletName);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, photoView, photoChip, captured]);

  const dueCount = useMemo(
    () =>
      (eligible?.outlets ?? []).filter((o) =>
        isActionable(captured[o.outletId] ?? o.windowState, o.canCapture),
      ).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligible, captured],
  );

  // Open the sheet preselected when arriving with ?outletId= (once eligible loads).
  useEffect(() => {
    if (!preselectId || !eligible) return;
    const target = eligible.outlets.find((o) => o.outletId === preselectId);
    if (target && isActionable(captured[target.outletId] ?? target.windowState, target.canCapture)) {
      setActiveOutletId(preselectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectId, eligible]);

  const activeOutlet = eligible?.outlets.find((o) => o.outletId === activeOutletId) ?? null;

  const header = (
    <div className="flex items-center gap-3 mb-5">
      <Link href="/sales/dashboard" className="p-2 -ml-2 rounded-xl hover:bg-gray-100 transition-colors text-gray-500">
        <ArrowLeft className="h-5 w-5" />
      </Link>
      <div className="flex-1">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Camera className="h-5 w-5 text-[var(--brand-primary)]" /> Visibility
        </h1>
        <p className="text-xs text-gray-400 mt-0.5">POSM photo capture</p>
      </div>
      {isPhotoMode && dueCount > 0 && (
        <span
          data-testid="visibility-due-badge"
          className="text-[11px] font-bold bg-[var(--brand-primary)] text-white px-2 py-1 rounded-full"
        >
          {dueCount} due
        </span>
      )}
    </div>
  );

  // Settings not applied yet (hydration render) → neutral skeleton, never the "not enabled" panel.
  if (!settingsReady) {
    return (
      <div className="fade-in">
        {header}
        <div className="min-h-40 rounded-xl bg-gray-100 animate-pulse" data-testid="visibility-settings-loading" aria-busy="true" />
      </div>
    );
  }

  // Master switch OFF → whole surface hidden.
  if (settings.visibilityEnabled !== true) {
    return (
      <div className="fade-in">
        {header}
        <div className="flex items-center justify-center min-h-40">
          <p className="text-sm text-gray-500 text-center px-6">
            Visibility is not enabled for your organization.
          </p>
        </div>
      </div>
    );
  }

  // AMOUNT_UPLOAD tenants: reps don't capture in-app.
  if (!isPhotoMode) {
    return (
      <div className="fade-in">
        {header}
        <div className="flex flex-col items-center gap-2 py-12 text-center text-gray-500 bg-white rounded-2xl border border-gray-100">
          <Eye className="h-8 w-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-600">Visibility is tracked off-app</p>
          <p className="text-xs text-gray-400 max-w-xs">
            Your organization records visibility via the back-office upload — there is nothing to capture here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {header}

      {/* Current window banner */}
      {eligible && (
        <div className="mb-4 flex items-center gap-2 bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/15 rounded-xl px-4 py-3">
          <Clock className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-gray-800">
              Current window · {windowLabel(eligible.windowKey, eligible.window)}
            </p>
            {!eligible.levelAllowed && (
              <p className="text-[11px] text-amber-600 mt-0.5">
                Your role can view status but is not permitted to capture.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Search */}
      {(eligible?.outlets.length ?? 0) > 0 && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search outlets by name or code…"
            className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white"
            autoComplete="off"
          />
        </div>
      )}

      {/* Filter strip — status · team member · program (mirrors the KYC list). Wraps so every
          filter stays visible (no hidden horizontal scroll); long names are width-capped. */}
      {(eligible?.outlets.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <FilterPill value={statusFilter} onChange={(v) => setStatusFilter(v as CaptureUiState | 'ALL')} active={statusFilter !== 'ALL'}>
            <option value="ALL">All statuses</option>
            {statusOptions.map((s) => <option key={s} value={s}>{STATE_CONFIG[s].label}</option>)}
          </FilterPill>
          {/* Team Member — managers only (a direct downline present). A plain rep gets no
              members → not rendered. Same gate + sub-tree semantics as the Outlets screen. */}
          {members.length > 0 && (
            <FilterPill value={memberFilter} onChange={setMemberFilter} active={memberFilter !== ''} widthClass="max-w-[180px]">
              <option value="">All team</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </FilterPill>
          )}
          {programOptions.length > 1 && (
            <FilterPill value={programFilter} onChange={setProgramFilter} active={programFilter !== 'ALL'} widthClass="max-w-[180px]">
              <option value="ALL">All programs</option>
              {programOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </FilterPill>
          )}
        </div>
      )}

      {/* Photo chips — sales photo view only (tenant lets this level see team photos). Counts follow the filters above. */}
      {photoView && (eligible?.outlets.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4" role="group" aria-label="Outlets by photo status" data-testid="photo-chips">
          {PHOTO_CHIPS.map((c) => {
            const on = photoChip === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                data-testid={`photo-chip-${c.key}`}
                onClick={() => setPhotoChip(c.key)}
                className={`text-[11px] font-semibold rounded-full px-3 py-1.5 border transition-colors ${
                  on ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)] text-white' : 'bg-white border-gray-200 text-gray-600'
                }`}
              >
                {c.label} ({chipCounts[c.key]})
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-12 text-red-500">
          <AlertTriangle className="h-8 w-8" />
          <p className="text-sm text-center px-6">{error}</p>
        </div>
      ) : outlets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
          <Eye className="h-8 w-8" />
          <p className="text-sm">
            {anyFilter ? 'No outlets match the selected filters' : 'No visibility outlets in your scope for this window'}
          </p>
          {anyFilter && (
            <button
              onClick={() => { setSearch(''); setStatusFilter('ALL'); setProgramFilter('ALL'); setMemberFilter(''); setPhotoChip('all'); }}
              className="text-xs text-[var(--brand-primary)] font-semibold hover:underline mt-1"
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm divide-y divide-gray-50">
          {outlets.map((o) => {
            const state = stateOf(o);
            const cfg = STATE_CONFIG[state];
            const actionable = isActionable(state, o.canCapture);
            const captureBtn = actionable ? (
              <button
                onClick={() => setActiveOutletId(o.outletId)}
                className="shrink-0 flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-xl bg-[var(--brand-primary)] text-white active:opacity-90 transition-opacity"
              >
                <Camera className="h-3.5 w-3.5" />
                {/* A rejected prior capture (incl. rejected-then-late) recaptures (M3). */}
                {isResubmitCapture(o) ? 'Recapture' : 'Capture'}
              </button>
            ) : null;
            const info = (
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900 truncate min-w-0 flex-1">{o.outletName}</p>
                  <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.badge}`}>
                    {actionableStateLabel(state, o.status ?? null, actionable)}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  {o.outletCode}{o.outletType ? ` · ${o.outletType.name}` : ''}
                </p>
                {state === 'rejected' && o.rejectionReason && (
                  <p className="text-[11px] text-red-500 mt-0.5 truncate">{o.rejectionReason}</p>
                )}
                {state === 'changes_requested' && (
                  <p className="text-[11px] text-orange-600 mt-0.5 truncate">
                    Some photos flagged — re-capture required{o.rejectionReason ? `: ${o.rejectionReason}` : ''}
                  </p>
                )}
              </div>
            );
            // Sales photo view: the action buttons get their OWN line under the name / badge on a phone (below `sm`),
            // so Recapture + Photos never squeeze the name or overlap the badge at 360 px; side by side from `sm` up.
            // The caller's own capture (level not listed, A3) also gets View photos — for that capture only.
            if (photoView || o.ownCapture) {
              return (
                <div key={o.outletId} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-3.5" data-testid={`vis-row-${o.outletId}`}>
                  <div className="p-2.5 bg-gray-50 rounded-xl shrink-0">{cfg.icon}</div>
                  {info}
                  {(captureBtn || o.captureId) && (
                    <div className="flex w-full sm:w-auto justify-end gap-2 sm:shrink-0" data-testid={`vis-row-actions-${o.outletId}`}>
                      {captureBtn}
                      {o.captureId ? (
                        <button
                          type="button"
                          data-testid={`view-photos-${o.outletId}`}
                          onClick={() => setPhotosFor({ captureId: o.captureId as string, outletName: o.outletName })}
                          aria-label={`View photos: ${o.outletName}`}
                          className="shrink-0 flex items-center gap-1 text-[12px] font-semibold px-3 py-1.5 min-h-[36px] rounded-xl border border-gray-200 text-gray-700 active:bg-gray-50"
                        >
                          <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          View photos
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={o.outletId} className="flex items-center gap-3 px-4 py-3.5">
                <div className="p-2.5 bg-gray-50 rounded-xl shrink-0">{cfg.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate min-w-0 flex-1">{o.outletName}</p>
                    <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.badge}`}>
                      {actionableStateLabel(state, o.status ?? null, actionable)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {o.outletCode}{o.outletType ? ` · ${o.outletType.name}` : ''}
                  </p>
                  {state === 'rejected' && o.rejectionReason && (
                    <p className="text-[11px] text-red-500 mt-0.5 truncate">{o.rejectionReason}</p>
                  )}
                  {state === 'changes_requested' && (
                    <p className="text-[11px] text-orange-600 mt-0.5 truncate">
                      Some photos flagged — re-capture required{o.rejectionReason ? `: ${o.rejectionReason}` : ''}
                    </p>
                  )}
                </div>
                {actionable ? (
                  <button
                    onClick={() => setActiveOutletId(o.outletId)}
                    className="shrink-0 flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-xl bg-[var(--brand-primary)] text-white active:opacity-90 transition-opacity"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {/* A rejected prior capture (incl. rejected-then-late) recaptures (M3). */}
                    {isResubmitCapture(o) ? 'Recapture' : 'Capture'}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {photosFor && (
        <SalesCapturePhotosSheet
          captureId={photosFor.captureId}
          outletName={photosFor.outletName}
          onClose={() => setPhotosFor(null)}
        />
      )}

      {activeOutlet && (
        <VisibilityCaptureSheet
          outlet={activeOutlet}
          onCaptured={(outletId, next) => {
            setCaptured((prev) => ({ ...prev, [outletId]: next }));
            if (photoView) refreshQuietly();
          }}
          onClose={() => {
            // When this sheet was opened via the outlet-detail deep-link (?outletId=), return the
            // rep to that OUTLET DETAIL on close (after capture OR dismiss) instead of dropping them
            // onto the visibility LIST — they came FROM the outlet screen. A list-initiated capture
            // (activeOutletId set by a list tap, so != preselectId) closes back to the list as before.
            const returnOutletId = activeOutletId;
            setActiveOutletId(null);
            if (returnOutletId && returnOutletId === preselectId) {
              router.push(`/sales/kyc/${returnOutletId}`);
            }
          }}
        />
      )}
    </div>
  );
}

export default function SalesVisibilityPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
        </div>
      }
    >
      <SalesVisibilityContent />
    </Suspense>
  );
}
