'use client';

/**
 * Wallets below zero — audit item 9 + fix rounds 3/4 + owner decisions D1/D2 (2026-11-19, no silent pass-throughs).
 *
 * Every wallet of the tenant whose balance is BELOW ZERO (owner D1 — a wallet at or above zero owes nothing): outlet(s),
 * balance, points owed, and — only when true — the reversal(s) behind its CURRENT negative stretch (decided by the
 * wallet's own movement order on the server). A negative with no reversal behind it is labelled as imported / earlier
 * history. Shown for EVERY tenant that has a negative wallet (owner D2 — e.g. imported negatives on a LEGACY tenant),
 * with a programme filter (same options as the admin dashboards) and an Excel download of the same filtered list.
 * Data: GET /api/admin/credits/reversal-engine/wallets-in-debt[?programName=…&limit=…]. Renders nothing when no wallet is
 * below zero (unfiltered); a failed load says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Wallet } from 'lucide-react';
import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';

export interface DebtSource {
  allocationId?: string;
  creditReversalId: string;
  kind: 'OVER_REVERSAL' | 'DEBT_RESTORED' | 'DEBT_EXPOSED' | 'HISTORICAL_CLAWBACK' | string;
  owedPoints: number;
  debtRestoredPoints: number;
  debtExposedPoints?: number;
  approvedAt: string | null;
  fieldName: string | null;
  period: string | null;
  outletCode?: string | null;
}
export interface DebtWallet {
  walletId: string;
  partnerName: string | null;
  outletCodes: string[];
  balance: number;
  debtPoints: number;
  owedPoints: number;
  sources: DebtSource[];
  note: string | null;
}
interface DebtList {
  /** every wallet below zero (full count — not just the rows returned) */
  total: number;
  /** Σ points owed over ALL of them (owner D1: how far below zero) — never just the rows shown */
  totalOwedPoints?: number;
  limit: number;
  truncated?: boolean;
  program?: string | null;
  availablePrograms?: string[];
  wallets: DebtWallet[];
}

const KIND_TEXT: Record<string, string> = {
  OVER_REVERSAL: 'Reversal took more than the wallet held',
  DEBT_RESTORED: 'Reversed credit had repaid earlier debt',
  DEBT_EXPOSED: 'Points taken were covering earlier debt',
  HISTORICAL_CLAWBACK: 'Historical clawback beyond the balance',
};

const pts = (n: number) => (n < 0 ? `−${(-n).toLocaleString('en-IN')}` : n.toLocaleString('en-IN'));
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';

/** Points a source put on the wallet's debt (owed + debt restored + points that were covering earlier debt). */
export const sourcePoints = (s: DebtSource) => s.owedPoints + s.debtRestoredPoints + (s.debtExposedPoints ?? 0);

export function sourceText(s: DebtSource): string {
  const what = KIND_TEXT[s.kind] ?? s.kind;
  const ctx = [s.outletCode, s.fieldName, s.period].filter(Boolean).join(' · ');
  return `${what} — ${sourcePoints(s).toLocaleString('en-IN')} pts${ctx ? ` (${ctx})` : ''} · reversal ${s.creditReversalId} · ${day(s.approvedAt)}`;
}

/**
 * The Excel file: sheet "Wallets below zero" = one header row + one row per wallet × source (a wallet with no reversal
 * behind it gets one row with its note) — a clean table (autofilter-safe). When the list is incomplete, a separate
 * "About" sheet says so (never a row above the header).
 */
export function buildWalletsInDebtXlsx(list: DebtWallet[], opts: { total?: number; program?: string | null } = {}): ArrayBuffer {
  const header = [
    'Wallet outlet code(s)', 'Outlet / partner', 'Balance (pts)', 'Owed (pts)',
    'Source', 'Source points', 'Source outlet code', 'Reversal', 'Approved on', 'Field', 'Period',
  ];
  const rows: unknown[][] = [header];
  for (const w of list) {
    const base = [w.outletCodes.join(', '), w.partnerName ?? '', w.balance, w.owedPoints];
    if (w.sources.length === 0) rows.push([...base, w.note ?? '', '', '', '', '', '', '']);
    for (const s of w.sources) {
      rows.push([
        ...base, KIND_TEXT[s.kind] ?? s.kind, sourcePoints(s), s.outletCode ?? '', s.creditReversalId,
        day(s.approvedAt), s.fieldName ?? '', s.period ?? '',
      ]);
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aoaToSheetSafe(rows), 'Wallets below zero');
  const about: unknown[][] = [];
  if (opts.program) about.push([`Programme: ${opts.program}`]);
  if (opts.total !== undefined && opts.total > list.length) {
    about.push([`This file has the first ${list.length.toLocaleString('en-IN')} of ${opts.total.toLocaleString('en-IN')} wallets — choose a programme to get the rest.`]);
  }
  if (about.length) XLSX.utils.book_append_sheet(wb, aoaToSheetSafe(about), 'About');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array;
  if (out instanceof ArrayBuffer) return out;
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  return ab;
}

const URL_BASE = '/api/admin/credits/reversal-engine/wallets-in-debt';
const urlFor = (program: string, limit?: number) => {
  const q = new URLSearchParams();
  if (program) q.set('programName', program);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return qs ? `${URL_BASE}?${qs}` : URL_BASE;
};

export default function WalletsInDebtSection() {
  const [data, setData] = useState<DebtList | null>(null);
  const [programs, setPrograms] = useState<string[]>([]);
  const [program, setProgram] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const load = useCallback(async (p: string, alive: () => boolean) => {
    try {
      const res = await fetch(urlFor(p));
      const json = await res.json().catch(() => null);
      if (!alive()) return;
      if (json?.success && json.data && Array.isArray(json.data.wallets)) {
        setError(null);
        setData(json.data as DebtList);
        if (Array.isArray(json.data.availablePrograms)) setPrograms(json.data.availablePrograms);
      } else setError(json?.error ?? `Couldn't load the wallets below zero (HTTP ${res.status})`);
    } catch (e) {
      if (alive()) setError(`Couldn't load the wallets below zero (${String(e)})`);
    }
  }, []);

  useEffect(() => {
    let on = true;
    void load(program, () => on);
    return () => {
      on = false;
    };
  }, [program, load]);

  if (error) {
    return (
      <p role="alert" data-testid="wallets-in-debt-error" className="text-xs text-red-600">
        {error}
      </p>
    );
  }
  // Nothing below zero in the whole tenant → nothing to show (every Deoleo screen stays as it was).
  if (!data || (data.total === 0 && !program)) return null;

  // B4: totals from the API's full aggregate, never from the rows shown.
  const totalOwed = data.totalOwedPoints ?? data.wallets.reduce((s, w) => s + w.owedPoints, 0);
  const cut = data.truncated ?? data.total > data.wallets.length;

  async function downloadAll() {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await fetch(urlFor(program, 5000));
      const json = await res.json().catch(() => null);
      if (!json?.success || !Array.isArray(json.data?.wallets)) {
        setExportMsg(json?.error ?? `Couldn't prepare the file (HTTP ${res.status})`);
        return;
      }
      const all = json.data as DebtList;
      downloadBlob(
        new Blob([buildWalletsInDebtXlsx(all.wallets, { total: all.total, program: program || null })], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
        'wallets-below-zero.xlsx',
      );
      if (all.total > all.wallets.length) {
        setExportMsg(
          `The file has the first ${all.wallets.length.toLocaleString('en-IN')} of ${all.total.toLocaleString('en-IN')} wallets (see its "About" sheet) — choose a programme to get the rest.`,
        );
      }
    } catch (e) {
      setExportMsg(`Couldn't prepare the file (${String(e)})`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section data-testid="wallets-in-debt" className="bg-orange-50 border border-orange-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Wallet className="w-4 h-4 text-orange-600" aria-hidden />
        <p className="text-sm font-semibold text-orange-900" data-testid="wallets-in-debt-summary">
          {data.total} wallet{data.total === 1 ? '' : 's'} below zero · {totalOwed.toLocaleString('en-IN')} pts owed
          {cut ? ` (first ${data.wallets.length} listed)` : ''}
        </p>
        <span className="text-xs text-orange-800">Repaid from their future earnings; they can&apos;t redeem until back above zero.</span>
        <div className="ml-auto flex items-center gap-2">
          {programs.length > 1 && (
            <label className="text-xs text-orange-900 flex items-center gap-1">
              <span>Programme</span>
              <select
                data-testid="wallets-in-debt-program"
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                className="border border-orange-300 rounded-lg px-2 py-1 text-xs bg-white"
              >
                <option value="">All programmes</option>
                {programs.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => void downloadAll()}
            disabled={exporting}
            aria-busy={exporting || undefined}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-orange-300 text-orange-800 rounded-lg hover:bg-orange-100 disabled:opacity-50 disabled:cursor-wait"
          >
            <Download className="w-3.5 h-3.5" aria-hidden /> {exporting ? 'Preparing…' : 'Excel'}
          </button>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-orange-800 rounded-lg hover:bg-orange-100"
          >
            {open ? <ChevronUp className="w-3.5 h-3.5" aria-hidden /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden />}
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {exportMsg && (
        <p role="status" data-testid="wallets-in-debt-export-msg" className="text-xs text-orange-900">{exportMsg}</p>
      )}
      {open && (
        <div className="overflow-x-auto">
          {data.wallets.length === 0 ? (
            <p className="text-xs text-orange-900">No wallet below zero in this programme.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-orange-900 border-b border-orange-200">
                  <th className="py-1.5 pr-3 font-medium">Outlet</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Balance</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Owed</th>
                  <th className="py-1.5 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {data.wallets.map((w) => (
                  <tr key={w.walletId} className="border-b border-orange-100 align-top" data-testid={`debt-wallet-${w.walletId}`}>
                    <td className="py-1.5 pr-3">
                      <span className="font-medium text-gray-800">{w.partnerName ?? '—'}</span>
                      <span className="block text-gray-500 font-mono">{w.outletCodes.join(', ') || '—'}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right">{pts(w.balance)} pts</td>
                    <td className="py-1.5 pr-3 text-right font-semibold text-orange-800">{pts(w.owedPoints)} pts</td>
                    <td className="py-1.5 text-gray-700">
                      {w.sources.length === 0 ? (
                        <span className="text-gray-500">{w.note}</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {/* one row per allocation (a reversal can touch two positions of the same wallet) */}
                          {w.sources.map((s, i) => <li key={s.allocationId ?? `${s.creditReversalId}-${i}`}>{sourceText(s)}</li>)}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
