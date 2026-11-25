'use client';

/**
 * Credits upload — "Before you confirm" (owner rule: no silent failure, every tenant).
 *
 * Every category of row that will NOT be applied as typed is listed with its rows and needs its own tick before
 * Confirm & Credit is enabled; the ticked categories are sent with the confirm (`acknowledged`) and the server refuses
 * a confirm that leaves a present category unticked. A clean file has no section and confirms exactly as before.
 *
 * Data: POST /api/admin/credits/upload-preview { outletCodes, period, lines } (every tenant, whenever the file has OK
 * POINTS rows) → { deductionsEnabled, outlets[], priorDeductions[] }.
 */
import { AlertTriangle, RotateCcw, XCircle } from 'lucide-react';
import type { CreditParseResult, CreditUploadRow } from '@/types';
import { PANEL_LIMIT, deductionAmountText, fmtSignedPts, isDeductionRow } from './deductions-panel';
import { ROUNDING_COPY, roundedAmountText, roundedRows } from './rounded-amounts-panel';

// ─── Contract ────────────────────────────────────────────────────────────────

export type AckCategory = 'SKIPPED' | 'ROUNDED' | 'NOT_APPLIED' | 'BELOW_ZERO' | 'REPEAT_DEDUCTION';
export const ACK_ORDER: AckCategory[] = ['SKIPPED', 'ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'REPEAT_DEDUCTION'];

export interface UploadPreviewOutlet {
  outletCode:         string;
  found:              boolean;
  linked:             boolean;
  walletId:           string | null;
  partnerId:          string | null;
  balance:            number | null;
  /**
   * PARTNER-level held opening balance (summed over the partner's outlets) — non-null only when it will actually post
   * first at confirm (wallet missing or empty). Counted ONCE per wallet.
   */
  heldOpeningBalance: number | null;
  /** Points that will expire (due, not yet swept) before the deduction — the preview's current = balance − dueExpiry. */
  dueExpiry?:         number;
  /** Deductions only: the wallet is prepared. Ignored for credits. */
  ready:              boolean;
  reason:             string | null;
  code:               string | null;
}

export interface PriorDeduction {
  outletCode:  string;
  fieldId:     string;
  batchId:     string;
  batchCode:   string;
  confirmedAt: string;
  /** Points STILL deducted (net of give-backs; fully undone deductions are omitted by the server). */
  points:      number;
  givenBack?:  number;
}

export interface UploadPreviewData {
  deductionsEnabled: boolean;
  /**
   * The categories THIS client must acknowledge (decided by the server in one place). A present category outside the
   * list is shown for information only, without a box.
   */
  ackCategories:     AckCategory[];
  outlets:           UploadPreviewOutlet[];
  priorDeductions:   PriorDeduction[];
}

export type UploadPreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: UploadPreviewData };

const isOkPointsRow = (r: CreditUploadRow) => r.status === 'OK' && r.awardType === 'POINTS';

/** The request body, or null when the file has no OK POINTS rows (a PAYOUT-only file needs no preview). */
export function previewRequestBody(rows: CreditUploadRow[], period: string):
  { outletCodes: string[]; period: string; lines: { outletCode: string; fieldId: string }[] } | null {
  const pts = rows.filter(isOkPointsRow);
  if (pts.length === 0) return null;
  return {
    outletCodes: [...new Set(pts.map((r) => r.outletId))],
    period,
    lines: rows.filter(isDeductionRow).map((r) => ({ outletCode: r.outletId, fieldId: r.fieldId })),
  };
}

// ─── Derivations ─────────────────────────────────────────────────────────────

const outletMap = (d: UploadPreviewData) => new Map(d.outlets.map((o) => [o.outletCode, o]));

export interface NotAppliedRow { row: CreditUploadRow; reason: string }

/** OK POINTS rows the server will not apply: outlet not found / not linked (or missing from the reply). */
export function notAppliedRows(rows: CreditUploadRow[], d: UploadPreviewData): NotAppliedRow[] {
  const byCode = outletMap(d);
  const out: NotAppliedRow[] = [];
  for (const r of rows.filter(isOkPointsRow)) {
    const o = byCode.get(r.outletId);
    if (!o) out.push({ row: r, reason: "The server check didn't return this outlet — it may not be applied." });
    else if (!o.found) out.push({ row: r, reason: o.reason ?? 'Outlet not found.' });
    else if (!o.linked) out.push({ row: r, reason: o.reason ?? 'Outlet is not linked to a partner (onboard / KYC it first).' });
  }
  return out;
}

const applies = (o: UploadPreviewOutlet | undefined): o is UploadPreviewOutlet => !!o && o.found && o.linked;

export interface WalletLine {
  key:         string;
  outletCodes: string[];
  /** balance − points expiring now + held opening balance (what the wallet holds when the rows apply). */
  current:     number;
  held:        number | null;
  /** Points expiring now (due, not yet swept) — already taken off `current`. */
  dueExpiry:   number;
  after:       number;
}

/** The wallet a row lands in, as the server groups it: the wallet, else the partner (the wallet confirm creates). */
const walletKey = (o: UploadPreviewOutlet) =>
  o.walletId ? o.walletId : o.partnerId ? `partner:${o.partnerId}` : `outlet:${o.outletCode}`;

/**
 * One line per WALLET that this file deducts from (outlets of one partner share a wallet; outlets without a wallet yet
 * group by partner — the wallet confirm will create — at 0). current = balance − points expiring now + the held opening
 * balance (partner-level, counted ONCE); after = current + the file's credits − its deductions for that wallet.
 */
export function walletLines(rows: CreditUploadRow[], d: UploadPreviewData): WalletLine[] {
  const byCode = outletMap(d);
  type G = { codes: string[]; balance: number; held: number | null; dueExpiry: number; net: number; deducts: boolean };
  const groups = new Map<string, G>();
  for (const r of rows.filter(isOkPointsRow)) {
    const o = byCode.get(r.outletId);
    if (!applies(o)) continue;
    const key = walletKey(o);
    let g = groups.get(key);
    if (!g) {
      g = { codes: [], balance: o.balance ?? 0, held: null, dueExpiry: 0, net: 0, deducts: false };
      groups.set(key, g);
    }
    if (!g.codes.includes(o.outletCode)) {
      g.codes.push(o.outletCode);
      // Wallet / partner-level figures repeated on each outlet → taken once, never summed.
      if (g.held == null && o.heldOpeningBalance != null) g.held = o.heldOpeningBalance;
      g.dueExpiry = Math.max(g.dueExpiry, Math.max(0, o.dueExpiry ?? 0));
    }
    g.net += r.amount;
    if (r.amount < 0) g.deducts = true;
  }
  const out: WalletLine[] = [];
  for (const [key, g] of groups) {
    if (!g.deducts) continue;
    const current = g.balance - g.dueExpiry + (g.held ?? 0);
    out.push({ key, outletCodes: g.codes, current, held: g.held, dueExpiry: g.dueExpiry, after: current + g.net });
  }
  return out;
}

export interface RepeatRow { row: CreditUploadRow; prior: PriorDeduction }

/** Deduction rows that already have a deduction for the same outlet + field (the server filters the period). */
export function repeatDeductionRows(rows: CreditUploadRow[], d: UploadPreviewData): RepeatRow[] {
  const out: RepeatRow[] = [];
  for (const r of rows.filter(isDeductionRow)) {
    const prior = d.priorDeductions.find((p) => p.outletCode === r.outletId && p.fieldId === r.fieldId);
    if (prior) out.push({ row: r, prior });
  }
  return out;
}

/** Deduction outlets whose wallet isn't prepared → the server refuses the WHOLE confirm (no tick overrides). */
export function notReadyOutlets(rows: CreditUploadRow[], d: UploadPreviewData): UploadPreviewOutlet[] {
  const byCode = outletMap(d);
  const codes = [...new Set(rows.filter(isDeductionRow).map((r) => r.outletId))];
  return codes.map((c) => byCode.get(c)).filter((o): o is UploadPreviewOutlet => applies(o) && !o.ready);
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const n = (x: number) => x.toLocaleString('en-IN');
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
const rowRef = (r: CreditUploadRow) => `Row ${r.rowNum} · ${r.outletId} · ${r.fieldName}`;

export interface CategoryItem { key: string; text: string; detail?: string }
export interface CategoryInfo {
  category:     AckCategory;
  count:        number;
  title:        string;
  description?: string;
  /** The checkbox text ("I understand …"). */
  label:        string;
  /** This client must tick it (server `ackCategories`); false = listed for information only, no box. */
  required:     boolean;
  items:        CategoryItem[];
}

/**
 * Every PRESENT category, in a fixed order. Preview-based ones only once the preview answered. `required` comes from
 * the server's ackCategories; without a preview answer (a PAYOUT-only file needs none) every category is required.
 */
export function presentCategories(pr: CreditParseResult, preview: UploadPreviewData | null): CategoryInfo[] {
  const ack = new Set<AckCategory>(preview ? preview.ackCategories : ACK_ORDER);
  const out: CategoryInfo[] = [];
  const push = (c: Omit<CategoryInfo, 'required'>) => out.push({ ...c, required: ack.has(c.category) });
  const skipped = pr.rows.filter((r) => r.status === 'SKIP');
  if (skipped.length > 0) {
    push({
      category: 'SKIPPED', count: skipped.length,
      title: `${plural(skipped.length, 'row', 'rows')} will not be credited`,
      label: `I understand ${plural(skipped.length, 'row', 'rows')} will not be credited (blank, zero or not applicable)`,
      items: skipped.map((r) => ({ key: `s|${r.rowNum}|${r.fieldId}`, text: rowRef(r), detail: r.skipReason })),
    });
  }
  const rounded = roundedRows(pr.rows);
  if (rounded.length > 0) {
    push({
      category: 'ROUNDED', count: rounded.length,
      title: `${plural(rounded.length, 'row', 'rows')} rounded to whole units`,
      description: ROUNDING_COPY,
      label: `I understand ${plural(rounded.length, 'row was', 'rows were')} rounded to whole units`,
      items: rounded.map((r) => ({ key: `r|${r.rowNum}|${r.fieldId}`, text: rowRef(r), detail: roundedAmountText(r) })),
    });
  }
  if (!preview) return out;

  const na = notAppliedRows(pr.rows, preview);
  if (na.length > 0) {
    push({
      category: 'NOT_APPLIED', count: na.length,
      title: `${plural(na.length, 'row', 'rows')} won't be credited or deducted`,
      label: `I understand ${plural(na.length, 'row', 'rows')} won't be applied (outlet not found or not linked)`,
      items: na.map(({ row, reason }) => ({ key: `n|${row.rowNum}|${row.fieldId}`, text: rowRef(row), detail: reason })),
    });
  }
  const below = walletLines(pr.rows, preview).filter((w) => w.after < 0);
  if (below.length > 0) {
    push({
      category: 'BELOW_ZERO', count: below.length,
      title: `${plural(below.length, 'wallet', 'wallets')} will go below zero`,
      description: "A wallet below zero is repaid from the outlet's future earnings; the outlet can't redeem until its balance is 0 or more.",
      label: `I understand ${plural(below.length, 'wallet', 'wallets')} will go below zero`,
      items: below.map((w) => ({
        key: `z|${w.key}`,
        text: `${w.outletCodes.join(', ')} · Balance will go below zero: ${fmtSignedPts(w.current)} → ${fmtSignedPts(w.after)} pts`,
        detail: [
          w.held != null ? `(includes a held opening balance of ${fmtSignedPts(w.held)} that posts first)` : '',
          w.dueExpiry > 0 ? `(includes ${n(w.dueExpiry)} points expiring now)` : '',
        ].filter(Boolean).join(' ') || undefined,
      })),
    });
  }
  const repeats = repeatDeductionRows(pr.rows, preview);
  if (repeats.length > 0) {
    push({
      category: 'REPEAT_DEDUCTION', count: repeats.length,
      title: `${plural(repeats.length, 'deduction', 'deductions')} may be a repeat`,
      label: `I understand ${plural(repeats.length, 'deduction', 'deductions')} may be a repeat`,
      items: repeats.map(({ row, prior }) => ({
        key: `p|${row.rowNum}|${row.fieldId}`,
        text: `${rowRef(row)} · ${deductionAmountText(row)}`,
        detail: `Already deducted on ${day(prior.confirmedAt)} in batch ${prior.batchCode} (${n(Math.abs(prior.points))} pts still deducted) — check this isn't a repeat.`,
      })),
    });
  }
  return out;
}

const SERVER_ONLY_TEXT: Record<AckCategory, string> = {
  SKIPPED:          'some rows will not be credited',
  ROUNDED:          'some rows were rounded to whole units',
  NOT_APPLIED:      "some rows won't be applied (outlet not found or not linked)",
  BELOW_ZERO:       'some wallets will go below zero',
  REPEAT_DEDUCTION: 'some deductions may be a repeat',
};

/**
 * U1: after a refused confirm the server's `missingAcknowledgements` must each get a box — a present category is made
 * required; one this screen can't list (e.g. the server's balance moved) gets its own box with the server's finding.
 */
export function withServerRequired(categories: CategoryInfo[], serverRequired: AckCategory[]): CategoryInfo[] {
  if (serverRequired.length === 0) return categories;
  const out = categories.map((c) => (serverRequired.includes(c.category) ? { ...c, required: true } : c));
  for (const cat of ACK_ORDER) {
    if (!serverRequired.includes(cat) || out.some((c) => c.category === cat)) continue;
    out.push({
      category: cat, count: 0, required: true, items: [],
      title: `The server found that ${SERVER_ONLY_TEXT[cat]}`,
      description: 'The confirm found this after the check above was made — see Payout Status after confirming for the rows.',
      label: `I understand ${SERVER_ONLY_TEXT[cat]}`,
    });
  }
  return out.sort((a, b) => ACK_ORDER.indexOf(a.category) - ACK_ORDER.indexOf(b.category));
}

// ─── UI ──────────────────────────────────────────────────────────────────────

/** "Checking wallet balances…" / the failed-check error with "Check again". Renders nothing otherwise. */
export function UploadPreviewStatus({ state, onRetry }: { state: UploadPreviewState | null; onRetry: () => void }) {
  if (!state || state.status === 'ok') return null;
  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3" data-testid="credits-preview-status">
        <p className="text-xs text-gray-600 animate-pulse">Checking wallet balances…</p>
      </div>
    );
  }
  return (
    <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-2" data-testid="credits-preview-status">
      <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-2">
        <p className="text-xs text-red-800">
          Couldn&apos;t check wallet balances — {state.message} Confirm stays off until the check succeeds. If a wallet
          isn&apos;t prepared for deductions, the whole confirm is refused.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-red-300 text-red-700 bg-white rounded-lg hover:bg-red-50"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Check again
        </button>
      </div>
    </div>
  );
}

/** Red, no-tick-overrides list of deduction outlets whose wallet isn't prepared. */
export function NotReadyPanel({ outlets }: { outlets: UploadPreviewOutlet[] }) {
  if (outlets.length === 0) return null;
  return (
    <div className="bg-white rounded-xl border border-red-200 overflow-hidden" data-testid="credits-not-ready">
      <div className="px-4 py-3 bg-red-50 border-b border-red-100">
        <p className="text-xs font-semibold text-red-800 flex items-center gap-2">
          <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
          {plural(outlets.length, 'wallet', 'wallets')} not prepared for deductions — the confirm would be refused
        </p>
      </div>
      <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
        {outlets.slice(0, PANEL_LIMIT).map((o) => (
          <p key={o.outletCode} className="px-4 py-2.5 text-xs text-red-700" data-testid="credits-deduction-blocked">
            <span className="font-medium">{o.outletCode}</span> · {o.reason ?? 'wallet not prepared for deductions'} — confirm will be refused
          </p>
        ))}
        {outlets.length > PANEL_LIMIT && (
          <p className="px-4 py-2 text-xs text-red-700">…and {outlets.length - PANEL_LIMIT} more — see the downloaded report.</p>
        )}
      </div>
    </div>
  );
}

export function BeforeYouConfirm({
  categories,
  acked,
  onToggle,
  disabled,
}: {
  categories: CategoryInfo[];
  acked:      ReadonlySet<AckCategory>;
  onToggle:   (c: AckCategory) => void;
  disabled?:  boolean;
}) {
  if (categories.length === 0) return null;
  return (
    <section
      aria-labelledby="before-you-confirm-title"
      className="bg-white rounded-xl border border-amber-200 overflow-hidden"
      data-testid="before-you-confirm"
    >
      <div className="px-4 py-3 bg-amber-50 border-b border-amber-100">
        <h3 id="before-you-confirm-title" className="text-sm font-semibold text-amber-900 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Before you confirm
        </h3>
        <p className="text-xs text-amber-800 mt-0.5">
          Some rows won&apos;t be applied exactly as typed. Review each list and tick its box — Confirm switches on when
          every box is ticked.
        </p>
      </div>
      <div className="divide-y divide-amber-100">
        {categories.map((c) => {
          const id = `ack-${c.category}`;
          return (
            <div key={c.category} className="px-4 py-3 space-y-2" data-testid={`ack-block-${c.category}`}>
              <p className="text-xs font-semibold text-gray-900">{c.title}</p>
              {c.description && <p className="text-xs text-gray-600">{c.description}</p>}
              {c.items.length > 0 && (
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-52 overflow-y-auto">
                {c.items.slice(0, PANEL_LIMIT).map((it) => (
                  <li key={it.key} className="px-3 py-2" data-testid={`ack-item-${c.category}`}>
                    <p className="text-xs font-medium text-gray-800 break-words">{it.text}</p>
                    {it.detail && <p className="text-xs text-amber-800 mt-0.5 break-words">{it.detail}</p>}
                  </li>
                ))}
                {c.items.length > PANEL_LIMIT && (
                  <li className="px-3 py-2 text-xs text-gray-600">
                    …and {n(c.items.length - PANEL_LIMIT)} more — see the downloaded report.
                  </li>
                )}
              </ul>
              )}
              {c.required ? (
                <label htmlFor={id} className="flex items-start gap-2 text-xs text-gray-900 cursor-pointer">
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-0.5"
                    checked={acked.has(c.category)}
                    disabled={disabled}
                    onChange={() => onToggle(c.category)}
                  />
                  <span>{c.label}</span>
                </label>
              ) : (
                <p className="text-xs text-gray-600" data-testid={`ack-info-${c.category}`}>For your information — no tick needed.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
