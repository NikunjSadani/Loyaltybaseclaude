'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Users, FileSpreadsheet, Loader2, AlertTriangle, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { INDIAN_STATE_NAMES } from '@/lib/indian-states';
import {
  type WizardState,
  type WizardAction,
  type AudienceScope,
  type AudienceFilter,
  parseCsvList,
  parseExcelAudience,
  isValidPhone,
  buildPreviewPayload,
  checkExcelFile,
  EXCEL_MAX_ROWS,
  type PreviewResult,
} from '@/lib/whatsapp-broadcasts';

const SCOPES: { value: AudienceScope; label: string; hint: string }[] = [
  { value: 'OUTLETS', label: 'Outlets', hint: 'Outlet owner phone numbers' },
  { value: 'SALES', label: 'Sales reps', hint: 'Field sales users' },
  { value: 'BOTH', label: 'Both', hint: 'Outlets + sales reps' },
];

export function AudienceStep({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}) {
  return (
    <div className="space-y-5">
      {/* Title */}
      <div>
        <label htmlFor="wa-title" className="block text-xs font-semibold text-gray-700 mb-1.5">
          Campaign name
        </label>
        <input
          id="wa-title"
          type="text"
          value={state.title}
          onChange={(e) => dispatch({ type: 'SET_TITLE', title: e.target.value })}
          placeholder="e.g. Diwali offer — Maharashtra outlets"
          data-testid="audience-title"
          className="w-full max-w-md text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        />
        <p className="text-[11px] text-gray-400 mt-1">
          Internal label — recipients never see this.
        </p>
      </div>

      {/* Mode tabs */}
      <div role="tablist" aria-label="Audience source" className="flex border-b border-gray-200">
        <ModeTab
          active={state.audienceMode === 'FILTER'}
          onClick={() => dispatch({ type: 'SET_MODE', mode: 'FILTER' })}
          icon={<Users className="w-3.5 h-3.5" />}
          label="Filter outlets / reps"
          testId="mode-filter"
        />
        <ModeTab
          active={state.audienceMode === 'EXCEL'}
          onClick={() => dispatch({ type: 'SET_MODE', mode: 'EXCEL' })}
          icon={<FileSpreadsheet className="w-3.5 h-3.5" />}
          label="Upload Excel list"
          testId="mode-excel"
        />
      </div>

      {state.audienceMode === 'FILTER' ? (
        <FilterPanel state={state} dispatch={dispatch} />
      ) : (
        <ExcelPanel state={state} dispatch={dispatch} />
      )}

      {/* Live recipient count */}
      <RecipientCount state={state} />
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium -mb-px border-b-2 transition-colors ${
        active
          ? 'text-[var(--brand-primary)] border-[var(--brand-primary)]'
          : 'text-gray-500 border-transparent hover:text-gray-700'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── FILTER panel ─────────────────────────────────────────────────────────────

function FilterPanel({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const f = state.filter;
  const setFilter = (patch: Partial<AudienceFilter>) =>
    dispatch({ type: 'SET_FILTER', filter: { ...f, ...patch } });

  return (
    <div className="space-y-4">
      {/* Scope */}
      <div>
        <span className="block text-xs font-semibold text-gray-700 mb-1.5">Who</span>
        <div role="radiogroup" aria-label="Audience scope" className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={state.scope === s.value}
              title={s.hint}
              onClick={() => dispatch({ type: 'SET_SCOPE', scope: s.value })}
              data-testid={`scope-${s.value}`}
              className={`px-4 py-2 text-xs font-medium transition-colors ${
                state.scope === s.value
                  ? 'bg-[var(--brand-primary)] text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* States — multi-select chips */}
        <StateMultiSelect
          values={f.states ?? []}
          onChange={(states) => setFilter({ states })}
        />
        {/* Zones — mirrors the states input (free-text: there is no fixed zone list). */}
        <CsvField
          label="Zones"
          placeholder="Comma-separated zone names"
          values={f.zones ?? []}
          onChange={(zones) => setFilter({ zones })}
          testId="filter-zones"
        />
        <CsvField
          label="Cities"
          placeholder="Comma-separated city names, e.g. Pune, Nagpur"
          values={f.cities ?? []}
          onChange={(cities) => setFilter({ cities })}
          testId="filter-cities"
        />
        <CsvField
          label="Programs"
          placeholder="Comma-separated program names"
          values={f.programNames ?? []}
          onChange={(programNames) => setFilter({ programNames })}
          testId="filter-programs"
        />
        <CsvField
          label="Program categories"
          placeholder="Comma-separated category names"
          values={f.programCategories ?? []}
          onChange={(programCategories) => setFilter({ programCategories })}
          testId="filter-categories"
        />
        <CsvField
          label="Outlet types"
          placeholder="Comma-separated outlet-type IDs"
          values={f.outletTypeIds ?? []}
          onChange={(outletTypeIds) => setFilter({ outletTypeIds })}
          testId="filter-outlet-types"
        />
        <CsvField
          label="Owner groups"
          placeholder="Comma-separated owner-group IDs"
          values={f.groupIds ?? []}
          onChange={(groupIds) => setFilter({ groupIds })}
          testId="filter-groups"
        />
      </div>

      {/* KYC status */}
      <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={!!f.kycApprovedOnly}
          onChange={(e) => setFilter({ kycApprovedOnly: e.target.checked })}
          data-testid="filter-kyc"
          className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]/30"
        />
        KYC-approved outlets only
      </label>

      <p className="text-[11px] text-gray-400">
        Enter comma-separated values in each box. States, zones, cities, programs and
        categories are matched by <span className="font-semibold">name</span> (as they
        appear in the outlet master); outlet types and owner groups expect their
        internal <span className="font-semibold">IDs</span>. Any box left blank is not
        applied — leave everything blank to target the whole tenant in the chosen scope.
        The recipient count below reflects exactly what will be sent.
      </p>
    </div>
  );
}

function CsvField({
  label,
  placeholder,
  values,
  onChange,
  testId,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
  testId: string;
}) {
  // Controlled by the joined display; parse on change so the filter stores a list.
  const [raw, setRaw] = useState(values.join(', '));
  // Keep local text in sync if the filter is reset upstream.
  useEffect(() => {
    setRaw(values.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.length === 0]);
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-1.5">{label}</label>
      <input
        type="text"
        value={raw}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(parseCsvList(e.target.value));
        }}
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
      />
    </div>
  );
}

function StateMultiSelect({
  values,
  onChange,
}: {
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const remaining = useMemo(
    () => INDIAN_STATE_NAMES.filter((s) => !values.includes(s)),
    [values],
  );
  return (
    <div>
      <label htmlFor="filter-state-add" className="block text-xs font-semibold text-gray-700 mb-1.5">
        States
      </label>
      <select
        id="filter-state-add"
        value=""
        data-testid="filter-state-add"
        onChange={(e) => {
          if (e.target.value) onChange([...values, e.target.value]);
        }}
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
      >
        <option value="">Add a state…</option>
        {remaining.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {values.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-[11px] rounded-full pl-2.5 pr-1 py-0.5"
            >
              {s}
              <button
                type="button"
                aria-label={`Remove ${s}`}
                onClick={() => onChange(values.filter((x) => x !== s))}
                className="p-0.5 rounded-full hover:bg-gray-200 text-gray-500"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── EXCEL panel ──────────────────────────────────────────────────────────────

function ExcelPanel({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const excel = state.excel;

  const onFile = useCallback(
    async (file: File) => {
      // Guard by size BEFORE reading — XLSX.read is synchronous and would freeze the
      // tab on an oversized file. Reject early with a clear warning, no parse.
      const sizeCheck = checkExcelFile(file);
      if (!sizeCheck.ok) {
        dispatch({
          type: 'SET_EXCEL',
          excel: {
            columns: [],
            rows: [],
            phoneColumn: null,
            invalidCount: 0,
            duplicateCount: 0,
            totalRows: 0,
            error: sizeCheck.error,
          },
        });
        return;
      }
      setReading(true);
      try {
        const buf = await file.arrayBuffer();
        const parsed = parseExcelAudience(buf);
        dispatch({ type: 'SET_EXCEL', excel: parsed });
      } finally {
        setReading(false);
      }
    },
    [dispatch],
  );

  const validRows = excel?.rows.filter((r) => isValidPhone(r.rawPhone)).length ?? 0;
  const overRowCap = (excel?.totalRows ?? 0) > EXCEL_MAX_ROWS;

  return (
    <div className="space-y-4">
      <div
        className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-[var(--brand-primary)]/40 transition-colors"
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          data-testid="excel-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
        {reading ? (
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-gray-400" />
        ) : (
          <Upload className="w-6 h-6 mx-auto text-gray-400" />
        )}
        <p className="text-sm font-medium text-gray-700 mt-2">
          Click to upload a phone list
        </p>
        <p className="text-[11px] text-gray-400 mt-0.5">
          .xlsx, .xls or .csv — needs a <span className="font-semibold">Phone</span> column
          plus any variable columns. Up to{' '}
          {EXCEL_MAX_ROWS.toLocaleString('en-IN')} recipients.
        </p>
      </div>

      {excel?.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {excel.error}
        </div>
      )}

      {overRowCap && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          This list has {(excel?.totalRows ?? 0).toLocaleString('en-IN')} rows — only the
          first {EXCEL_MAX_ROWS.toLocaleString('en-IN')} recipients will be sent (the rest
          are dropped server-side). Split the list to reach everyone.
        </div>
      )}

      {excel && !excel.error && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-xs text-gray-700 space-y-1">
          <p>
            Phone column: <span className="font-semibold">{excel.phoneColumn}</span>
          </p>
          <p>
            <span className="font-semibold">{validRows}</span> valid number
            {validRows !== 1 ? 's' : ''} of {excel.totalRows} row
            {excel.totalRows !== 1 ? 's' : ''}
            {excel.invalidCount > 0 && (
              <span className="text-amber-700">
                {' '}
                · {excel.invalidCount} invalid
              </span>
            )}
            {excel.duplicateCount > 0 && (
              <span className="text-gray-500">
                {' '}
                · {excel.duplicateCount} duplicate removed
              </span>
            )}
          </p>
          {excel.columns.length > 0 && (
            <p>
              Variable columns:{' '}
              <span className="font-semibold">{excel.columns.join(', ')}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Live recipient count ───────────────────────────────────────────────────────

function RecipientCount({ state }: { state: WizardState }) {
  const [count, setCount] = useState<number | null>(null);
  const [invalid, setInvalid] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Serialize just the audience-affecting bits so we only refetch on real changes.
  const audienceKey = useMemo(
    () =>
      JSON.stringify({
        mode: state.audienceMode,
        scope: state.scope,
        filter: state.filter,
        rows: state.excel?.rows.length ?? 0,
      }),
    [state.audienceMode, state.scope, state.filter, state.excel],
  );

  const fetchCount = useCallback(async () => {
    // No point counting an EXCEL audience with zero valid rows.
    if (
      state.audienceMode === 'EXCEL' &&
      !state.excel?.rows.some((r) => isValidPhone(r.rawPhone))
    ) {
      setCount(0);
      return;
    }
    setLoading(true);
    setError(null);
    // Count-only preview: no templateId → backend returns recipientCount without a sample.
    const payload = buildPreviewPayload(state);
    delete (payload as Record<string, unknown>).templateId;
    const res = await api.post<PreviewResult>(
      '/api/admin/whatsapp-broadcasts/preview',
      payload,
    );
    setLoading(false);
    if (res.success) {
      setCount(res.data.recipientCount);
      setInvalid(res.data.invalidCount ?? 0);
    } else {
      setError(res.error);
      setCount(null);
    }
  }, [state]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchCount(), 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey]);

  return (
    <div
      className="flex items-center gap-2 bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20 rounded-xl px-4 py-3"
      data-testid="recipient-count"
      aria-live="polite"
    >
      <Users className="w-4 h-4 text-[var(--brand-primary)]" />
      {loading ? (
        <span className="text-sm text-gray-500 inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Counting recipients…
        </span>
      ) : error ? (
        <span className="text-sm text-amber-700">Couldn’t fetch count: {error}</span>
      ) : count === null ? (
        <span className="text-sm text-gray-500">Set an audience to see the count.</span>
      ) : (
        <span className="text-sm text-gray-700">
          <span className="font-bold text-gray-900">{count.toLocaleString('en-IN')}</span>{' '}
          recipient{count !== 1 ? 's' : ''} match this audience
          {invalid > 0 && (
            <span className="text-amber-700"> · {invalid} invalid number(s) will be skipped</span>
          )}
        </span>
      )}
    </div>
  );
}
