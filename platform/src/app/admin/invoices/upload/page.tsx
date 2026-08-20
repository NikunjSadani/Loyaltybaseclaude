'use client';

/**
 * /admin/invoices/upload
 * Visible to GIFSY_ADMIN and CLIENT_ADMIN.
 *
 * Real model (P6 no-compute): invoices are NOT created from arbitrary uploaded
 * amounts. They are auto-generated, idempotently, per outlet per period from the
 * already-confirmed visibility payout entries (CreditPayoutEntry).
 *
 * So this screen no longer asks for a file. The user simply PICKS a period and
 * hits Generate → POST /api/admin/invoices/generate { period } (real,
 * idempotent — a re-run never mutates or duplicates an existing invoice). The
 * real generated / skipped result returned by the backend is shown inline.
 *
 * (History: this used to make the user download a template and upload an Excel
 * that only NAMED the period(s) — a legacy mock-scaffold UX. The amounts were
 * never in that file, so the upload was pure ceremony and has been removed.)
 */

import { useState } from 'react';
import { authHeader } from '@/lib/api-client';
import {
  CheckCircle,
  AlertTriangle,
  Loader2,
  Info,
} from 'lucide-react';
import { formatPeriodLabel } from '@/lib/invoice';

// ── Types ─────────────────────────────────────────────────────────────────────
interface SkippedOutlet {
  outletCode: string;
  reason: string;
}
interface GenerateResult {
  generated: number;
  skipped: SkippedOutlet[];
  message?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function InvoiceUploadPage() {
  const [period, setPeriod] = useState('');     // "YYYY-MM" from <input type="month">
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const validPeriod = /^\d{4}-\d{2}$/.test(period);

  // Real, idempotent generation for the chosen period.
  const handleGenerate = async () => {
    if (!validPeriod) {
      setGenError('Pick a month first.');
      return;
    }
    setGenerating(true);
    setGenError(null);
    setResult(null);

    try {
      const res = await fetch('/api/admin/invoices/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ period }),
      });
      const json = (await res.json()) as { success: boolean; data?: GenerateResult; error?: string };
      if (!res.ok || !json.success) {
        setGenError(json.error ?? `Generation failed for ${period} (HTTP ${res.status})`);
        return;
      }
      setResult({
        generated: json.data?.generated ?? 0,
        skipped: json.data?.skipped ?? [],
      });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 fade-in max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-gray-900">Generate Visibility Invoices</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Pick a month and generate self-billing invoices for approved retailers from their
          confirmed visibility payouts.
        </p>
      </div>

      {/* How it works */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3 text-xs text-blue-700">
        <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold mb-1">How this works</p>
          <p>
            Invoices are generated automatically from the already-confirmed visibility payout
            entries for the month you choose — amounts are sourced from those payouts, you do
            not enter them here. Generation is idempotent: it is safe to re-run, and existing
            invoices are never duplicated.
          </p>
        </div>
      </div>

      {/* Picker + Generate */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="invoice-period" className="block text-xs font-semibold text-gray-700">
            Month
          </label>
          <input
            id="invoice-period"
            type="month"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);   // input[type=month] gives "YYYY-MM"
              setGenError(null);
            }}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
          {validPeriod && (
            <p className="text-[11px] text-gray-400">
              Generating for <span className="font-semibold text-gray-600">{formatPeriodLabel(period)}</span>
            </p>
          )}
        </div>

        {genError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {genError}
          </div>
        )}

        <div>
          <button
            onClick={handleGenerate}
            disabled={generating || !validPeriod}
            className="text-xs px-5 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors flex items-center gap-2 disabled:opacity-60"
          >
            {generating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {generating ? 'Generating…' : 'Generate invoices'}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle className="w-7 h-7 text-green-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-gray-900">
              {result.generated} Invoice{result.generated !== 1 ? 's' : ''} Generated
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Retailers can now see these in their portal.
            </p>
          </div>

          {result.skipped.length > 0 && (
            <div className="w-full bg-amber-50 border border-amber-200 rounded-lg p-3 text-left">
              <p className="text-[11px] font-semibold text-amber-700 mb-1">
                {result.skipped.length} outlet{result.skipped.length !== 1 ? 's' : ''} skipped:
              </p>
              <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                {result.skipped.map((s, i) => (
                  <li key={i} className="text-[11px] text-gray-600 flex items-start gap-1.5">
                    <span className="font-mono text-gray-700">{s.outletCode}</span>
                    <span className="text-gray-400">—</span>
                    <span>{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <a
            href="/admin/invoices"
            className="text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors"
          >
            View Invoice List
          </a>
        </div>
      )}
    </div>
  );
}
