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
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Camera, CheckCircle, Clock, Eye, AlertTriangle, XCircle, Loader2, Search,
} from 'lucide-react';
import { visibilityApi } from '@/lib/visibility';
import {
  isResubmitCapture,
  type CaptureUiState, type SalesEligibleOutlet, type SalesEligibleResponse,
} from '@/lib/visibility-types';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { VisibilityCaptureSheet } from './VisibilityCaptureSheet';

/* ─── Window-state presentation ──────────────────────────────────────────────── */

const STATE_CONFIG: Record<
  CaptureUiState,
  { label: string; badge: string; icon: React.ReactNode }
> = {
  due:      { label: 'Due',       badge: 'bg-amber-50 text-amber-700 border-amber-200',
             icon: <Clock className="h-3.5 w-3.5 text-amber-500" /> },
  awaiting: { label: 'In review', badge: 'bg-blue-50 text-blue-700 border-blue-200',
             icon: <Eye className="h-3.5 w-3.5 text-blue-500" /> },
  approved: { label: 'Approved',  badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
             icon: <CheckCircle className="h-3.5 w-3.5 text-emerald-500" /> },
  rejected: { label: 'Rejected',  badge: 'bg-red-50 text-red-700 border-red-200',
             icon: <XCircle className="h-3.5 w-3.5 text-red-500" /> },
  late:     { label: 'Overdue',   badge: 'bg-orange-50 text-orange-700 border-orange-200',
             icon: <AlertTriangle className="h-3.5 w-3.5 text-orange-500" /> },
};

/** An outlet is capturable now when the rep may capture (D8) and the window is unsatisfied. */
function isActionable(state: CaptureUiState, canCapture: boolean): boolean {
  return canCapture && (state === 'due' || state === 'rejected' || state === 'late');
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

/* ─── Content ────────────────────────────────────────────────────────────────── */

function SalesVisibilityContent() {
  const settings = useGifsySettings();
  const captureMode = settings.visibilityCaptureMode ?? 'PHOTO_APPROVAL';
  const searchParams = useSearchParams();
  const preselectId = searchParams.get('outletId');

  const [eligible, setEligible] = useState<SalesEligibleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Session read-back of a fresh capture — outletId → its new window state.
  const [captured, setCaptured] = useState<Record<string, CaptureUiState>>({});
  const [activeOutletId, setActiveOutletId] = useState<string | null>(null);

  const isPhotoMode = settings.visibilityEnabled === true && captureMode === 'PHOTO_APPROVAL';

  useEffect(() => {
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
  }, [isPhotoMode]);

  // Effective state — a fresh session capture overrides the server row.
  const stateOf = (o: SalesEligibleOutlet): CaptureUiState => captured[o.outletId] ?? o.windowState;

  const outlets = useMemo(() => {
    const list = eligible?.outlets ?? [];
    const q = search.trim().toLowerCase();
    const rows = q
      ? list.filter(
          (o) => o.outletName.toLowerCase().includes(q) || o.outletCode.toLowerCase().includes(q),
        )
      : list;
    // Actionable (due/rejected/late & canCapture) first, then the rest.
    return [...rows].sort(
      (a, b) =>
        Number(isActionable(captured[b.outletId] ?? b.windowState, b.canCapture)) -
        Number(isActionable(captured[a.outletId] ?? a.windowState, a.canCapture)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, search, captured]);

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
            {search ? 'No outlets match that search' : 'No visibility outlets in your scope for this window'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm divide-y divide-gray-50">
          {outlets.map((o) => {
            const state = stateOf(o);
            const cfg = STATE_CONFIG[state];
            const actionable = isActionable(state, o.canCapture);
            return (
              <div key={o.outletId} className="flex items-center gap-3 px-4 py-3.5">
                <div className="p-2.5 bg-gray-50 rounded-xl shrink-0">{cfg.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate min-w-0 flex-1">{o.outletName}</p>
                    <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.badge}`}>
                      {cfg.label}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {o.outletCode}{o.outletType ? ` · ${o.outletType.name}` : ''}
                  </p>
                  {state === 'rejected' && o.rejectionReason && (
                    <p className="text-[11px] text-red-500 mt-0.5 truncate">{o.rejectionReason}</p>
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

      {activeOutlet && (
        <VisibilityCaptureSheet
          outlet={activeOutlet}
          onCaptured={(outletId, next) => setCaptured((prev) => ({ ...prev, [outletId]: next }))}
          onClose={() => setActiveOutletId(null)}
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
