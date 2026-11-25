'use client';

/**
 * FOCUS-FROM-TARGETS (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md §6): the ONE reconciliation view of a month —
 * targets, focus product names → products (per KPI), blockers and gaps. Used by the import's month preview AND by
 * Months → Recalculate, so both screens say exactly the same thing.
 *
 * "Accept — not sold yet" / "Undo" call POST / DELETE admin/sales-months/:month/focus-acceptances and then ask the
 * parent to refresh its preview (the reconciliation, canApply and the focus fingerprint all change). Nothing is shown
 * as done until the server said so and the refreshed preview landed.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Info, Undo2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import { dateTimeLabel, formatCount, formatKpiValue, monthLabel, sentence } from '@/lib/sales-import/format';
import { noAnswerReason, outcomeUnknown, reasonOr } from '@/lib/request-outcome';
import type {
  DimMatch, FocusBlocker, FocusNameSummary, FocusTokenResolution, MonthFocusKpi, MonthReconciliation,
  SalesDimensionMapping, SalesKpiMeasure,
} from '@/lib/sales-import/types';

/** Outlet type code -> display name. */
export type OutletTypeNames = Record<string, string>;

/** Loads the tenant's outlet type display names. Never throws; {} when unavailable (the codes are shown instead). */
export async function loadOutletTypeNames(): Promise<OutletTypeNames> {
  try {
    const r = await salesImportApi.segmentOptions();
    if (!r?.success || !r.data) return {};
    return Object.fromEntries(r.data.outletTypes.filter((t) => t.code && t.name).map((t) => [t.code, t.name]));
  } catch {
    return {};
  }
}

/** The outlet type display names, loaded once per mounted screen. */
export function useOutletTypeNames(): OutletTypeNames {
  const [names, setNames] = useState<OutletTypeNames>({});
  useEffect(() => {
    let cancelled = false;
    void loadOutletTypeNames().then((n) => { if (!cancelled) setNames(n); });
    return () => { cancelled = true; };
  }, []);
  return names;
}

/** Loads the column mapping's product columns (for "SKU group 500" wording). Never throws; [] when unavailable. */
export async function loadDimensionLabels(): Promise<SalesDimensionMapping[]> {
  try {
    const r = await salesImportApi.getProfile();
    return r.success && r.data ? r.data.dimensions : [];
  } catch {
    return [];
  }
}

/** The product columns of the mapping, loaded once per mounted screen. */
export function useDimensionLabels(): SalesDimensionMapping[] {
  const [dims, setDims] = useState<SalesDimensionMapping[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadDimensionLabels().then((d) => { if (!cancelled) setDims(d); });
    return () => { cancelled = true; };
  }, []);
  return dims;
}

/** "skuGroup" → "sku group" (fallback when the mapping's label is not known). */
function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Keys of a product in the mapping's column order (unknown keys after, in their own order). */
function orderedKeys(p: DimMatch, dims: SalesDimensionMapping[]): string[] {
  const known = dims.map((d) => d.key).filter((k) => k in p);
  return [...known, ...Object.keys(p).filter((k) => !known.includes(k))];
}

/**
 * A product in words: {brand:'ADHO', skuGroup:'500'} → "ADHO, SKU group 500"; brand only {brand:'CNO'} →
 * "all CNO products". The first column's value is shown bare (it is the brand), the others with their label.
 */
export function describeProduct(p: DimMatch, dims: SalesDimensionMapping[]): string {
  const keys = orderedKeys(p, dims).filter((k) => String(p[k] ?? '').trim() !== '');
  if (keys.length === 0) return 'all products';
  if (keys.length === 1) return `all ${p[keys[0]]} products`;
  const label = (k: string) => dims.find((d) => d.key === k)?.label ?? humanizeKey(k);
  return [p[keys[0]], ...keys.slice(1).map((k) => `${label(k)} ${p[k]}`)].join(', ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** A plain number with Indian grouping — only when the payload does not say the KPI's measure (older server). */
function formatPlain(v: number): string {
  return v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

/** A value in the KPI's own unit (₹ / cases / products); a plain number when the measure is missing. */
function formatInMeasure(v: number, measure: SalesKpiMeasure | undefined): string {
  return measure ? formatKpiValue(v, measure) : formatPlain(v);
}

function SampleCodes({ codes, total, label }: { codes: string[]; total: number; label: string }) {
  if (codes.length === 0) return null;
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer text-[11px] underline decoration-dotted">
        {label}{total > codes.length ? ` (first ${formatCount(codes.length)} of ${formatCount(total)})` : ''}
      </summary>
      <p className="mt-1 font-mono text-[11px] break-words">{codes.join(', ')}</p>
    </details>
  );
}

function Notice({ tone, children, testId }: { tone: 'amber' | 'red' | 'gray'; children: React.ReactNode; testId?: string }) {
  const cls = {
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    red: 'bg-red-50 border-red-200 text-red-800',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
  }[tone];
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} data-testid={testId}
      className={`rounded-lg border px-3 py-2 text-xs flex gap-1.5 ${cls}`}>
      {tone === 'gray' ? <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

type AcceptAction = { kind: 'accept' | 'undo'; kpiCode: string; key: string };

/** "XYZ (Focus Brand 2)" — the token with its KPI, so a screen reader can tell same-named buttons apart. */
function tokenWithKpi(token: string, kpiLabel: string): string {
  return `${token} (${kpiLabel})`;
}

/** Attributes that let the panel find a token's chip again after a refresh (to put keyboard focus back on it). */
function chipAttrs(kpiCode: string, key: string) {
  return { 'data-focus-chip': '', 'data-focus-kpi': kpiCode, 'data-focus-key': key, tabIndex: -1 } as const;
}

/** Long names / products wrap anywhere instead of widening the table (M7). */
const CHIP_TEXT = 'min-w-0 [overflow-wrap:anywhere]';

function TokenChip({
  t, kpiCode, kpiLabel, dims, canChange, pending, onAction,
}: {
  t: FocusTokenResolution; kpiCode: string; kpiLabel: string; dims: SalesDimensionMapping[]; canChange: boolean;
  pending: AcceptAction | null; onAction(a: AcceptAction): void;
}) {
  const busy = pending !== null;
  const mine = pending?.kpiCode === kpiCode && pending.key === t.key;
  const testId = `focus-token-${kpiCode}-${t.key}`;
  if (t.status === 'MATCHED') {
    return (
      <span data-testid={testId} data-status="MATCHED"
        className={`inline-flex items-center text-[11px] rounded border px-1.5 py-0.5 bg-emerald-50 text-emerald-800 border-emerald-200 ${CHIP_TEXT}`}>
        <strong className="font-semibold">{t.token}</strong>&nbsp;→ {t.product ? describeProduct(t.product, dims) : 'a known product'}
      </span>
    );
  }
  if (t.status === 'AMBIGUOUS') {
    const options = (t.candidates ?? []).map((c) => describeProduct(c, dims));
    return (
      <span data-testid={testId} data-status="AMBIGUOUS"
        className={`inline-flex flex-wrap items-center text-[11px] rounded border px-1.5 py-0.5 bg-red-50 text-red-800 border-red-200 ${CHIP_TEXT}`}>
        <XCircle className="w-3 h-3 mr-0.5" />
        <strong className="font-semibold">{t.token}</strong>&nbsp;could mean more than one product
        {options.length > 0 ? `: ${options.join(' · or ')}` : ''}. Fix the name in the target file.
      </span>
    );
  }
  if (t.accepted) {
    return (
      <span data-testid={testId} data-status="ACCEPTED" {...chipAttrs(kpiCode, t.key)}
        className={`inline-flex flex-wrap items-center gap-1 text-[11px] rounded border px-1.5 py-0.5 bg-gray-100 text-gray-700 border-gray-200 ${CHIP_TEXT}`}>
        <span>
          <strong className="font-semibold">{t.token}</strong> — accepted as not sold yet by {t.accepted.byName} on{' '}
          {dateTimeLabel(t.accepted.at)} (counts as 0)
        </span>
        {canChange && (
          <Button size="sm" variant="ghost" className="!px-1.5 !py-0 text-[11px]" disabled={busy} loading={mine}
            onClick={() => onAction({ kind: 'undo', kpiCode, key: t.key })}
            aria-label={`Undo accepting ${tokenWithKpi(t.token, kpiLabel)} as not sold yet`}>
            <Undo2 className="w-3 h-3" /> Undo
          </Button>
        )}
      </span>
    );
  }
  return (
    <span data-testid={testId} data-status="UNMATCHED" {...chipAttrs(kpiCode, t.key)}
      className={`inline-flex flex-wrap items-center gap-1 text-[11px] rounded border px-1.5 py-0.5 bg-red-50 text-red-800 border-red-200 ${CHIP_TEXT}`}>
      <span><XCircle className="inline w-3 h-3 mr-0.5 -mt-0.5" /><strong className="font-semibold">{t.token}</strong> — not found in sales data</span>
      {canChange && (
        <Button size="sm" variant="outline" className="!px-1.5 !py-0 text-[11px] bg-white" disabled={busy} loading={mine}
          onClick={() => onAction({ kind: 'accept', kpiCode, key: t.key })}
          aria-label={`Accept ${tokenWithKpi(t.token, kpiLabel)} as not sold yet`}>
          Accept — not sold yet
        </Button>
      )}
    </span>
  );
}

/** "4,079 Retailer · 38 outlets without a type" — display names where known, else the code. */
export function outletsByTypeText(n: Pick<FocusNameSummary, 'outletsByType'>, typeNames: OutletTypeNames = {}): string {
  const parts = Object.entries(n.outletsByType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => (type
      ? `${formatCount(count)} ${typeNames[type] || type}`
      : `${formatCount(count)} ${count === 1 ? 'outlet' : 'outlets'} without a type`));
  return parts.join(' · ');
}

function FocusKpiSection({
  k, fallbackMeasure, dims, typeNames, canChange, pending, onAction,
}: {
  k: MonthFocusKpi; fallbackMeasure: SalesKpiMeasure | undefined; dims: SalesDimensionMapping[];
  typeNames: OutletTypeNames; canChange: boolean;
  pending: AcceptAction | null; onAction(a: AcceptAction): void;
}) {
  const measure = k.measure ?? fallbackMeasure;
  const kpiLabel = k.label || k.kpiCode;
  return (
    <div className="space-y-1.5 min-w-0" data-testid={`focus-kpi-${k.kpiCode}`}>
      <p className="text-xs font-semibold text-gray-800" data-testid={`focus-kpi-title-${k.kpiCode}`}>{kpiLabel}</p>
      {k.names.length === 0 ? (
        <p className="text-xs text-gray-500">No outlet has a product name for this KPI in the target file this month.</p>
      ) : (
        // table-fixed + w-full: the table takes the width it is given and wraps inside it, so it never widens the
        // month row (or the page) — long names and chips wrap instead (M7).
        <table className="text-xs w-full table-fixed" data-testid={`focus-table-${k.kpiCode}`}>
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-2 font-medium w-[24%]">Name in the target file</th>
              <th className="py-1 pr-2 font-medium w-[18%]">Outlets</th>
              <th className="py-1 pr-2 font-medium">Products it counts</th>
              <th className="py-1 pr-2 font-medium text-right w-[16%]">Achieved</th>
              <th className="py-1 font-medium text-right w-[12%]">Outlets at 0</th>
            </tr>
          </thead>
          <tbody>
            {k.names.map((n) => (
              <tr key={n.key} className="border-t border-gray-100 align-top" data-testid={`focus-name-${k.kpiCode}-${n.key}`}>
                <td className="py-1 pr-2 font-medium text-gray-900 max-w-[16rem] break-words [overflow-wrap:anywhere]"
                  data-testid="focus-name-cell">{n.name}</td>
                <td className="py-1 pr-2 text-gray-700 break-words">
                  {formatCount(n.outlets)}
                  {Object.keys(n.outletsByType).length > 0 && (
                    <span className="block text-[11px] text-gray-500">{outletsByTypeText(n, typeNames)}</span>
                  )}
                </td>
                <td className="py-1 pr-2 min-w-0">
                  <div className="flex flex-wrap gap-1 min-w-0">
                    {n.tokens.map((t) => (
                      <TokenChip key={t.key} t={t} kpiCode={k.kpiCode} kpiLabel={kpiLabel} dims={dims} canChange={canChange}
                        pending={pending} onAction={onAction} />
                    ))}
                  </div>
                </td>
                <td className="py-1 pr-2 text-right [overflow-wrap:anywhere]">{formatInMeasure(n.achieved.total, measure)}</td>
                <td className="py-1 text-right">{formatCount(n.achieved.outletsZero)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {k.missingName.outlets > 0 && (
        <div className="text-xs text-red-700" data-testid={`focus-missing-name-${k.kpiCode}`}>
          <p className="flex gap-1"><XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {plural(k.missingName.outlets, 'outlet has', 'outlets have')} a target for this KPI but no product name in the
            target file. Add the names and upload the target file again.
          </p>
          <SampleCodes codes={k.missingName.sampleOutletCodes} total={k.missingName.outlets} label="Show outlet codes" />
        </div>
      )}
    </div>
  );
}

function BlockerList({
  month, blockers, kpiLabels, canChange, pending, onAction,
}: {
  month: string; blockers: FocusBlocker[]; kpiLabels: Record<string, string>; canChange: boolean;
  pending: AcceptAction | null; onAction(a: AcceptAction): void;
}) {
  const busy = pending !== null;
  // role="status" (polite), not "alert": a preview with N blocked months must not fire N assertive announcements.
  return (
    <div role="status" data-testid={`recon-blockers-${month}`}
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-1.5">
      <p className="font-semibold flex gap-1.5">
        <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        {monthLabel(month)} can&apos;t be applied until {blockers.length === 1 ? 'this is' : 'these are'} fixed:
      </p>
      <ul className="space-y-1 pl-5 list-disc">
        {blockers.map((b, i) => (
          <li key={`${b.code}-${b.kpiCode}-${b.key ?? i}`} data-testid="recon-blocker" className="[overflow-wrap:anywhere]">
            {/* The server's message already says how many outlets: nothing is appended here. */}
            {sentence(b.message)}.
            {canChange && b.code === 'FOCUS_UNMATCHED' && b.key && (
              <Button size="sm" variant="outline" className="ml-1.5 !px-1.5 !py-0 text-[11px] bg-white" disabled={busy}
                loading={pending?.kpiCode === b.kpiCode && pending.key === b.key}
                onClick={() => onAction({ kind: 'accept', kpiCode: b.kpiCode, key: b.key! })}
                data-testid={`recon-blocker-accept-${b.kpiCode}-${b.key}`}
                aria-label={`Accept ${tokenWithKpi(b.token ?? b.key, kpiLabels[b.kpiCode] || b.kpiCode)} as not sold yet`}>
                Accept — not sold yet
              </Button>
            )}
            <SampleCodes codes={b.sampleOutletCodes} total={b.outlets} label="Show outlet codes" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MonthReconciliationPanel({
  month, reconciliation: r, measures = {}, dims = [], typeNames = {}, canAct, monthOpen, expanded = true, onRefresh,
  refreshHint = 'press Refresh preview before applying',
}: {
  month: string;
  reconciliation: MonthReconciliation | null | undefined;
  /**
   * Fallback only, for an older server: kpiCode -> measure. The payload's own `MonthFocusKpi.measure` and
   * `targets.kpis[].measure` are used whenever present.
   */
  measures?: Record<string, SalesKpiMeasure>;
  /** The mapping's product columns, for "ADHO, SKU group 500" wording. */
  dims?: SalesDimensionMapping[];
  /** Outlet type code -> display name ("Retailer" instead of RETAILER). */
  typeNames?: OutletTypeNames;
  /** What to do when the refresh after Accept / Undo did not land, e.g. "press Refresh preview before applying". */
  refreshHint?: string;
  /** Holds targets:upload (may accept / undo). */
  canAct: boolean;
  /** Acceptances can only change for an OPEN month. */
  monthOpen: boolean;
  /** false → only the blockers and the amber notices (the month row is collapsed). */
  expanded?: boolean;
  /** Re-fetch the preview; resolves true when the refreshed preview landed. */
  onRefresh(): Promise<boolean>;
}) {
  const [pending, setPending] = useState<AcceptAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** After Accept / Undo: the token whose (replaced) chip gets keyboard focus once the refreshed preview rendered. */
  const [focusAfter, setFocusAfter] = useState<{ kpiCode: string; key: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusAfter) return;
    const root = rootRef.current;
    setFocusAfter(null);
    if (!root) return;
    const chip = Array.from(root.querySelectorAll<HTMLElement>('[data-focus-chip]'))
      .find((el) => el.dataset.focusKpi === focusAfter.kpiCode && el.dataset.focusKey === focusAfter.key);
    const button = chip?.querySelector<HTMLButtonElement>('button:not([disabled])');
    (button ?? chip ?? root).focus();
  }, [focusAfter, r]);

  if (!r) return null;

  const hasFocus = r.focus.length > 0;
  const canChange = canAct && monthOpen;
  const { targets, gaps } = r;
  const noTargets = targets.targetUploadedAt === null;
  // Blockers are never hidden behind a collapsed row, and neither is the section that resolves them.
  const showFocus = hasFocus && (expanded || reconciliationNeedsAttention(r));
  const kpiLabels: Record<string, string> = {};
  for (const k of [...targets.kpis, ...r.focus]) if (k.label) kpiLabels[k.kpiCode] = k.label;

  async function act(a: AcceptAction) {
    if (pending) return;
    setPending(a);
    setError(null);
    const res = a.kind === 'accept'
      ? await salesImportApi.acceptFocusToken(month, { kpiCode: a.kpiCode, key: a.key })
      : await salesImportApi.undoFocusAcceptance(month, a.kpiCode, a.key);
    // Refresh either way: after a refusal (month closed, token now matched, …) the screen is usually out of date.
    // Only say it was reloaded when the reload actually landed.
    const refreshed = await onRefresh();
    setPending(null);
    setFocusAfter({ kpiCode: a.kpiCode, key: a.key });
    if (!res.success) {
      // No definite answer (timeout / 5xx / network): it may have been saved — the reloaded preview shows the truth.
      setError(outcomeUnknown(res)
        ? `We couldn’t confirm whether this was ${a.kind === 'accept' ? 'accepted' : 'undone'}: ${noAnswerReason(res)}. ` +
          (refreshed ? 'The preview has been reloaded and shows what is saved now — check it before trying again.'
            : `The preview could not be refreshed — ${refreshHint}.`)
        : `${a.kind === 'accept' ? 'Not accepted' : 'Not undone'}: ${reasonOr(res.error, 'the request failed')}. ` +
          (refreshed ? 'The preview has been reloaded.' : `The preview could not be refreshed — ${refreshHint}.`));
      return;
    }
    if (!refreshed) {
      setError(`${a.kind === 'accept' ? 'Accepted' : 'Undone'}, but the preview could not be refreshed — ${refreshHint}.`);
    }
  }
  const onAction = (a: AcceptAction) => { void act(a); };

  const focusSection = showFocus && (
    <div className="space-y-3 min-w-0" data-testid={`recon-focus-${month}`}>
      <div>
        <p className="text-xs font-semibold text-gray-800">Focus brands</p>
        <p className="text-[11px] text-gray-500">
          Each outlet counts the products written for the KPI in this month&apos;s target file.
          {canChange
            ? ' A name that is not in the sales data blocks applying; if the product simply has not sold yet, accept it — it then counts as 0.'
            : ''}
        </p>
      </div>
      {r.focus.map((k) => (
        <FocusKpiSection key={k.kpiCode} k={k} fallbackMeasure={measures[k.kpiCode]} dims={dims} typeNames={typeNames}
          canChange={canChange} pending={pending} onAction={onAction} />
      ))}
    </div>
  );

  const noticeNoTargets = hasFocus && noTargets && (
    <Notice tone="amber" testId="recon-no-targets">
      No targets uploaded for this month yet — focus KPIs are not calculated. Upload targets, then recalculate.
    </Notice>
  );
  const noticeNewer = targets.newerThanLastApply && (
    <Notice tone="amber" testId="recon-targets-newer">
      Targets were uploaded after this month was last applied — apply again (or Recalculate) to use them.
    </Notice>
  );

  return (
    <div className="space-y-3 min-w-0 outline-none" data-testid={`month-recon-${month}`} ref={rootRef} tabIndex={-1}>
      {r.blockers.length > 0 && (
        <BlockerList month={month} blockers={r.blockers} kpiLabels={kpiLabels} canChange={canChange}
          pending={pending} onAction={onAction} />
      )}
      {noticeNoTargets}
      {noticeNewer}
      {error && <Notice tone="red" testId="recon-action-error">{error}</Notice>}

      {expanded && (
        <>
          <div className="space-y-1" data-testid={`recon-targets-${month}`}>
            <p className="text-xs font-semibold text-gray-800">Targets</p>
            {noTargets ? (
              !hasFocus && <p className="text-xs text-gray-500">No targets uploaded for {monthLabel(month)} yet.</p>
            ) : (
              <>
                <p className="text-[11px] text-gray-500">Targets last uploaded {dateTimeLabel(targets.targetUploadedAt)}.</p>
                {targets.kpis.length > 0 && (
                  <ul className="text-xs text-gray-700 space-y-0.5">
                    {targets.kpis.map((k) => (
                      <li key={k.kpiCode} data-testid={`recon-target-${k.kpiCode}`}>
                        <span className="font-medium">{k.label || k.kpiCode}</span>: targets for{' '}
                        {plural(k.outletsWithTarget, 'outlet')} (total {formatInMeasure(k.totalTarget, k.measure ?? measures[k.kpiCode])})
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {focusSection}

          {(gaps.targetNoSales.outlets > 0 || gaps.salesNoTarget.outlets > 0) && (
            <div className="space-y-1 text-xs text-gray-600" data-testid={`recon-gaps-${month}`}>
              <p className="text-xs font-semibold text-gray-800">For your information</p>
              {gaps.targetNoSales.outlets > 0 && (
                <div data-testid="recon-gap-target-no-sales">
                  {plural(gaps.targetNoSales.outlets, 'outlet has', 'outlets have')} a target but no sales this month.
                  <SampleCodes codes={gaps.targetNoSales.sampleOutletCodes} total={gaps.targetNoSales.outlets} label="Show outlet codes" />
                </div>
              )}
              {gaps.salesNoTarget.outlets > 0 && (
                <div data-testid="recon-gap-sales-no-target">
                  {plural(gaps.salesNoTarget.outlets, 'outlet has', 'outlets have')} sales but no target this month.
                  <SampleCodes codes={gaps.salesNoTarget.sampleOutletCodes} total={gaps.salesNoTarget.outlets} label="Show outlet codes" />
                </div>
              )}
            </div>
          )}
        </>
      )}
      {!expanded && focusSection}
    </div>
  );
}

/** The amber/red facts that should open a collapsed month row by themselves. */
export function reconciliationNeedsAttention(r: MonthReconciliation | null | undefined): boolean {
  if (!r) return false;
  return r.blockers.length > 0 || r.targets.newerThanLastApply || (r.focus.length > 0 && r.targets.targetUploadedAt === null)
    || (r.notCalculated?.length ?? 0) > 0;
}
