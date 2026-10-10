'use client';

/**
 * Admin Contests management page (Employee Rewards — Phase C).
 *
 * Contests are EMPLOYEE_REWARDS-tenant-only; the backend rejects trade tenants and
 * this route only appears in the EMPLOYEE admin nav tree (lib/admin-nav.ts).
 *
 * All admin routes under /api/admin/contests (proxied to /v1/admin/contests). Auth
 * is the httpOnly cookie carried by same-origin fetch — no token handling here. The
 * central `api` client ({success,data}) is used for every call; result.success is
 * checked on each.
 *
 *   GET    /api/admin/contests?status=&page=&limit=  → { contests, pagination }
 *   GET    /api/admin/contests/:id                   → Contest
 *   POST   /api/admin/contests                       → Contest (DRAFT)
 *   PATCH  /api/admin/contests/:id                   → Contest (only while DRAFT/SCHEDULED)
 *   POST   /api/admin/contests/:id/status  {status}  → Contest
 *   POST   /api/admin/contests/:id/cancel            → Contest
 *   POST   /api/admin/contests/:id/credit-bonus      → credit result  (MONEY-ADJACENT)
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Trophy, Plus, Edit2, X, XCircle, AlertCircle, RefreshCw, Gift, Calendar,
  Users, MapPin, ChevronLeft, ChevronRight, Ban, Coins, CheckCircle2, Info,
} from 'lucide-react';
import { api } from '@/lib/api-client';

/* ─── Backend shapes ─────────────────────────────────────────────────────────── */

type ContestStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'CREDITED' | 'CANCELLED';

interface Contest {
  id: string;
  name: string;
  bannerUrl: string | null;
  description: string | null;
  startDate: string;
  endDate: string;
  eligibleRoleCodes: string[];
  eligibleRegions: string[];
  bonusPoints: number;
  status: ContestStatus;
  bonusCreditedAt: string | null;
  bonusCreditedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Pagination { page: number; limit: number; total: number; pages: number }

interface ContestListResponse { contests: Contest[]; pagination: Pagination }

interface CreditBonusResult {
  creditedCount: number;
  pointsCreditedTotal: number;
  skipped: { employeeCode: string; reason: string }[];
  credited: boolean;
}

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const STATUS_BADGE: Record<ContestStatus, string> = {
  DRAFT:     'bg-amber-50 text-amber-600 border-amber-100',
  SCHEDULED: 'bg-blue-50 text-blue-700 border-blue-100',
  ACTIVE:    'bg-green-50 text-green-700 border-green-100',
  ENDED:     'bg-indigo-50 text-indigo-700 border-indigo-100',
  CREDITED:  'bg-emerald-50 text-emerald-700 border-emerald-100',
  CANCELLED: 'bg-gray-50 text-gray-500 border-gray-200',
};

/** Allowed next-status transitions, mirroring the backend edge-map exactly. */
const NEXT_STATUS: Record<ContestStatus, ContestStatus[]> = {
  DRAFT:     ['SCHEDULED', 'ACTIVE'],
  SCHEDULED: ['ACTIVE', 'DRAFT'],
  ACTIVE:    ['ENDED'],
  ENDED:     ['ACTIVE'],
  CREDITED:  [],
  CANCELLED: [],
};

/** Cancel is allowed only for these statuses. */
const CANCELLABLE = new Set<ContestStatus>(['DRAFT', 'SCHEDULED', 'ACTIVE']);

/** Edit (PATCH) is allowed only while the contest is DRAFT or SCHEDULED. */
function canEdit(status: ContestStatus): boolean {
  return status === 'DRAFT' || status === 'SCHEDULED';
}

/** Credit-bonus is enabled only when ACTIVE/ENDED, not yet credited, and points > 0. */
function canCreditBonus(c: Contest): boolean {
  return (c.status === 'ACTIVE' || c.status === 'ENDED')
    && c.bonusCreditedAt == null
    && c.bonusPoints > 0;
}

const STATUS_FILTERS: ('all' | ContestStatus)[] = [
  'all', 'DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CREDITED', 'CANCELLED',
];

const PAGE_LIMIT = 20;

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function fmtPts(n: number) { return n.toLocaleString('en-IN'); }

/** ISO string → value for a <input type="datetime-local"> (local time, no seconds). */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value → ISO string (throws-safe; '' when invalid). */
function fromDatetimeLocal(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Comma/newline-separated text → deduped, trimmed string[] (empty tokens dropped). */
function parseCsvList(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter((s) => s.length > 0)));
}

function joinCsvList(list?: string[] | null): string {
  return Array.isArray(list) ? list.join(', ') : '';
}

/* ════════════════════════════════════════════════════════════════════════════
   Create / Edit modal
   ════════════════════════════════════════════════════════════════════════════ */

interface ContestFormState {
  name: string;
  bannerUrl: string;
  description: string;
  startDate: string;        // datetime-local value
  endDate: string;          // datetime-local value
  eligibleRoleCodes: string;
  eligibleRegions: string;
  bonusPoints: string;      // numeric text
}

function blankForm(): ContestFormState {
  return {
    name: '', bannerUrl: '', description: '',
    startDate: '', endDate: '',
    eligibleRoleCodes: '', eligibleRegions: '', bonusPoints: '0',
  };
}

function ContestModal({
  editing, onSave, onClose, saving, serverError,
}: {
  editing: Contest | null;
  onSave: (payload: Record<string, unknown>) => void;
  onClose: () => void;
  saving: boolean;
  serverError: string;
}) {
  const [form, setForm] = useState<ContestFormState>(() =>
    editing
      ? {
          name: editing.name,
          bannerUrl: editing.bannerUrl ?? '',
          description: editing.description ?? '',
          startDate: toDatetimeLocal(editing.startDate),
          endDate: toDatetimeLocal(editing.endDate),
          eligibleRoleCodes: joinCsvList(editing.eligibleRoleCodes),
          eligibleRegions: joinCsvList(editing.eligibleRegions),
          bonusPoints: String(editing.bonusPoints ?? 0),
        }
      : blankForm(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof ContestFormState>(k: K, v: ContestFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Name is required';
    else if (form.name.trim().length > 200) e.name = 'Name must be ≤ 200 characters';
    if (form.bannerUrl.trim().length > 2048) e.bannerUrl = 'URL must be ≤ 2048 characters';
    if (form.description.trim().length > 4000) e.description = 'Description must be ≤ 4000 characters';
    if (!form.startDate) e.startDate = 'Start date is required';
    if (!form.endDate) e.endDate = 'End date is required';
    if (form.startDate && form.endDate) {
      const s = new Date(form.startDate).getTime();
      const en = new Date(form.endDate).getTime();
      if (!Number.isNaN(s) && !Number.isNaN(en) && en <= s) {
        e.endDate = 'End date must be after the start date';
      }
    }
    const pts = Number(form.bonusPoints);
    if (form.bonusPoints.trim() === '' || !Number.isInteger(pts) || pts < 0) {
      e.bonusPoints = 'Bonus points must be a whole number ≥ 0';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      bannerUrl: form.bannerUrl.trim() || null,
      description: form.description.trim() || null,
      startDate: fromDatetimeLocal(form.startDate),
      endDate: fromDatetimeLocal(form.endDate),
      eligibleRoleCodes: parseCsvList(form.eligibleRoleCodes),
      eligibleRegions: parseCsvList(form.eligibleRegions),
      bonusPoints: Number(form.bonusPoints),
    };
    onSave(payload);
  };

  const inputCls = (key: string) =>
    `w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
      errors[key] ? 'border-red-400' : 'border-gray-200'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-bold text-gray-900">
            {editing ? 'Edit Contest' : 'New Contest'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Name *</label>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Diwali Sales Dash"
              maxLength={200}
              className={inputCls('name')}
            />
            {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
          </div>

          {/* Banner URL */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Banner image URL</label>
            <input
              value={form.bannerUrl}
              onChange={(e) => set('bannerUrl', e.target.value)}
              placeholder="https://… (optional)"
              className={inputCls('bannerUrl')}
            />
            {errors.bannerUrl && <p className="text-xs text-red-500">{errors.bannerUrl}</p>}
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              maxLength={4000}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
            {errors.description && <p className="text-xs text-red-500">{errors.description}</p>}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Start date *</label>
              <input
                type="datetime-local"
                value={form.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                className={inputCls('startDate')}
              />
              {errors.startDate && <p className="text-xs text-red-500">{errors.startDate}</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">End date *</label>
              <input
                type="datetime-local"
                value={form.endDate}
                onChange={(e) => set('endDate', e.target.value)}
                className={inputCls('endDate')}
              />
              {errors.endDate && <p className="text-xs text-red-500">{errors.endDate}</p>}
            </div>
          </div>

          {/* Eligibility */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Eligible roles</label>
              <input
                value={form.eligibleRoleCodes}
                onChange={(e) => set('eligibleRoleCodes', e.target.value)}
                placeholder="Leave blank for All"
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              />
              <p className="text-[10px] text-gray-400">
                Comma-separated role codes. {form.eligibleRoleCodes.trim() ? '' : 'Empty = all roles.'}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Eligible regions</label>
              <input
                value={form.eligibleRegions}
                onChange={(e) => set('eligibleRegions', e.target.value)}
                placeholder="Leave blank for All"
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              />
              <p className="text-[10px] text-gray-400">
                Comma-separated regions. {form.eligibleRegions.trim() ? '' : 'Empty = all regions.'}
              </p>
            </div>
          </div>

          {/* Bonus points */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Bonus points</label>
            <input
              type="number"
              min={0}
              step={1}
              value={form.bonusPoints}
              onChange={(e) => set('bonusPoints', e.target.value)}
              placeholder="0"
              className={`${inputCls('bonusPoints')} w-48`}
            />
            {errors.bonusPoints
              ? <p className="text-xs text-red-500">{errors.bonusPoints}</p>
              : <p className="text-[10px] text-gray-400">Credited once to every eligible active employee when you run Credit bonus.</p>}
          </div>

          {serverError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
              <XCircle className="w-4 h-4 shrink-0" /> {serverError}
            </div>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Contest'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Cancel confirm modal
   ════════════════════════════════════════════════════════════════════════════ */

function CancelModal({
  contest, onConfirm, onClose, busy,
}: {
  contest: Contest; onConfirm: () => void; onClose: () => void; busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <Ban className="h-5 w-5 text-red-500" />
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-sm">Cancel contest?</p>
            <p className="text-xs text-gray-500 mt-0.5">
              This cancels <strong>{contest.name}</strong>. A cancelled contest cannot be reactivated.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50">
            Keep contest
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Cancel contest'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Credit-bonus confirm modal (MONEY-ADJACENT)
   ════════════════════════════════════════════════════════════════════════════ */

function CreditBonusModal({
  contest, onClose, onCredited,
}: {
  contest: Contest;
  onClose: () => void;
  onCredited: () => void;
}) {
  const [winners, setWinners] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<CreditBonusResult | null>(null);

  const submit = async () => {
    if (busy) return;            // double-click guard
    setBusy(true); setErr('');
    const codes = parseCsvList(winners);
    const body: Record<string, unknown> = codes.length > 0 ? { winnerEmployeeCodes: codes } : {};
    const res = await api.post<CreditBonusResult>(`/api/admin/contests/${contest.id}/credit-bonus`, body);
    if (res.success) {
      setResult(res.data);
    } else {
      setErr(res.error);
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={result ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-[var(--brand-primary)]" />
            <h2 className="text-base font-bold text-gray-900">Credit bonus points</h2>
          </div>
          <button
            onClick={() => (result ? onCredited() : onClose())}
            className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {!result ? (
            <>
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-sm text-amber-800">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  This credits <strong>{fmtPts(contest.bonusPoints)} points</strong> to every eligible
                  active employee, once. <strong>This cannot be undone.</strong>
                </span>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">
                  Winner employee codes (optional)
                </label>
                <textarea
                  value={winners}
                  onChange={(e) => setWinners(e.target.value)}
                  rows={4}
                  placeholder={'Leave blank to credit the WHOLE eligible set.\nOr paste codes — one per line or comma-separated.'}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                />
                <p className="text-[10px] text-gray-400">
                  {winners.trim()
                    ? `${parseCsvList(winners).length} code(s) will be credited.`
                    : 'Blank = credit every eligible active employee for this contest.'}
                </p>
              </div>

              {err && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
                  <XCircle className="w-4 h-4 shrink-0" /> {err}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              {/* Honesty: a run that credited NOBODY (zero eligible winners) does NOT burn the
                  contest — it stays ACTIVE/ENDED and re-runnable. Never show a green "credited"
                  for that case (mirrors the Phase C upload done-screen honesty rule). */}
              {result.creditedCount > 0 ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <span>Bonus credited.</span>
                </div>
              ) : (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-sm text-amber-800">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    <strong>Nothing was credited.</strong> No eligible active employee matched this
                    contest, so no points moved. The contest is still active and can be run again.
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className={`rounded-xl border px-4 py-3 text-center ${result.creditedCount > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
                  <p className={`text-2xl font-bold ${result.creditedCount > 0 ? 'text-emerald-700' : 'text-gray-800'}`}>{fmtPts(result.creditedCount)}</p>
                  <p className={`text-xs font-medium mt-0.5 ${result.creditedCount > 0 ? 'text-emerald-700/70' : 'text-gray-500'}`}>Winners credited</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-center">
                  <p className="text-2xl font-bold text-gray-800">{fmtPts(result.pointsCreditedTotal)}</p>
                  <p className="text-xs font-medium mt-0.5 text-gray-500">Total points</p>
                </div>
              </div>

              {result.skipped.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto">
                  <p className="text-xs font-semibold text-amber-700 mb-2">
                    Skipped ({result.skipped.length})
                  </p>
                  {result.skipped.map((s, i) => (
                    <p key={`${s.employeeCode}-${i}`} className="text-xs text-amber-700">
                      <span className="font-mono font-semibold">{s.employeeCode}:</span> {s.reason}
                    </p>
                  ))}
                </div>
              )}
              {result.skipped.length === 0 && (
                <p className="text-xs text-gray-500 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" /> No employees were skipped.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          {!result ? (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
              >
                {busy ? 'Crediting…' : `Credit ${fmtPts(contest.bonusPoints)} points`}
              </button>
            </>
          ) : (
            <button
              onClick={onCredited}
              className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)]"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Page
   ════════════════════════════════════════════════════════════════════════════ */

export default function AdminContestsPage() {
  const [contests, setContests] = useState<Contest[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: PAGE_LIMIT, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState<'all' | ContestStatus>('all');
  const [page, setPage] = useState(1);

  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Contest | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalErr, setModalErr] = useState('');

  const [cancelling, setCancelling] = useState<Contest | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const [crediting, setCrediting] = useState<Contest | null>(null);

  /** Row-level busy guard for status-advance buttons, keyed by contest id. */
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    params.set('page', String(page));
    params.set('limit', String(PAGE_LIMIT));
    const res = await api.get<ContestListResponse>(`/api/admin/contests?${params.toString()}`);
    if (res.success) {
      setContests(res.data.contests ?? []);
      setPagination(res.data.pagination ?? { page, limit: PAGE_LIMIT, total: 0, pages: 0 });
    } else {
      setError(res.error);
      setContests([]);
    }
    setLoading(false);
  }, [statusFilter, page]);

  useEffect(() => { load(); }, [load]);

  const saveContest = async (payload: Record<string, unknown>) => {
    setSaving(true); setModalErr('');
    const res = editing
      ? await api.patch<Contest>(`/api/admin/contests/${editing.id}`, payload)
      : await api.post<Contest>('/api/admin/contests', payload);
    if (res.success) {
      setModal(false); setEditing(null);
      await load();
    } else {
      setModalErr(res.error);
    }
    setSaving(false);
  };

  const advanceStatus = async (contest: Contest, status: ContestStatus) => {
    if (rowBusy) return;
    setRowBusy(contest.id); setError('');
    const res = await api.post<Contest>(`/api/admin/contests/${contest.id}/status`, { status });
    if (!res.success) setError(res.error);
    await load();
    setRowBusy(null);
  };

  const confirmCancel = async () => {
    if (!cancelling || cancelBusy) return;
    setCancelBusy(true); setError('');
    const res = await api.post<Contest>(`/api/admin/contests/${cancelling.id}/cancel`, {});
    if (!res.success) setError(res.error);
    setCancelling(null);
    await load();
    setCancelBusy(false);
  };

  const stats = useMemo(() => ({
    total: pagination.total,
    active: contests.filter((c) => c.status === 'ACTIVE').length,
    scheduled: contests.filter((c) => c.status === 'SCHEDULED').length,
    credited: contests.filter((c) => c.status === 'CREDITED').length,
  }), [contests, pagination.total]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Contests</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Create time-boxed contests and credit bonus points to eligible employees.
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setModalErr(''); setModal(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)]"
        >
          <Plus className="h-4 w-4" /> New Contest
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Contests', value: stats.total,     color: 'text-gray-900' },
          { label: 'Active',         value: stats.active,    color: 'text-green-600' },
          { label: 'Scheduled',      value: stats.scheduled, color: 'text-blue-600' },
          { label: 'Credited',       value: stats.credited,  color: 'text-emerald-600' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as 'all' | ContestStatus); setPage(1); }}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>
            ))}
          </select>
          <button
            onClick={() => load()}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50"
            aria-label="Refresh contests"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16" aria-label="Loading">
          <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
        </div>
      ) : contests.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 bg-white rounded-2xl border border-gray-100">
          <Trophy className="h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">No contests found</p>
          <p className="text-xs text-gray-400 mt-1">Create a contest to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {contests.map((c) => {
            const nextStatuses = NEXT_STATUS[c.status] ?? [];
            const busy = rowBusy === c.id;
            const alreadyCredited = c.bonusCreditedAt != null;
            return (
              <div key={c.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-bold text-gray-900 truncate">{c.name}</h3>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${STATUS_BADGE[c.status]}`}>
                        {c.status}
                      </span>
                      {alreadyCredited && c.status !== 'CREDITED' && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-100">
                          BONUS CREDITED
                        </span>
                      )}
                    </div>
                    {c.description && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{c.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3 text-gray-400" />
                        {fmtDate(c.startDate)} → {fmtDate(c.endDate)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Gift className="h-3 w-3 text-gray-400" />
                        {c.bonusPoints > 0 ? `${fmtPts(c.bonusPoints)} pts bonus` : 'No bonus'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3 text-gray-400" />
                        {c.eligibleRoleCodes.length > 0 ? c.eligibleRoleCodes.join(', ') : 'All roles'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-gray-400" />
                        {c.eligibleRegions.length > 0 ? c.eligibleRegions.join(', ') : 'All regions'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-gray-50">
                  {canEdit(c.status) && (
                    <button
                      onClick={() => { setEditing(c); setModalErr(''); setModal(true); }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
                    >
                      <Edit2 className="h-3.5 w-3.5" /> Edit
                    </button>
                  )}
                  {nextStatuses.map((ns) => (
                    <button
                      key={ns}
                      onClick={() => advanceStatus(c, ns)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
                    >
                      {busy ? 'Working…' : `Move to ${ns}`}
                    </button>
                  ))}
                  {canCreditBonus(c) && (
                    <button
                      onClick={() => setCrediting(c)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                    >
                      <Coins className="h-3.5 w-3.5" /> Credit bonus
                    </button>
                  )}
                  {CANCELLABLE.has(c.status) && (
                    <button
                      onClick={() => setCancelling(c)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 ml-auto"
                    >
                      <Ban className="h-3.5 w-3.5" /> Cancel
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {!loading && pagination.pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Page {pagination.page} of {pagination.pages} · {pagination.total} total
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
              disabled={page >= pagination.pages}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {modal && (
        <ContestModal
          editing={editing}
          saving={saving}
          serverError={modalErr}
          onSave={saveContest}
          onClose={() => { setModal(false); setEditing(null); }}
        />
      )}
      {cancelling && (
        <CancelModal
          contest={cancelling}
          busy={cancelBusy}
          onConfirm={confirmCancel}
          onClose={() => setCancelling(null)}
        />
      )}
      {crediting && (
        <CreditBonusModal
          contest={crediting}
          onClose={() => setCrediting(null)}
          onCredited={() => { setCrediting(null); load(); }}
        />
      )}
    </div>
  );
}
