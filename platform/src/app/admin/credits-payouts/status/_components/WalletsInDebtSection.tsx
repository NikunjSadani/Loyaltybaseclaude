'use client';

/**
 * Wallets in debt — audit item 9 (2026-11-19, owner rule "no silent pass-throughs").
 *
 * Every wallet of the tenant that is NEGATIVE or carries recorded debt: outlet(s), balance, debt, what the outlet must
 * earn back, and the reversal(s) behind it (a V2 over-reversal, debt a reversed credit had repaid, or a historical
 * clawback) with the approval date — plus an Excel download of the same list.
 * Data: GET /api/admin/credits/reversal-engine/wallets-in-debt. Mounted on the credits status screen next to the
 * reversal-engine banner (non-LEGACY tenants only). Renders nothing when no wallet is in debt; a failed load says so.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Wallet } from 'lucide-react';
import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';

export interface DebtSource {
  creditReversalId: string;
  kind: 'OVER_REVERSAL' | 'DEBT_RESTORED' | 'HISTORICAL_CLAWBACK' | string;
  owedPoints: number;
  debtRestoredPoints: number;
  approvedAt: string | null;
  fieldName: string | null;
  period: string | null;
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
  total: number;
  limit: number;
  wallets: DebtWallet[];
}

const KIND_TEXT: Record<string, string> = {
  OVER_REVERSAL: 'Reversal took more than the wallet held',
  DEBT_RESTORED: 'Reversed credit had repaid earlier debt',
  HISTORICAL_CLAWBACK: 'Historical clawback beyond the balance',
};

const pts = (n: number) => (n < 0 ? `−${(-n).toLocaleString('en-IN')}` : n.toLocaleString('en-IN'));
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';

export function sourceText(s: DebtSource): string {
  const what = KIND_TEXT[s.kind] ?? s.kind;
  const amount = s.owedPoints + s.debtRestoredPoints;
  const ctx = [s.fieldName, s.period].filter(Boolean).join(' · ');
  return `${what} — ${amount.toLocaleString('en-IN')} pts${ctx ? ` (${ctx})` : ''} · reversal ${s.creditReversalId} · ${day(s.approvedAt)}`;
}

/** The Excel file: one row per wallet × source (a wallet with no reversal behind it gets one row with its note). */
export function buildWalletsInDebtXlsx(list: DebtWallet[]): ArrayBuffer {
  const header = ['Outlet code(s)', 'Outlet / partner', 'Balance (pts)', 'Debt (pts)', 'Owed (pts)', 'Source', 'Reversal', 'Approved on', 'Field', 'Period'];
  const rows: unknown[][] = [header];
  for (const w of list) {
    const base = [w.outletCodes.join(', '), w.partnerName ?? '', w.balance, w.debtPoints, w.owedPoints];
    if (w.sources.length === 0) rows.push([...base, w.note ?? '', '', '', '', '']);
    for (const s of w.sources) {
      rows.push([...base, KIND_TEXT[s.kind] ?? s.kind, s.creditReversalId, day(s.approvedAt), s.fieldName ?? '', s.period ?? '']);
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aoaToSheetSafe(rows), 'Wallets in debt');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array;
  if (out instanceof ArrayBuffer) return out;
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  return ab;
}

export default function WalletsInDebtSection() {
  const [data, setData] = useState<DebtList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/admin/credits/reversal-engine/wallets-in-debt');
        const json = await res.json().catch(() => null);
        if (!alive) return;
        if (json?.success && json.data && Array.isArray(json.data.wallets)) setData(json.data as DebtList);
        else setError(json?.error ?? `Couldn't load the wallets in debt (HTTP ${res.status})`);
      } catch (e) {
        if (alive) setError(`Couldn't load the wallets in debt (${String(e)})`);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" data-testid="wallets-in-debt-error" className="text-xs text-red-600">
        {error}
      </p>
    );
  }
  if (!data || data.total === 0) return null;

  const totalOwed = data.wallets.reduce((s, w) => s + w.owedPoints, 0);
  const cut = data.total > data.wallets.length;

  return (
    <section data-testid="wallets-in-debt" className="bg-orange-50 border border-orange-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Wallet className="w-4 h-4 text-orange-600" aria-hidden />
        <p className="text-sm font-semibold text-orange-900" data-testid="wallets-in-debt-summary">
          {data.total} wallet{data.total === 1 ? '' : 's'} in debt · {totalOwed.toLocaleString('en-IN')} pts owed
          {cut ? ` (first ${data.wallets.length} shown)` : ''}
        </p>
        <span className="text-xs text-orange-800">Repaid from their future earnings; they can&apos;t redeem until back above zero.</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => downloadBlob(
              new Blob([buildWalletsInDebtXlsx(data.wallets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
              'wallets-in-debt.xlsx',
            )}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-orange-300 text-orange-800 rounded-lg hover:bg-orange-100"
          >
            <Download className="w-3.5 h-3.5" aria-hidden /> Excel
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
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-orange-900 border-b border-orange-200">
                <th className="py-1.5 pr-3 font-medium">Outlet</th>
                <th className="py-1.5 pr-3 font-medium text-right">Balance</th>
                <th className="py-1.5 pr-3 font-medium text-right">Debt</th>
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
                  <td className="py-1.5 pr-3 text-right">{pts(w.debtPoints)} pts</td>
                  <td className="py-1.5 pr-3 text-right font-semibold text-orange-800">{pts(w.owedPoints)} pts</td>
                  <td className="py-1.5 text-gray-700">
                    {w.sources.length === 0 ? (
                      <span className="text-gray-500">{w.note}</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {w.sources.map((s) => <li key={s.creditReversalId}>{sourceText(s)}</li>)}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
