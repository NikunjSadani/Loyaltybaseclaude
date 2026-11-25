'use client';

import { MinusCircle, AlertTriangle, XCircle } from 'lucide-react';
import type { CreditUploadRow } from '@/types';

// Negative POINTS rows become wallet DEDUCTIONS when the tenant setting
// `creditUploadNegativeDeductions` is ON (design: docs/plans/UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md).
// Everything here renders only when the parse actually has deduction rows.

/** An OK POINTS row with a negative amount = a deduction. */
export function isDeductionRow(r: CreditUploadRow): boolean {
  return r.status === 'OK' && r.awardType === 'POINTS' && r.amount < 0;
}

/** "−1,200" for negatives, "1,200" otherwise (en-IN, Unicode minus). */
export function fmtSignedPts(n: number): string {
  return n < 0 ? `−${Math.abs(n).toLocaleString('en-IN')}` : n.toLocaleString('en-IN');
}

/** "−199.5 → −200 pts" when rounded, "−320 pts" otherwise. */
export function deductionAmountText(r: CreditUploadRow): string {
  const rounded = fmtSignedPts(r.amount);
  if (r.originalAmount === undefined) return `${rounded} pts`;
  return `−${Math.abs(r.originalAmount)} → ${rounded} pts`;
}

const PANEL_LIMIT = 20;

/** "Will be deducted" — every OK deduction row (first 20). Renders nothing without deductions. */
export function DeductionsPanel({ rows }: { rows: CreditUploadRow[] }) {
  const deductions = rows.filter(isDeductionRow);
  if (deductions.length === 0) return null;
  const total = deductions.reduce((s, r) => s + Math.abs(r.amount), 0);
  return (
    <div className="bg-white rounded-xl border border-orange-200 overflow-hidden" data-testid="credits-deductions-panel">
      <div className="px-4 py-3 bg-orange-50 border-b border-orange-100">
        <p className="text-xs font-semibold text-orange-800 flex items-center gap-2">
          <MinusCircle className="w-3.5 h-3.5" aria-hidden="true" />
          Will be deducted — {deductions.length} row{deductions.length !== 1 ? 's' : ''} · {total.toLocaleString('en-IN')} pts
        </p>
        <p className="text-xs text-orange-700 mt-0.5">
          Negative points are taken out of the outlet&apos;s wallet on confirm (rounded half-up to whole points).
        </p>
      </div>
      <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
        {deductions.slice(0, PANEL_LIMIT).map((r) => (
          <div key={`${r.rowNum}|${r.fieldId}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-gray-800">
              Row {r.rowNum} · {r.outletId} · {r.fieldName}
            </p>
            <p className="text-xs text-orange-700 tabular-nums whitespace-nowrap" data-testid="credits-deduction-row">
              {deductionAmountText(r)}
            </p>
          </div>
        ))}
        {deductions.length > PANEL_LIMIT && (
          <p className="px-4 py-2 text-xs text-orange-700">
            …and {deductions.length - PANEL_LIMIT} more — see the downloaded report.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Below-zero / readiness call-out (POST /api/admin/credits/deduction-preview) ──────────────

export interface DeductionPreviewOutlet {
  outletCode: string;
  linked:     boolean;
  balance:    number | null;
  ready:      boolean;
  reason:     string | null;
}

export type DeductionPreviewState =
  | { status: 'loading' }
  | { status: 'error' }
  /** The server says negative points are NOT turned on for this program (stale screen settings) — confirm blocked. */
  | { status: 'off'; message: string }
  | { status: 'ok'; outlets: DeductionPreviewOutlet[] };

/** Unique outlet ids of the deduction rows, in file order. */
export function deductionOutletCodes(rows: CreditUploadRow[]): string[] {
  return [...new Set(rows.filter(isDeductionRow).map((r) => r.outletId))];
}

/** A linked outlet whose wallet isn't ready → the server refuses the WHOLE confirm. */
export function blockingOutlets(state: DeductionPreviewState | null): DeductionPreviewOutlet[] {
  if (!state || state.status !== 'ok') return [];
  return state.outlets.filter((o) => o.linked && !o.ready);
}

export interface BelowZeroLine { outletCode: string; current: number; after: number }

/**
 * after = balance + this file's OK POINTS credits for the outlet − this file's deductions for it.
 * Only linked outlets (an unlinked outlet is skipped, nothing is deducted). A null balance on a
 * linked outlet = no wallet yet = 0.
 */
export function belowZeroLines(rows: CreditUploadRow[], outlets: DeductionPreviewOutlet[]): BelowZeroLine[] {
  const net = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'OK' || r.awardType !== 'POINTS') continue;
    net.set(r.outletId, (net.get(r.outletId) ?? 0) + r.amount);
  }
  const lines: BelowZeroLine[] = [];
  for (const o of outlets) {
    if (!o.linked) continue;
    const current = o.balance ?? 0;
    const after = current + (net.get(o.outletCode) ?? 0);
    if (after < 0) lines.push({ outletCode: o.outletCode, current, after });
  }
  return lines;
}

export function DeductionBalanceCallout({
  rows,
  state,
}: {
  rows:  CreditUploadRow[];
  state: DeductionPreviewState | null;
}) {
  if (!state) return null;

  if (state.status === 'loading') {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3" data-testid="credits-deduction-callout">
        <p className="text-xs text-gray-600 animate-pulse">Checking wallet balances…</p>
      </div>
    );
  }

  if (state.status === 'off') {
    return (
      <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-2" data-testid="credits-deduction-callout">
        <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-xs text-red-800">
          {state.message} The negative rows in this file would NOT be deducted, so Confirm is disabled. Reload the page
          and re-upload, or remove the negative values.
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div role="status" className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2" data-testid="credits-deduction-callout">
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-xs text-amber-800">
          Couldn&apos;t check wallet balances — the confirm still deducts; balances may go below zero.
        </p>
      </div>
    );
  }

  const codes    = deductionOutletCodes(rows);
  const returned = new Set(state.outlets.map((o) => o.outletCode));
  const missing  = codes.filter((c) => !returned.has(c));
  const blocked  = blockingOutlets(state);
  const unlinked = state.outlets.filter((o) => !o.linked);
  const below    = belowZeroLines(rows, state.outlets);

  if (blocked.length === 0 && unlinked.length === 0 && below.length === 0 && missing.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden" data-testid="credits-deduction-callout">
      <div className="px-4 py-3 bg-amber-50 border-b border-amber-100">
        <p className="text-xs font-semibold text-amber-800 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          Check before you confirm
        </p>
        {below.length > 0 && (
          <p className="text-xs text-amber-700 mt-0.5">
            A wallet below zero is repaid from the outlet&apos;s future earnings; the outlet can&apos;t redeem until it is back to zero or more.
          </p>
        )}
      </div>
      <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
        {blocked.map((o) => (
          <div key={`b|${o.outletCode}`} className="px-4 py-2.5 flex items-start gap-2" data-testid="credits-deduction-blocked">
            <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-xs text-red-700">
              <span className="font-medium">{o.outletCode}</span> · {o.reason ?? 'wallet not prepared for deductions'} — confirm will be refused
            </p>
          </div>
        ))}
        {unlinked.map((o) => (
          <div key={`u|${o.outletCode}`} className="px-4 py-2.5">
            <p className="text-xs text-amber-800">
              <span className="font-medium">{o.outletCode}</span> · not linked to a partner — will be skipped, NOT deducted
            </p>
          </div>
        ))}
        {below.map((l) => (
          <div key={`z|${l.outletCode}`} className="px-4 py-2.5" data-testid="credits-deduction-below-zero">
            <p className="text-xs text-amber-800">
              <span className="font-medium">{l.outletCode}</span> · Balance will go below zero: {fmtSignedPts(l.current)} → {fmtSignedPts(l.after)}
            </p>
          </div>
        ))}
        {missing.map((c) => (
          <div key={`m|${c}`} className="px-4 py-2.5">
            <p className="text-xs text-amber-800">
              <span className="font-medium">{c}</span> · balance not returned — couldn&apos;t check; the confirm still deducts
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
