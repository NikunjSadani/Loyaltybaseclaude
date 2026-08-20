'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Landmark, Plus, Trash2, Loader2, Save, AlertTriangle, CheckCircle2, XCircle, Lock,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { getStoredUser } from '@/lib/auth-client';

// ── Types (mirror the platform TDS statutory-config backend envelope) ──────────────

interface TdsEntry {
  effectiveFromFy: string;
  r194rWithPanPct: number;
  r194rNoPanPct: number;
  c194cIndividualPct: number;
  c194cOtherPct: number;
  c194cNoPanPct: number;
  thr194cSingleRupees: number;
  thr194cFyRupees: number;
  thr194rFyRupees: number;
}

/** The backend's resolved-for-current-FY shape: rates as {num,den}, thresholds as paise strings —
 *  distinct from the editor-row (pct + rupees) shape, so it must be mapped before display. */
interface RawResolved {
  r194rWithPan: { num: number; den: number };
  r194rNoPan: { num: number; den: number };
  c194cIndividual: { num: number; den: number };
  c194cOther: { num: number; den: number };
  c194cNoPan: { num: number; den: number };
  thr194cSinglePaise: string;
  thr194cFyPaise: string;
  thr194rFyPaise: string;
}

interface StatutoryPayload {
  entries: TdsEntry[];
  /** built-in defaults in the pct/rupees view shape (no effectiveFromFy). */
  defaults: Omit<TdsEntry, 'effectiveFromFy'>;
  resolvedForCurrentFy: RawResolved;
  currentFyLabel: string;
}

/** Map the backend resolved shape into the editor-row (pct/rupees) shape for the reference card. */
function resolvedToEntry(r: RawResolved, fy: string): TdsEntry {
  return {
    effectiveFromFy: fy,
    r194rWithPanPct: r.r194rWithPan.num,
    r194rNoPanPct: r.r194rNoPan.num,
    c194cIndividualPct: r.c194cIndividual.num,
    c194cOtherPct: r.c194cOther.num,
    c194cNoPanPct: r.c194cNoPan.num,
    thr194cSingleRupees: Number(r.thr194cSinglePaise) / 100,
    thr194cFyRupees: Number(r.thr194cFyPaise) / 100,
    thr194rFyRupees: Number(r.thr194rFyPaise) / 100,
  };
}

// The editable numeric fields are held as raw strings while editing so inline
// validation can flag non-integers / out-of-range / empty before a Save.
type Row = Record<keyof TdsEntry, string>;

// ── Field metadata (plain-language labels for an entry-level operator) ──────────────

// The 8 numeric fields (everything except the FY key). Narrowing to this union lets
// `entry[k] = Number(...)` type-check (a bare keyof TdsEntry would widen to never).
type NumericKey = Exclude<keyof TdsEntry, 'effectiveFromFy'>;

const RATE_FIELDS: { key: NumericKey; label: string }[] = [
  { key: 'r194rWithPanPct',   label: '194R — with-PAN rate (%)' },
  { key: 'r194rNoPanPct',     label: '194R — no-PAN rate (%)' },
  { key: 'c194cIndividualPct', label: '194C — Individual/HUF rate (%)' },
  { key: 'c194cOtherPct',     label: '194C — Other (company/firm) rate (%)' },
  { key: 'c194cNoPanPct',     label: '194C — no-PAN rate (%)' },
];

const THRESHOLD_FIELDS: { key: NumericKey; label: string }[] = [
  { key: 'thr194cSingleRupees', label: '194C — single-payment threshold (₹)' },
  { key: 'thr194cFyRupees',     label: '194C — financial-year aggregate threshold (₹)' },
  { key: 'thr194rFyRupees',     label: '194R — financial-year threshold (₹)' },
];

const RATE_KEYS = RATE_FIELDS.map((f) => f.key);
const THRESHOLD_KEYS = THRESHOLD_FIELDS.map((f) => f.key);
const NUMERIC_KEYS = [...RATE_KEYS, ...THRESHOLD_KEYS];

const FY_RE = /^\d{4}-\d{2}$/;

// ── Row <-> entry conversion ───────────────────────────────────────────────────────

function entryToRow(e: TdsEntry): Row {
  const r = { effectiveFromFy: e.effectiveFromFy } as Row;
  for (const k of NUMERIC_KEYS) r[k] = String(e[k] ?? '');
  return r;
}

function emptyRow(): Row {
  const r = { effectiveFromFy: '' } as Row;
  for (const k of NUMERIC_KEYS) r[k] = '';
  return r;
}

/** Build the PUT body from the rows (numeric fields coerced to Number). */
function rowsToEntries(rows: Row[]): TdsEntry[] {
  return rows.map((row) => {
    const e = { effectiveFromFy: row.effectiveFromFy.trim() } as TdsEntry;
    for (const k of NUMERIC_KEYS) e[k] = Number(row[k]);
    return e;
  });
}

// ── Client-side validation (mirrors the backend contract) ───────────────────────────

/** true for a non-negative integer string (no decimals, no sign, non-empty). */
function isIntStr(s: string): boolean {
  return /^\d+$/.test(s.trim());
}

type RowErrors = Partial<Record<keyof TdsEntry, string>>;

function validateRows(rows: Row[]): { errors: RowErrors[]; valid: boolean } {
  const errors: RowErrors[] = rows.map(() => ({}));
  let valid = true;

  // FY format + uniqueness
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const fy = row.effectiveFromFy.trim();
    if (!fy) {
      errors[i].effectiveFromFy = 'Required';
    } else if (!FY_RE.test(fy)) {
      errors[i].effectiveFromFy = 'Use the format YYYY-YY, e.g. 2026-27';
    } else if (seen.has(fy)) {
      errors[i].effectiveFromFy = 'Duplicate financial year';
      const first = seen.get(fy)!;
      if (!errors[first].effectiveFromFy) errors[first].effectiveFromFy = 'Duplicate financial year';
    } else {
      seen.set(fy, i);
    }

    // Rates: integer 0..95
    for (const k of RATE_KEYS) {
      const v = row[k].trim();
      if (!isIntStr(v)) {
        errors[i][k] = 'Whole number 0–95';
      } else {
        const n = Number(v);
        if (n < 0 || n > 95) errors[i][k] = 'Must be between 0 and 95';
      }
    }
    // Thresholds: integer >= 0
    for (const k of THRESHOLD_KEYS) {
      const v = row[k].trim();
      if (!isIntStr(v)) errors[i][k] = 'Whole number ≥ 0';
    }
  });

  valid = errors.every((e) => Object.keys(e).length === 0);
  return { errors, valid };
}

// ── Page ─────────────────────────────────────────────────────────────────────────

export default function GifsyTdsStatutoryPage() {
  // Owner-only gate. The /gifsy shell already routes GIFSY_STAFF to a launchpad and only
  // shows these pages to GIFSY_ADMIN, but guard the page itself as defence-in-depth so a
  // non-owner never mounts the editor. Resolve the role client-side with a ready gate.
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRole(getStoredUser()?.role ?? null);
    setReady(true);
  }, []);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [initialRows, setInitialRows] = useState<Row[]>([]);
  const [defaults, setDefaults] = useState<TdsEntry | null>(null);
  const [resolved, setResolved] = useState<TdsEntry | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const applyPayload = useCallback((p: StatutoryPayload) => {
    const loaded = (p.entries ?? []).map(entryToRow);
    setRows(loaded.length ? loaded : [emptyRow()]);
    setInitialRows(loaded);
    setDefaults(p.defaults ? { effectiveFromFy: '— built-in default —', ...p.defaults } : null);
    setResolved(
      p.resolvedForCurrentFy ? resolvedToEntry(p.resolvedForCurrentFy, p.currentFyLabel) : null,
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await api.get<StatutoryPayload>('/api/admin/tds/statutory');
    if (res.success) applyPayload(res.data);
    else setLoadError(res.error);
    setLoading(false);
  }, [applyPayload]);

  useEffect(() => { if (ready && role === 'GIFSY_ADMIN') void load(); }, [ready, role, load]);

  const { errors, valid } = useMemo(() => validateRows(rows), [rows]);
  const changed = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(initialRows),
    [rows, initialRows],
  );

  function updateCell(idx: number, key: keyof TdsEntry, value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }
  function removeRow(idx: number) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  // ── Render: not-ready / owner-only guard ──
  if (!ready) return null;
  if (role !== 'GIFSY_ADMIN') {
    return (
      <div className="max-w-lg mx-auto mt-10 border border-white/10 rounded-xl px-6 py-8 text-center">
        <Lock className="w-6 h-6 mx-auto text-white/40" />
        <h1 className="text-lg font-bold text-white mt-3">Owner-only</h1>
        <p className="text-sm text-white/50 mt-1">
          Only the platform owner (GIFSY_ADMIN) can view or edit the statutory TDS configuration.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Landmark className="w-5 h-5 text-white/60" />TDS Statutory Configuration
          </h1>
          <p className="text-sm text-white/50 mt-0.5">
            Statutory TDS rates and thresholds, keyed by financial year. These apply platform-wide —
            to every tenant&apos;s TDS from the financial year each row takes effect.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setConfirmOpen(true)}
          disabled={loading || !valid || !changed}
          data-testid="save-btn"
        >
          <Save className="w-4 h-4" />Review &amp; Save
        </Button>
      </div>

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300">
        <strong>Platform-wide money setting.</strong> These rates and thresholds are identical for
        all tenants and are enforced by the backend TDS engine. Add a new financial-year row when the
        law changes; existing rows stay in effect for their years.
      </div>

      {/* Load states */}
      {loading && (
        <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-white/40 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />Loading statutory config…
        </div>
      )}
      {!loading && loadError && (
        <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-sm">
          <p className="text-red-400">{loadError}</p>
          <button
            onClick={() => { void load(); }}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-white/15 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Editor */}
      {!loading && !loadError && (
        <>
          <div className="space-y-4">
            {rows.map((row, i) => (
              <EntryCard
                key={i}
                index={i}
                row={row}
                errors={errors[i] ?? {}}
                canRemove={rows.length > 1}
                onChange={(key, value) => updateCell(i, key, value)}
                onRemove={() => removeRow(i)}
              />
            ))}
          </div>

          <button
            onClick={addRow}
            data-testid="add-row"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-white/15 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />Add financial year
          </button>

          {/* Reference: built-in defaults + resolved-for-current-FY (read-only) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2">
            {defaults && <ReferenceCard title="Built-in defaults" entry={defaults} />}
            {resolved && <ReferenceCard title="In effect for the current financial year" entry={resolved} />}
          </div>
        </>
      )}

      {/* Confirm-save modal */}
      {confirmOpen && (
        <ConfirmSaveModal
          entries={rowsToEntries(rows)}
          onClose={() => setConfirmOpen(false)}
          onSaved={(payload) => {
            setConfirmOpen(false);
            applyPayload(payload);
            showToast('Statutory TDS configuration saved.');
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg"
        >
          {toast.type === 'error'
            ? <XCircle className="w-4 h-4 text-red-400" />
            : <CheckCircle2 className="w-4 h-4 text-green-400" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Entry card (one financial-year row) ────────────────────────────────────────────

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';
const INPUT_ERR_CLS =
  'w-full bg-white/5 border border-red-500/50 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-red-500';

function EntryCard({
  index, row, errors, canRemove, onChange, onRemove,
}: {
  index: number;
  row: Row;
  errors: RowErrors;
  canRemove: boolean;
  onChange: (key: keyof TdsEntry, value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden" data-testid={`entry-${index}`}>
      <div className="px-5 py-4 border-b border-white/5 flex items-end justify-between gap-4">
        <div className="w-48">
          <label className="block text-xs font-medium text-white/50 mb-1.5">Effective from financial year</label>
          <input
            type="text"
            inputMode="numeric"
            value={row.effectiveFromFy}
            aria-label={`Financial year for entry ${index + 1}`}
            data-testid={`fy-${index}`}
            placeholder="2026-27"
            onChange={(e) => onChange('effectiveFromFy', e.target.value)}
            className={`font-mono ${errors.effectiveFromFy ? INPUT_ERR_CLS : INPUT_CLS}`}
          />
          {errors.effectiveFromFy && (
            <p className="text-[11px] text-red-400 mt-1">{errors.effectiveFromFy}</p>
          )}
        </div>
        <button
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? undefined : 'At least one financial-year row is required'}
          data-testid={`remove-${index}`}
          aria-label={`Remove entry ${index + 1}`}
          className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-white/40"
        >
          <Trash2 className="w-3.5 h-3.5" />Remove
        </button>
      </div>

      <div className="px-5 py-5 space-y-5">
        <FieldGroup title="Rates (%)" fields={RATE_FIELDS} row={row} errors={errors} index={index} onChange={onChange} />
        <FieldGroup title="Thresholds (₹)" fields={THRESHOLD_FIELDS} row={row} errors={errors} index={index} onChange={onChange} />
      </div>
    </div>
  );
}

function FieldGroup({
  title, fields, row, errors, index, onChange,
}: {
  title: string;
  fields: { key: keyof TdsEntry; label: string }[];
  row: Row;
  errors: RowErrors;
  index: number;
  onChange: (key: keyof TdsEntry, value: string) => void;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-white/30 font-semibold mb-2">{title}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {fields.map((f) => {
          const err = errors[f.key];
          return (
            <div key={f.key}>
              <label className="block text-xs font-medium text-white/50 mb-1.5">{f.label}</label>
              <input
                type="text"
                inputMode="numeric"
                value={row[f.key]}
                aria-label={`${f.label} for entry ${index + 1}`}
                data-testid={`field-${index}-${f.key}`}
                onChange={(e) => onChange(f.key, e.target.value)}
                className={err ? INPUT_ERR_CLS : INPUT_CLS}
              />
              {err && <p className="text-[11px] text-red-400 mt-1">{err}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Reference card (read-only defaults / resolved) ─────────────────────────────────

function ReferenceCard({ title, entry }: { title: string; entry: TdsEntry }) {
  const allFields = [
    { key: 'effectiveFromFy' as const, label: 'Effective from FY' },
    ...RATE_FIELDS,
    ...THRESHOLD_FIELDS,
  ];
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-white/5">
        <span className="text-sm font-semibold text-white">{title}</span>
      </div>
      <div className="px-5 py-4 space-y-1.5">
        {allFields.map((f) => (
          <div key={f.key} className="flex items-center justify-between gap-4 text-xs">
            <span className="text-white/40">{f.label}</span>
            <span className="font-mono text-white/70">{String(entry[f.key as keyof TdsEntry])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Confirm-save modal ─────────────────────────────────────────────────────────────

function ConfirmSaveModal({
  entries, onClose, onSaved,
}: {
  entries: TdsEntry[];
  onClose: () => void;
  onSaved: (payload: StatutoryPayload) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    const res = await api.put<StatutoryPayload>('/api/admin/tds/statutory', { entries });
    setSubmitting(false);
    if (res.success) onSaved(res.data);
    else setError(res.error); // surface the backend 400/403 message verbatim
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !submitting) onClose(); }}
      title="Save statutory TDS configuration?"
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          These rates and thresholds apply to <strong>all tenants&apos;</strong> TDS from the given
          financial year. Saving {entries.length === 1 ? 'this entry' : `${entries.length} entries`} takes
          effect immediately across the platform. Save?
        </p>

        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" variant="primary" loading={submitting} onClick={handleSave} data-testid="confirm-save">
            Save configuration
          </Button>
        </div>
      </div>
    </Modal>
  );
}
