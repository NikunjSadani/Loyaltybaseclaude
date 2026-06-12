'use client';

/**
 * /admin/invoices/upload
 * Visible to GIFSY_ADMIN and CLIENT_ADMIN.
 *
 * Step 1 — Upload an Excel file with columns: Outlet ID | Amount | Period
 * Step 2 — Preview parsed rows with computed GST preview
 * Step 3 — Confirm → system generates invoices
 */

import { useState, useRef, useCallback } from 'react';
import { setLastSalesUploadDate } from '@/lib/sales-upload-utils';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertTriangle,
  X,
  ChevronRight,
  Loader2,
  Info,
  DownloadCloud,
} from 'lucide-react';
import {
  computeGST,
  computeTDS,
  generateInvoiceNumber,
  buildInvoiceDescription,
  formatPeriodLabel,
  MOCK_VISIBILITY_INVOICES,
  type EntityType,
  type GSTRegistrationType,
} from '@/lib/invoice';

// ── Mock outlet registry (mirrors KYC data) ──────────────────────────────────
interface OutletMeta {
  outletCode: string;
  outletName: string;
  firmName: string;
  partnerName: string;
  mobile: string;
  state: string;
  panNumber: string | null;
  entityType: EntityType;
  gstRegistrationType: GSTRegistrationType;
  gstNumber: string | null;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  kycApproved: boolean;
}

const OUTLET_REGISTRY: Record<string, OutletMeta> = {
  O1: { outletCode: 'O1', outletName: 'Singh Kirana Corner', firmName: 'Singh Traders', partnerName: 'Harpreet Singh', mobile: '9876500004', state: 'West Bengal', panNumber: 'BFLPS4567G', entityType: 'INDIVIDUAL', gstRegistrationType: 'COMPOSITE', gstNumber: null, bankName: 'Bank of India', accountNumber: '5544332211', ifscCode: 'BKID0001234', kycApproved: true },
  O2: { outletCode: 'O2', outletName: 'Sharma Kirana Store', firmName: 'Sharma Enterprises', partnerName: 'Rajesh Sharma', mobile: '9876543210', state: 'West Bengal', panNumber: 'ABCPS1234D', entityType: 'INDIVIDUAL', gstRegistrationType: 'REGULAR', gstNumber: '19ABCPS1234D1Z5', bankName: 'State Bank of India', accountNumber: '1234567890', ifscCode: 'SBIN0001234', kycApproved: true },
  O4: { outletCode: 'O4', outletName: 'Metro General Store', firmName: 'Metro Retail Pvt Ltd', partnerName: 'Suresh Mehta', mobile: '9876500001', state: 'Maharashtra', panNumber: 'AABCM1234F', entityType: 'COMPANY', gstRegistrationType: 'REGULAR', gstNumber: '27AABCM1234F1Z3', bankName: 'HDFC Bank', accountNumber: '9876543210', ifscCode: 'HDFC0001234', kycApproved: true },
  O7: { outletCode: 'O7', outletName: 'Patel Provision Store', firmName: 'Patel Stores', partnerName: 'Ankit Patel', mobile: '9876500002', state: 'Gujarat', panNumber: 'ATNPP9876C', entityType: 'INDIVIDUAL', gstRegistrationType: 'UNREGISTERED', gstNumber: null, bankName: 'Axis Bank', accountNumber: '1122334455', ifscCode: 'UTIB0001234', kycApproved: true },
  O11: { outletCode: 'O11', outletName: 'Kumar General Mart', firmName: 'Kumar Brothers', partnerName: 'Vijay Kumar', mobile: '9876500003', state: 'Delhi', panNumber: null, entityType: 'FIRM', gstRegistrationType: 'UNREGISTERED', gstNumber: null, bankName: 'Punjab National Bank', accountNumber: '6677889900', ifscCode: 'PUNB0001234', kycApproved: true },
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface ParsedRow {
  rowNum: number;
  outletId: string;
  amount: number;
  period: string;         // YYYY-MM
  error: string | null;
  // Resolved fields (when no error)
  meta?: OutletMeta;
  gstApplicable?: boolean;
  gstType?: 'CGST_SGST' | 'IGST' | null;
  totalGST?: number;
  totalInvoiceAmount?: number;
  invoiceNumber?: string;
  periodLabel?: string;
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

function assignSeq(outletId: string, period: string): number {
  const existing = MOCK_VISIBILITY_INVOICES.filter(
    (inv) => inv.outletCode === outletId && inv.period === period
  );
  return existing.length + 1;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function InvoiceUploadPage() {
  const [step, setStep] = useState<Step>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generatedCount, setGeneratedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setFileName(file.name);
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Skip header row
    const dataRows = raw.slice(1).filter((r) => r.some((c) => c !== ''));

    const parsed: ParsedRow[] = dataRows.map((row, i) => {
      const outletId = String(row[0] ?? '').trim().toUpperCase();
      const amountRaw = row[1];
      const periodRaw = String(row[2] ?? '').trim();

      const amount = Number(amountRaw);
      const period = parsePeriod(periodRaw);

      if (!outletId) {
        return { rowNum: i + 2, outletId, amount, period: periodRaw, error: 'Outlet ID is required' };
      }
      if (isNaN(amount) || amount <= 0) {
        return { rowNum: i + 2, outletId, amount, period: periodRaw, error: `Invalid amount: "${amountRaw}"` };
      }
      if (!period) {
        return { rowNum: i + 2, outletId, amount, period: periodRaw, error: `Unrecognised period format: "${periodRaw}"` };
      }
      const meta = OUTLET_REGISTRY[outletId];
      if (!meta) {
        return { rowNum: i + 2, outletId, amount, period, error: `Outlet "${outletId}" not found in registry` };
      }
      if (!meta.kycApproved) {
        return { rowNum: i + 2, outletId, amount, period, error: `Outlet "${outletId}" KYC not approved` };
      }

      const gst = computeGST(amount, meta.gstRegistrationType, meta.state);
      const seq = assignSeq(outletId, period);
      const invoiceNumber = generateInvoiceNumber(outletId, period, seq);
      const periodLabel = formatPeriodLabel(period);

      return {
        rowNum: i + 2,
        outletId,
        amount,
        period,
        error: null,
        meta,
        gstApplicable: gst.gstApplicable,
        gstType: gst.gstType,
        totalGST: gst.totalGST,
        totalInvoiceAmount: gst.totalInvoiceAmount,
        invoiceNumber,
        periodLabel,
      };
    });

    setRows(parsed);
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

  const validRows = rows.filter((r) => !r.error);
  const errorRows = rows.filter((r) => r.error);

  const handleGenerate = async () => {
    setGenerating(true);
    await new Promise((res) => setTimeout(res, 1400)); // demo delay
    setGeneratedCount(validRows.length);
    setLastSalesUploadDate(new Date().toISOString());
    setGenerating(false);
    setStep('done');
  };

  const reset = () => {
    setStep('upload');
    setFileName(null);
    setRows([]);
    setGeneratedCount(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 fade-in max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-gray-900">Upload Visibility Payouts</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Upload an Excel file to auto-generate self-billing invoices for approved retailers.
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
              <p className="font-semibold mb-1">Expected Excel format (3 columns)</p>
              <div className="font-mono bg-white border border-blue-100 rounded-lg px-3 py-2 grid grid-cols-3 gap-4 text-center">
                <span className="font-semibold">Outlet ID</span>
                <span className="font-semibold">Amount (₹)</span>
                <span className="font-semibold">Period</span>
                <span className="text-gray-500">O2</span>
                <span className="text-gray-500">5000</span>
                <span className="text-gray-500">2025-01</span>
                <span className="text-gray-500">O4</span>
                <span className="text-gray-500">12000</span>
                <span className="text-gray-500">January 2025</span>
              </div>
              <p className="mt-2 text-blue-600">
                Period accepts: <span className="font-mono">2025-01</span>,{' '}
                <span className="font-mono">January 2025</span>,{' '}
                <span className="font-mono">Jan 2025</span>,{' '}
                <span className="font-mono">01/2025</span>
              </p>
            </div>
          </div>

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

          {/* Sample download */}
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-[var(--brand-primary)] transition-colors"
          >
            <DownloadCloud className="w-3.5 h-3.5" />
            Download sample template
          </a>
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
              <span className="font-semibold text-green-700">{validRows.length} valid row{validRows.length !== 1 ? 's' : ''}</span>
            </div>
            {errorRows.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <span className="font-semibold text-red-600">{errorRows.length} error{errorRows.length !== 1 ? 's' : ''} — will be skipped</span>
              </div>
            )}
            <button
              onClick={reset}
              className="ml-auto text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" /> Change file
            </button>
          </div>

          {/* Error rows */}
          {errorRows.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-2">
              <p className="text-xs font-semibold text-red-700 mb-2">Rows with errors (will be skipped)</p>
              {errorRows.map((r) => (
                <div key={r.rowNum} className="flex items-start gap-2 text-xs text-red-600">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>Row {r.rowNum}: {r.error}</span>
                </div>
              ))}
            </div>
          )}

          {/* Valid rows table */}
          {validRows.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-700">Invoice Preview</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  GST shown where applicable. Only gross amount visible to retailers.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                      <th className="text-left px-4 py-2.5">Invoice #</th>
                      <th className="text-left px-4 py-2.5">Outlet</th>
                      <th className="text-left px-4 py-2.5">Period</th>
                      <th className="text-right px-4 py-2.5">Base Amt</th>
                      <th className="text-right px-4 py-2.5">GST</th>
                      <th className="text-right px-4 py-2.5">Invoice Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {validRows.map((r) => (
                      <tr key={r.rowNum} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-mono text-gray-700">{r.invoiceNumber}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-800">{r.meta?.outletName}</p>
                          <p className="text-gray-400">{r.outletId}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{r.periodLabel}</td>
                        <td className="px-4 py-3 text-right font-medium text-gray-800">
                          ₹{r.amount.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {r.gstApplicable ? (
                            <span className="text-green-600 font-medium">
                              +₹{r.totalGST?.toLocaleString('en-IN')}
                              <span className="text-gray-400 ml-1">({r.gstType === 'CGST_SGST' ? 'C+S' : 'IGST'})</span>
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">
                          ₹{r.totalInvoiceAmount?.toLocaleString('en-IN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t border-gray-200">
                    <tr>
                      <td colSpan={3} className="px-4 py-3 text-xs font-semibold text-gray-600">
                        Total ({validRows.length} invoices)
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-semibold text-gray-800">
                        ₹{validRows.reduce((s, r) => s + r.amount, 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-semibold text-green-600">
                        +₹{validRows.reduce((s, r) => s + (r.totalGST ?? 0), 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-bold text-gray-900">
                        ₹{validRows.reduce((s, r) => s + (r.totalInvoiceAmount ?? 0), 0).toLocaleString('en-IN')}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {validRows.length > 0 && (
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
                {generating ? 'Generating…' : `Generate ${validRows.length} Invoice${validRows.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Done ── */}
      {step === 'done' && (
        <div className="bg-white border border-gray-200 rounded-xl p-8 flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-gray-900">
              {generatedCount} Invoice{generatedCount !== 1 ? 's' : ''} Generated
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Retailers have been notified. Invoices are now visible in their portal.
            </p>
          </div>
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
