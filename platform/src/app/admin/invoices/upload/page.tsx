'use client';

/**
 * /admin/invoices/upload
 * Visible to GIFSY_ADMIN and CLIENT_ADMIN.
 *
 * Gap #44 — this page used to be a 100% client-side MOCK (hardcoded outlet
 * registry, fake 1.4s "generate", dead template link). It is now wired to the
 * real backend.
 *
 * Real model (P6 no-compute): invoices are NOT created from arbitrary uploaded
 * amounts. They are auto-generated, idempotently, per outlet per period from the
 * approved visibility payout entries (CreditPayoutEntry). So this page:
 *   Step 1 — Download the real template / upload an Excel naming the period(s).
 *   Step 2 — Preview the distinct period(s) detected.
 *   Step 3 — Confirm → POST /api/admin/invoices/generate per period (real,
 *            idempotent — a re-run never mutates a PAID invoice). Shows the real
 *            generated / skipped result returned by the backend.
 */

import { useState, useRef, useCallback } from 'react';
import { authHeader } from '@/lib/api-client';
import {
  FileSpreadsheet,
  CheckCircle,
  AlertTriangle,
  X,
  ChevronRight,
  Loader2,
  Info,
  DownloadCloud,
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
interface PeriodRow {
  period: string;        // YYYY-MM
  periodLabel: string;
}

type Step = 'upload' | 'preview' | 'done';

// ── Helpers ───────────────────────────────────────────────────────────────────
function parsePeriod(raw: string): string | null {
  // Accept: "2025-01", "Jan 2025", "January 2025", "01/2025"
  const iso = /^\d{4}-\d{2}$/.test(raw.trim()) ? raw.trim() : null;
  if (iso) return iso;
  const monthMap: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
    jan: '01', feb: '02', mar: '03', apr: '04', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const slash = raw.match(/^(\d{2})\/(\d{4})$/);
  if (slash) return `${slash[2]}-${slash[1]}`;
  const written = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (written) {
    const m = monthMap[written[1].toLowerCase()];
    if (m) return `${written[2]}-${m}`;
  }
  return null;
}

/** Download the real backend upload template (replaces the dead "#" link). */
async function downloadTemplate(): Promise<string | null> {
  try {
    const res = await fetch('/api/admin/invoices/template', { headers: authHeader() });
    if (!res.ok) return `HTTP ${res.status}`;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: objectUrl,
      download: 'invoice-upload-template.xlsx',
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Download failed';
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function InvoiceUploadPage() {
  const [step, setStep] = useState<Step>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setParseError(null);
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Find the "Period" column from the header row (fallback: first column).
    const header = (raw[0] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
    const periodCol = header.findIndex((h) => h.includes('period'));
    const col = periodCol >= 0 ? periodCol : 0;

    const dataRows = raw.slice(1).filter((r) => r.some((c) => c !== ''));
    const seen = new Set<string>();
    const found: PeriodRow[] = [];
    for (const row of dataRows) {
      const period = parsePeriod(String(row[col] ?? '').trim());
      if (period && !seen.has(period)) {
        seen.add(period);
        found.push({ period, periodLabel: formatPeriodLabel(period) });
      }
    }

    if (found.length === 0) {
      setParseError('No valid period found. Expected a "Period (YYYY-MM)" column, e.g. 2025-01.');
      setPeriods([]);
      setStep('upload');
      return;
    }

    setPeriods(found.sort((a, b) => a.period.localeCompare(b.period)));
    setStep('preview');
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleDownloadTemplate = async () => {
    setDlError(null);
    const err = await downloadTemplate();
    if (err) setDlError(err);
  };

  // Real, idempotent generation — one POST per distinct period; aggregate results.
  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    setResult(null);

    let generated = 0;
    const skipped: SkippedOutlet[] = [];
    try {
      for (const { period } of periods) {
        const res = await fetch('/api/admin/invoices/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ period }),
        });
        const json = (await res.json()) as { success: boolean; data?: GenerateResult; error?: string };
        if (!res.ok || !json.success) {
          setGenError(json.error ?? `Generation failed for ${period} (HTTP ${res.status})`);
          setGenerating(false);
          return;
        }
        generated += json.data?.generated ?? 0;
        if (json.data?.skipped?.length) skipped.push(...json.data.skipped);
      }
      setResult({ generated, skipped });
      setStep('done');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const reset = () => {
    setStep('upload');
    setFileName(null);
    setPeriods([]);
    setResult(null);
    setGenError(null);
    setParseError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 fade-in max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-gray-900">Generate Visibility Invoices</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Upload an Excel naming the period(s); the system generates self-billing invoices
          for approved retailers from their visibility payouts.
        </p>
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2 text-xs">
        {(['upload', 'preview', 'done'] as Step[]).map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold text-[11px] ${
              step === s
                ? 'bg-[var(--brand-primary)] text-white'
                : (step === 'preview' && s === 'upload') || step === 'done'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-400'
            }`}>
              {(step === 'preview' && s === 'upload') || step === 'done' ? '✓' : i + 1}
            </span>
            <span className={step === s ? 'font-semibold text-gray-800' : 'text-gray-400'}>
              {s === 'upload' ? 'Upload File' : s === 'preview' ? 'Review & Confirm' : 'Generated'}
            </span>
            {i < 2 && <ChevronRight className="w-3.5 h-3.5 text-gray-300" />}
          </span>
        ))}
      </div>

      {/* ── Step 1: Upload ── */}
      {step === 'upload' && (
        <div className="space-y-4">
          {/* Format guidance */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3 text-xs text-blue-700">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold mb-1">Expected Excel format</p>
              <p className="mb-2">
                A <span className="font-semibold">Period (YYYY-MM)</span> column naming the
                month(s) to generate invoices for. Amounts are sourced automatically from the
                approved visibility payouts — you do not enter them here.
              </p>
              <p className="text-blue-600">
                Period accepts: <span className="font-mono">2025-01</span>,{' '}
                <span className="font-mono">January 2025</span>,{' '}
                <span className="font-mono">Jan 2025</span>,{' '}
                <span className="font-mono">01/2025</span>
              </p>
            </div>
          </div>

          {parseError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {parseError}
            </div>
          )}

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
              isDragging
                ? 'border-[var(--brand-primary)] bg-green-50'
                : 'border-gray-200 hover:border-[var(--brand-primary)] hover:bg-green-50/30'
            }`}
          >
            <FileSpreadsheet className="w-10 h-10 text-gray-300" />
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-700">
                Drop your Excel file here, or{' '}
                <span className="text-[var(--brand-primary)]">browse</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">Supports .xlsx, .xls</p>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Sample download — real backend template */}
          <button
            type="button"
            onClick={handleDownloadTemplate}
            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-[var(--brand-primary)] transition-colors"
          >
            <DownloadCloud className="w-3.5 h-3.5" />
            Download sample template
          </button>
          {dlError && (
            <p className="text-xs text-red-600">{dlError}</p>
          )}
        </div>
      )}

      {/* ── Step 2: Preview ── */}
      {step === 'preview' && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-xs flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-gray-400" />
              <span className="text-gray-500">File:</span>
              <span className="font-semibold text-gray-800">{fileName}</span>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-xs flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="font-semibold text-green-700">
                {periods.length} period{periods.length !== 1 ? 's' : ''} detected
              </span>
            </div>
            <button
              onClick={reset}
              className="ml-auto text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" /> Change file
            </button>
          </div>

          {/* Periods table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <p className="text-xs font-semibold text-gray-700">Periods to generate</p>
              <p className="text-[10px] text-gray-400 mt-0.5">
                Generation is idempotent — re-running never alters an already-paid invoice.
              </p>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="text-left px-4 py-2.5">Period</th>
                  <th className="text-left px-4 py-2.5">Month</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {periods.map((p) => (
                  <tr key={p.period} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-gray-700">{p.period}</td>
                    <td className="px-4 py-3 text-gray-600">{p.periodLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {genError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {genError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              onClick={reset}
              className="text-xs px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="text-xs px-5 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors flex items-center gap-2 disabled:opacity-60"
            >
              {generating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {generating
                ? 'Generating…'
                : `Generate for ${periods.length} period${periods.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Done ── */}
      {step === 'done' && result && (
        <div className="bg-white border border-gray-200 rounded-xl p-8 flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-green-600" />
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

          <div className="flex gap-3">
            <a
              href="/admin/invoices"
              className="text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors"
            >
              View Invoice List
            </a>
            <button
              onClick={reset}
              className="text-xs px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Upload Another File
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
