'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Store, Search, Upload, Download, X, AlertCircle, CheckCircle2,
  Loader2, Building2, MapPin, Users, FileText, ArrowRightLeft,
  RefreshCw, Eye, Clock, XCircle, CheckCircle,
} from 'lucide-react';
import {
  validateOutletUploadHeaders,
  validateReKYCFlagHeaders,
  validateDeactivateHeaders,
  validateOutletUpload,
  validateReKYCFlagUpload,
  validateDeactivateUpload,
  parseOutletUploadRows,
  parseReKYCFlagRows,
  parseDeactivateRows,
  getOutletAdditionTemplateData,
  getReKYCFlagTemplateData,
  getDeactivateTemplateData,
  generateOutletGuideHtml,
} from '@/lib/outlet-upload';
import { MOCK_EMPLOYEES } from '@/lib/employee-hierarchy';
import type {
  OutletUploadValidationResult,
  ReKYCFlagValidationResult,
  OutletDeactivateValidationResult,
  KYCStatus,
} from '@/types';

// ─── Constants ─────────────────────────────────────────────────────────────────

const LEAF_ROLE_CODE    = 'XSR';     // Deoleo config
const VALID_PROGRAMS    = ['Trade Loyalty', 'Gold Programme'];
const VALID_CATEGORIES  = ['Premium', 'Standard', 'Economy'];

// ─── Mock outlet master data ───────────────────────────────────────────────────

type KYCStatusLocal = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'RE_KYC_REQUIRED';

interface MockOutlet {
  outletId:        string;
  outletName:      string;
  outletType:      string;
  programName:     string;
  programCategory: string;
  beat:            string;
  distributorId:   string;
  city:            string;
  state:           string;
  metro:           boolean;
  xsrId:           string;
  xsrName:         string;
  kycStatus:       KYCStatusLocal;
  isActive:        boolean;
  addedDate:       string;
  phone?:          string;
}

const MOCK_OUTLETS: MockOutlet[] = [
  { outletId: 'OUT-2026-K01', outletName: 'Kumar General Store',  outletType: 'SSS',     programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Andheri Beat',   distributorId: 'DIST-01', city: 'Mumbai',    state: 'Maharashtra', metro: true,  xsrId: 'ISR-M001', xsrName: 'Anil Sharma',  kycStatus: 'APPROVED',       isActive: true,  addedDate: '2026-03-01' },
  { outletId: 'OUT-2026-K04', outletName: 'Singh Supermart',      outletType: 'WHOLESALER',   programName: 'Trade Loyalty', programCategory: 'Premium',  beat: 'Malad Beat',     distributorId: 'DIST-01', city: 'Mumbai',    state: 'Maharashtra', metro: true,  xsrId: 'ISR-M001', xsrName: 'Anil Sharma',  kycStatus: 'APPROVED',       isActive: true,  addedDate: '2026-03-01' },
  { outletId: 'OUT-2026-K10', outletName: 'Sharma General Store', outletType: 'SSS',     programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Noida Beat',     distributorId: 'DIST-03', city: 'Delhi',     state: 'Delhi',       metro: true,  xsrId: 'ISR-P001', xsrName: 'Deepa Nair',   kycStatus: 'APPROVED',       isActive: true,  addedDate: '2026-03-15' },
  { outletId: 'OUT-2026-K02', outletName: 'Sharma Kirana',        outletType: 'SSS',     programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Borivali Beat',  distributorId: 'DIST-01', city: 'Mumbai',    state: 'Maharashtra', metro: true,  xsrId: 'ISR-M001', xsrName: 'Anil Sharma',  kycStatus: 'IN_PROGRESS',    isActive: false, addedDate: '2026-04-01' },
  { outletId: 'OUT-2026-K05', outletName: 'Mehta Provisions',     outletType: 'SUB_STOCKIST', programName: 'Trade Loyalty', programCategory: 'Economy',  beat: 'Kandivali Beat', distributorId: 'DIST-02', city: 'Mumbai',    state: 'Maharashtra', metro: false, xsrId: 'ISR-M001', xsrName: 'Anil Sharma',  kycStatus: 'SUBMITTED',      isActive: false, addedDate: '2026-04-15' },
  { outletId: 'OUT-2026-K03', outletName: 'Patel Grocery',        outletType: 'SSS',     programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Thane Beat',     distributorId: 'DIST-02', city: 'Thane',     state: 'Maharashtra', metro: false, xsrId: 'ISR-M002', xsrName: 'PLACEHOLDER',  kycStatus: 'REJECTED',       isActive: false, addedDate: '2026-04-01' },
  { outletId: 'OUT-2026-001', outletName: 'Verma Traders',        outletType: 'SSS',     programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Andheri Beat',   distributorId: '',        city: 'Mumbai',    state: 'Maharashtra', metro: true,  xsrId: 'ISR-M001', xsrName: 'Anil Sharma',  kycStatus: 'NOT_STARTED',    isActive: false, addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-002', outletName: 'Joshi Provisions',     outletType: 'SSS',     programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Andheri Beat',   distributorId: '',        city: 'Mumbai',    state: 'Maharashtra', metro: true,  xsrId: 'ISR-M001', xsrName: 'Anil Sharma',  kycStatus: 'NOT_STARTED',    isActive: false, addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-K11', outletName: 'Krishnamurthy & Sons', outletType: 'WHOLESALER',   programName: 'Gold Programme',programCategory: 'Premium',  beat: 'Koramangala Beat',distributorId: 'DIST-05', city: 'Bengaluru', state: 'Karnataka',   metro: true,  xsrId: 'ISR-P001', xsrName: 'Deepa Nair',   kycStatus: 'RE_KYC_REQUIRED', isActive: true, addedDate: '2026-03-10' },
];

// ─── KYC status config ─────────────────────────────────────────────────────────

const KYC_STATUS_CONFIG: Record<KYCStatusLocal, { label: string; badgeCls: string; icon: React.ReactNode }> = {
  NOT_STARTED:      { label: 'KYC Pending',    badgeCls: 'bg-gray-100 text-gray-600',        icon: <AlertCircle  className="w-3 h-3" /> },
  IN_PROGRESS:      { label: 'In Progress',    badgeCls: 'bg-blue-100 text-blue-700',         icon: <Clock        className="w-3 h-3" /> },
  SUBMITTED:        { label: 'Submitted',      badgeCls: 'bg-purple-100 text-purple-700',     icon: <Clock        className="w-3 h-3" /> },
  APPROVED:         { label: 'KYC Approved',   badgeCls: 'bg-green-100 text-green-700',       icon: <CheckCircle  className="w-3 h-3" /> },
  REJECTED:         { label: 'Rejected',       badgeCls: 'bg-red-100 text-red-700',           icon: <XCircle      className="w-3 h-3" /> },
  RE_KYC_REQUIRED:  { label: 'Re-KYC Required',badgeCls: 'bg-amber-100 text-amber-700',       icon: <RefreshCw    className="w-3 h-3" /> },
};

const TYPE_COLORS: Record<string, string> = {
  SSS:     'bg-gray-100 text-gray-600',
  WHOLESALER:   'bg-blue-50 text-blue-700',
  SUB_STOCKIST: 'bg-purple-50 text-purple-700',
  SSS_TOT:      'bg-indigo-50 text-indigo-700',
};

// ─── Shared upload hook ────────────────────────────────────────────────────────

type UploadState = 'idle' | 'parsed' | 'confirmed';

// ─── Validation panel component ────────────────────────────────────────────────

function ValidationPanel<R extends { rowNum: number; outletId: string; status: string; errors: string[] }>({
  testId,
  result,
  onConfirm,
  onClear,
  confirmLabel = 'Confirm Upload',
}: {
  testId:        string;
  result:        { headerError: string | null; rows: R[]; hasErrors: boolean; canProceed: boolean; summary: Record<string, number> };
  onConfirm:     () => void;
  onClear:       () => void;
  confirmLabel?: string;
}) {
  if (result.headerError) {
    return (
      <div data-testid={testId} className="bg-red-50 border border-red-200 rounded-xl p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-700">Header Error</p>
            <p className="text-xs text-red-600 mt-1">{result.headerError}</p>
          </div>
        </div>
        <button onClick={onClear} className="mt-3 text-xs text-red-600 hover:underline">Clear and try again</button>
      </div>
    );
  }

  return (
    <div data-testid={testId} className="space-y-3">
      {/* Summary chips */}
      <div className="grid grid-cols-3 gap-3">
        {Object.entries(result.summary).map(([k, v]) => (
          <div key={k} className={`p-3 rounded-xl border text-center ${k === 'errors' && (v as number) > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
            <p className={`text-xl font-bold ${k === 'errors' && (v as number) > 0 ? 'text-red-700' : 'text-gray-800'}`}>{v as number}</p>
            <p className={`text-xs mt-0.5 capitalize ${k === 'errors' && (v as number) > 0 ? 'text-red-600' : 'text-gray-500'}`}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</p>
          </div>
        ))}
      </div>

      {/* Row results */}
      {result.rows.length > 0 && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto max-h-64">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Row</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Outlet ID</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.rows.map((r) => (
                  <tr key={r.rowNum} className={r.status === 'ERROR' ? 'bg-red-50' : 'bg-white'}>
                    <td className="px-3 py-2 text-gray-500">{r.rowNum}</td>
                    <td className="px-3 py-2 font-mono text-gray-700">{r.outletId || '—'}</td>
                    <td className="px-3 py-2">
                      {r.status === 'OK'
                        ? <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />OK</span>
                        : <span className="text-red-600 flex items-center gap-1"><AlertCircle className="w-3 h-3" />Error</span>
                      }
                    </td>
                    <td className="px-3 py-2 text-red-600">{r.errors.join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result.hasErrors && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Fix all errors in the Excel file and re-upload. The file will not be processed until all rows are valid.</span>
        </div>
      )}

      <div className="flex gap-3">
        <button onClick={onClear} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors">
          Clear
        </button>
        {result.canProceed && (
          <button
            data-testid="confirm-outlet-upload-btn"
            onClick={onConfirm}
            className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:bg-[var(--brand-primary-dark)] transition-colors"
          >
            {confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Success panel ─────────────────────────────────────────────────────────────

function SuccessPanel({ message, onDone }: { message: string; onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
        <CheckCircle2 className="w-6 h-6 text-green-600" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900">{message}</p>
        <p className="text-xs text-gray-500 mt-1">Data has been processed and the outlet list will reflect changes momentarily.</p>
      </div>
      <button onClick={onDone} className="px-5 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)]">
        Done
      </button>
    </div>
  );
}

// ─── Upload section component ──────────────────────────────────────────────────

function UploadSection({
  testIdInput,
  testIdPanel,
  onFileChange,
  validationResult,
  uploadState,
  onConfirm,
  onClear,
  confirmLabel,
}: {
  testIdInput:       string;
  testIdPanel:       string;
  onFileChange:      (file: File) => void;
  validationResult:  OutletUploadValidationResult | ReKYCFlagValidationResult | OutletDeactivateValidationResult | null;
  uploadState:       UploadState;
  onConfirm:         () => void;
  onClear:           () => void;
  confirmLabel?:     string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!file.name.endsWith('.xlsx')) {
      setFileError('Only .xlsx files are accepted. CSV is not supported as it cannot hold multiple sheets.');
      return;
    }
    setFileError('');
    onFileChange(file);
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        data-testid={testIdInput}
        className="hidden"
        onChange={handleChange}
      />

      {fileError && (
        <div data-testid="file-type-error" className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{fileError}</span>
        </div>
      )}

      {uploadState === 'idle' && !fileError && (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full border-2 border-dashed border-gray-200 rounded-xl py-10 flex flex-col items-center gap-3 hover:border-[var(--brand-primary)]/40 hover:bg-green-50/30 transition-colors"
        >
          <Upload className="w-8 h-8 text-gray-300" />
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">Drop your XLSX file here or click to browse</p>
            <p className="text-xs text-gray-400 mt-1">Only .xlsx format accepted · Max 500 rows</p>
          </div>
        </button>
      )}

      {uploadState === 'idle' && fileError && (
        <button
          type="button"
          onClick={() => { setFileError(''); fileRef.current?.click(); }}
          className="mt-2 text-sm text-[var(--brand-primary)] hover:underline"
        >
          Try again
        </button>
      )}

      {(uploadState === 'parsed' || uploadState === 'confirmed') && validationResult && (
        uploadState === 'confirmed' ? (
          <SuccessPanel
            message="Upload processed successfully"
            onDone={onClear}
          />
        ) : (
          <ValidationPanel
            testId={testIdPanel}
            result={validationResult as any}
            onConfirm={onConfirm}
            onClear={onClear}
            confirmLabel={confirmLabel}
          />
        )
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

type TabId = 'master' | 'rekyc' | 'deactivate';

export default function OutletsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('master');

  // Outlet list state
  const [outlets]                     = useState<MockOutlet[]>(MOCK_OUTLETS);
  const [search,        setSearch]    = useState('');
  const [kycFilter,     setKycFilter] = useState<KYCStatusLocal | 'ALL'>('ALL');

  // Outlet master (upsert) upload state
  const [outletValidation, setOutletValidation] = useState<OutletUploadValidationResult | null>(null);
  const [outletUploadState, setOutletUploadState] = useState<UploadState>('idle');

  // Re-KYC upload state
  const [rekycValidation, setRekycValidation] = useState<ReKYCFlagValidationResult | null>(null);
  const [rekycUploadState, setRekycUploadState] = useState<UploadState>('idle');

  // Deactivate upload state
  const [deactivateValidation, setDeactivateValidation] = useState<OutletDeactivateValidationResult | null>(null);
  const [deactivateUploadState, setDeactivateUploadState] = useState<UploadState>('idle');

  // ── Derived stats ──
  const stats = useMemo(() => ({
    total:       outlets.length,
    notStarted:  outlets.filter(o => o.kycStatus === 'NOT_STARTED').length,
    inProgress:  outlets.filter(o => o.kycStatus === 'IN_PROGRESS' || o.kycStatus === 'SUBMITTED').length,
    approved:    outlets.filter(o => o.kycStatus === 'APPROVED').length,
    rejected:    outlets.filter(o => o.kycStatus === 'REJECTED').length,
    rekyc:       outlets.filter(o => o.kycStatus === 'RE_KYC_REQUIRED').length,
  }), [outlets]);

  // ── Tab switch — resets upload state to prevent stale panels ──
  const handleTabSwitch = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    setOutletValidation(null);    setOutletUploadState('idle');
    setRekycValidation(null);     setRekycUploadState('idle');
    setDeactivateValidation(null); setDeactivateUploadState('idle');
  }, []);

  // ── Filtered list ──
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return outlets.filter(o => {
      const matchSearch = !search ||
        o.outletId.toLowerCase().includes(q) ||
        o.outletName.toLowerCase().includes(q) ||
        o.xsrName.toLowerCase().includes(q) ||
        o.city.toLowerCase().includes(q) ||
        o.beat.toLowerCase().includes(q);
      const matchKyc = kycFilter === 'ALL' || o.kycStatus === kycFilter;
      return matchSearch && matchKyc;
    });
  }, [outlets, search, kycFilter]);

  // ── File parsers ──
  const parseXlsx = useCallback((file: File): Promise<Record<string, string>[]> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data     = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          // Find the data sheet (skip Dos & Don'ts) — H1 fix
          const DATA_SHEET_EXCLUDES = new Set(["Dos & Don'ts"]);
          const sheetName = workbook.SheetNames.find(n => !DATA_SHEET_EXCLUDES.has(n));
          if (!sheetName) {
            reject(new Error('No data sheet found. Please use the provided template.'));
            return;
          }
          const sheet = workbook.Sheets[sheetName];
          const rows      = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }, []);

  // ── Handle outlet master upload (CREATE / UPDATE / REACTIVATE upsert) ──
  const handleOutletFile = useCallback(async (file: File) => {
    try {
      const rows     = await parseXlsx(file);
      const headers  = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateOutletUploadHeaders(headers);
      if (headerErr) {
        setOutletValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, creates: 0, updates: 0, reactivates: 0, errors: 0 } });
        setOutletUploadState('parsed');
        return;
      }
      const parsed   = parseOutletUploadRows(rows as Record<string, string>[]);
      const existing = outlets.map(o => ({ outletId: o.outletId, isActive: o.isActive }));
      const result   = validateOutletUpload(parsed, existing, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
      setOutletValidation(result);
      setOutletUploadState('parsed');
    } catch {
      setOutletValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, creates: 0, updates: 0, reactivates: 0, errors: 0 } });
      setOutletUploadState('parsed');
    }
  }, [outlets, parseXlsx]);

  // ── Handle re-KYC upload ──
  const handleReKYCFile = useCallback(async (file: File) => {
    try {
      const rows    = await parseXlsx(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateReKYCFlagHeaders(headers);
      if (headerErr) {
        setRekycValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, flagged: 0, errors: 0 } });
        setRekycUploadState('parsed');
        return;
      }
      const parsed          = parseReKYCFlagRows(rows as Record<string, string>[]);
      const existingOutlets = outlets.map(o => ({ outletId: o.outletId, kycStatus: o.kycStatus as unknown as KYCStatus }));
      const result          = validateReKYCFlagUpload(parsed, existingOutlets);
      setRekycValidation(result);
      setRekycUploadState('parsed');
    } catch {
      setRekycValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, flagged: 0, errors: 0 } });
      setRekycUploadState('parsed');
    }
  }, [outlets, parseXlsx]);

  // ── Handle deactivate upload ──
  const handleDeactivateFile = useCallback(async (file: File) => {
    try {
      const rows    = await parseXlsx(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateDeactivateHeaders(headers);
      if (headerErr) {
        setDeactivateValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, deactivates: 0, errors: 0 } });
        setDeactivateUploadState('parsed');
        return;
      }
      const parsed   = parseDeactivateRows(rows as Record<string, string>[]);
      const existing = outlets.map(o => ({ outletId: o.outletId, isActive: o.isActive }));
      const result   = validateDeactivateUpload(parsed, existing);
      setDeactivateValidation(result);
      setDeactivateUploadState('parsed');
    } catch {
      setDeactivateValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, deactivates: 0, errors: 0 } });
      setDeactivateUploadState('parsed');
    }
  }, [outlets, parseXlsx]);

  // ── Download helpers ──
  function downloadXlsx(wb: XLSX.WorkBook, filename: string) {
    const buf   = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob  = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadOutletTemplate() {
    const { headers, exampleRows, dosAndDonts } = getOutletAdditionTemplateData(VALID_PROGRAMS, VALID_CATEGORIES, LEAF_ROLE_CODE);
    const wb = XLSX.utils.book_new();
    // Sheet 1: Dos & Don'ts (opens first)
    const ddSheet = XLSX.utils.aoa_to_sheet(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    // Sheet 2: Data
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
    dataSheet['!cols'] = headers.map(h => ({ wch: h.includes('Name') ? 28 : h.includes('Manager') ? 34 : 20 }));
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Outlet Upload');
    downloadXlsx(wb, 'outlet-master-template.xlsx');
  }

  function downloadReKYCTemplate() {
    const { headers, exampleRows, dosAndDonts } = getReKYCFlagTemplateData();
    const wb = XLSX.utils.book_new();
    const ddSheet = XLSX.utils.aoa_to_sheet(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
    dataSheet['!cols'] = headers.map(h => ({ wch: h.includes('Document') ? 30 : h === 'Outlet ID' ? 18 : 22 }));
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Re-KYC Flags');
    downloadXlsx(wb, 'outlet-rekyc-flags-template.xlsx');
  }

  function downloadDeactivateTemplate() {
    const { headers, exampleRows, dosAndDonts } = getDeactivateTemplateData();
    const wb = XLSX.utils.book_new();
    const ddSheet = XLSX.utils.aoa_to_sheet(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
    dataSheet['!cols'] = [{ wch: 22 }];
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Deactivate Upload');
    downloadXlsx(wb, 'outlet-deactivation-template.xlsx');
  }

  function downloadGuide() {
    const html = generateOutletGuideHtml();
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'outlet-management-guide.html';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Tab config ──
  const tabs: { id: TabId; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'master',     label: 'Outlet Master',      icon: <Store className="w-4 h-4" />,    count: outlets.length },
    { id: 'rekyc',      label: 'Re-KYC Flagging',    icon: <RefreshCw className="w-4 h-4" /> },
    { id: 'deactivate', label: 'Deactivate Outlets', icon: <XCircle className="w-4 h-4" />   },
  ];

  const inputCls  = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';

  return (
    <div className="space-y-5 fade-in">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 role="heading" className="text-xl font-bold text-gray-900">Outlet Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Add or update outlets, flag for re-KYC, and manage activations
          </p>
        </div>
        <button
          data-testid="download-outlet-guide"
          onClick={downloadGuide}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors shrink-0"
        >
          <FileText className="w-4 h-4" />
          Operations Guide
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 w-fit">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => handleTabSwitch(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === t.id ? 'bg-[var(--brand-primary)] text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === t.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
              }`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ═══════════════ OUTLET MASTER TAB ═══════════════ */}
      {activeTab === 'master' && (
        <div className="space-y-5">

          {/* Download Outlet Master */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Outlet Master</h2>
              <p className="text-xs text-gray-400 mt-0.5">Complete outlet dump with KYC, banking, hierarchy, and lifecycle data</p>
            </div>
            <button
              data-testid="download-outlet-master"
              onClick={async () => {
                try {
                  const token = localStorage.getItem('token');
                  const res = await fetch('/api/admin/reports/outlet-master', {
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  if (!res.ok) return;
                  const blob = await res.blob();
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement('a');
                  a.href     = url;
                  a.download = `outlet-master-${new Date().toISOString().split('T')[0]}.xlsx`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch { /* ignore */ }
              }}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 transition-colors shrink-0"
            >
              <Download className="w-4 h-4" /> Download Outlet Master
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            {[
              { testId: 'stat-total-outlets', label: 'Total',       value: stats.total,      cls: 'text-gray-600 bg-gray-100',    filter: 'ALL'             },
              { testId: 'stat-pending-kyc',   label: 'KYC Pending', value: stats.notStarted, cls: 'text-gray-600 bg-gray-100',    filter: 'NOT_STARTED'     },
              { testId: 'stat-in-progress',   label: 'In Progress', value: stats.inProgress, cls: 'text-blue-600 bg-blue-100',    filter: 'IN_PROGRESS'     },
              { testId: 'stat-approved',      label: 'Approved',    value: stats.approved,   cls: 'text-green-600 bg-green-100',  filter: 'APPROVED'        },
              { testId: 'stat-rejected',      label: 'Rejected',    value: stats.rejected,   cls: 'text-red-600 bg-red-100',      filter: 'REJECTED'        },
              { testId: 'stat-rekyc',         label: 'Re-KYC',      value: stats.rekyc,      cls: 'text-amber-600 bg-amber-100',  filter: 'RE_KYC_REQUIRED' },
            ].map(s => (
              <button
                key={s.testId}
                data-testid={s.testId}
                onClick={() => setKycFilter(s.filter as KYCStatusLocal | 'ALL')}
                className={`bg-white border border-gray-200 rounded-xl p-3 flex items-center gap-2 hover:shadow-md transition-all text-left ${
                  kycFilter === s.filter ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/20' : ''
                }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.cls} shrink-0`}>
                  <Store className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-lg font-bold text-gray-900">{s.value}</p>
                  <p className="text-xs text-gray-500">{s.label}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Upload + search bar */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Upload className="w-4 h-4 text-[var(--brand-primary)]" />
                  Outlet Master Upload
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  New Outlet ID → create · Existing + active → update fields · Existing + inactive → reactivate
                </p>
              </div>
              <button
                data-testid="download-outlet-template"
                onClick={downloadOutletTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Download Template
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 space-y-1">
              <p className="font-semibold">How upsert works</p>
              <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                <li><strong>New Outlet ID</strong> → outlet is created (all required fields must be filled)</li>
                <li><strong>Existing active Outlet ID</strong> → only the fields you fill are updated; blank = keep existing</li>
                <li><strong>Existing inactive Outlet ID</strong> → outlet is reactivated; any filled fields are also updated</li>
                <li><strong>Outlet Name cannot be changed here</strong> — use Re-KYC Flagging to request a name correction</li>
                <li><strong>XSR ID</strong> must be an ISR-level employee if provided</li>
              </ul>
            </div>

            <UploadSection
              testIdInput="outlet-upload-input"
              testIdPanel="outlet-validation-panel"
              onFileChange={handleOutletFile}
              validationResult={outletValidation}
              uploadState={outletUploadState}
              onConfirm={() => setOutletUploadState('confirmed')}
              onClear={() => { setOutletValidation(null); setOutletUploadState('idle'); }}
              confirmLabel="Apply Changes"
            />
          </div>

          {/* Search + filter */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  data-testid="outlet-search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by ID, name, ISR, beat, city…"
                  className={`w-full pl-9 pr-3 py-2 ${inputCls}`}
                />
              </div>
              <select
                value={kycFilter}
                onChange={e => setKycFilter(e.target.value as KYCStatusLocal | 'ALL')}
                className={inputCls}
              >
                <option value="ALL">All KYC Statuses</option>
                <option value="NOT_STARTED">KYC Pending</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="SUBMITTED">Submitted</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="RE_KYC_REQUIRED">Re-KYC Required</option>
              </select>
            </div>
          </div>

          {/* Outlet table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Outlet</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Program</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Location</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Assigned ISR</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">KYC Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-16 text-center">
                        <Store className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                        <p className="text-sm text-gray-400">No outlets match your filters</p>
                      </td>
                    </tr>
                  ) : filtered.map(o => {
                    const sc = KYC_STATUS_CONFIG[o.kycStatus];
                    return (
                      <tr key={o.outletId} data-testid="outlet-row" className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 bg-gray-100 rounded-full flex items-center justify-center shrink-0">
                              <Building2 className="w-3.5 h-3.5 text-gray-500" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                              <p className="text-xs font-mono text-gray-400">{o.outletId}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TYPE_COLORS[o.outletType] ?? 'bg-gray-100 text-gray-600'}`}>
                            {o.outletType}
                          </span>
                          {o.metro && <span className="ml-1 text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-full">Metro</span>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-xs font-medium text-gray-700">{o.programName}</p>
                          <p className="text-[11px] text-gray-400">{o.programCategory}</p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-1">
                            <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-xs font-medium text-gray-700">{o.beat}</p>
                              <p className="text-[11px] text-gray-400">{o.city}, {o.state}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Users className="w-3 h-3 text-[var(--brand-primary)] shrink-0" />
                            <div>
                              <p className="text-xs font-medium text-gray-800">{o.xsrName}</p>
                              <p className="text-[11px] font-mono text-gray-400">{o.xsrId}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span data-testid="kyc-status-badge" className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${sc.badgeCls}`}>
                            {sc.icon}
                            {sc.label}
                          </span>
                          {o.isActive && (
                            <p className="text-[10px] text-green-600 mt-0.5 flex items-center gap-1">
                              <Eye className="w-2.5 h-2.5" /> Active
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{o.addedDate}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-500">
                Showing {filtered.length} of {outlets.length} outlets ·{' '}
                {stats.approved} active · {stats.notStarted} awaiting KYC · {stats.rekyc} re-KYC pending
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ RE-KYC TAB ═══════════════ */}
      {activeTab === 'rekyc' && (
        <div data-testid="rekyc-upload-section" className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-[var(--brand-primary)]" />
                  Flag Outlets for Re-KYC
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Mark which KYC fields need to be re-captured for specific outlets. The sales team will see a Re-KYC Required badge and must re-fill only the flagged fields. Outlet stays active throughout. Use this flow to request an Outlet Name correction.
                </p>
              </div>
              <button
                data-testid="download-rekyc-template"
                onClick={downloadReKYCTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Template
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 space-y-1">
              <p className="font-semibold">How this works</p>
              <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                <li>Enter <strong>Yes</strong> in any column whose data needs to be re-captured</li>
                <li>At least one field must be marked Yes per row</li>
                <li>Add a Remarks note so the sales team understands why re-KYC is needed</li>
                <li><strong>Outlet Name</strong> — mark Yes here to request a name correction; it goes through the KYC approval chain</li>
                <li>Document fields (Owner Photo, Address Proof, etc.) must be re-uploaded via the KYC form — not via Excel</li>
              </ul>
            </div>

            <UploadSection
              testIdInput="rekyc-upload-input"
              testIdPanel="rekyc-validation-panel"
              onFileChange={handleReKYCFile}
              validationResult={rekycValidation}
              uploadState={rekycUploadState}
              onConfirm={() => setRekycUploadState('confirmed')}
              onClear={() => { setRekycValidation(null); setRekycUploadState('idle'); }}
              confirmLabel="Flag for Re-KYC"
            />
          </div>

          {/* Outlets currently flagged for re-KYC */}
          {outlets.some(o => o.kycStatus === 'RE_KYC_REQUIRED') && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-amber-50">
                <p className="text-xs font-semibold text-amber-700 flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5" />
                  Currently flagged for re-KYC ({outlets.filter(o => o.kycStatus === 'RE_KYC_REQUIRED').length})
                </p>
              </div>
              <div className="divide-y divide-gray-50">
                {outlets.filter(o => o.kycStatus === 'RE_KYC_REQUIRED').map(o => (
                  <div key={o.outletId} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 bg-amber-100 rounded-full flex items-center justify-center shrink-0">
                        <Building2 className="w-3.5 h-3.5 text-amber-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                        <p className="text-xs text-gray-400 font-mono">{o.outletId} · {o.xsrName}</p>
                      </div>
                    </div>
                    <span className="text-xs text-amber-700 bg-amber-100 px-2 py-1 rounded-full font-medium flex items-center gap-1 shrink-0">
                      <RefreshCw className="w-3 h-3" /> Re-KYC Required
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ DEACTIVATE TAB ═══════════════ */}
      {activeTab === 'deactivate' && (
        <div data-testid="deactivate-upload-section" className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-red-500" />
                  Deactivate Outlets
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Upload a list of Outlet IDs to mark them inactive. Inactive outlets are removed from the sales team's KYC queue and excluded from target calculations. Only currently-active outlets can be deactivated. To reactivate, upload the outlet via Outlet Master.
                </p>
              </div>
              <button
                data-testid="download-deactivate-template"
                onClick={downloadDeactivateTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Template
              </button>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 space-y-1">
              <p className="font-semibold">⚠ Important — this action cannot be undone via upload</p>
              <ul className="list-disc list-inside space-y-0.5 text-red-600">
                <li>Only Outlet IDs that exist in the system are accepted</li>
                <li>Outlets already inactive will be rejected — do not include them</li>
                <li>Coordinate with the field team before deactivating — the assigned ISR loses access immediately</li>
                <li>Open KYC submissions for deactivated outlets must be handled manually</li>
              </ul>
            </div>

            <UploadSection
              testIdInput="deactivate-upload-input"
              testIdPanel="deactivate-validation-panel"
              onFileChange={handleDeactivateFile}
              validationResult={deactivateValidation}
              uploadState={deactivateUploadState}
              onConfirm={() => setDeactivateUploadState('confirmed')}
              onClear={() => { setDeactivateValidation(null); setDeactivateUploadState('idle'); }}
              confirmLabel="Deactivate Outlets"
            />
          </div>

          {/* Currently active outlets quick reference */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-600 flex items-center gap-2">
                <Eye className="w-3.5 h-3.5" />
                Active outlets ({outlets.filter(o => o.isActive).length}) — these can be deactivated
              </p>
            </div>
            <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
              {outlets.filter(o => o.isActive).map(o => (
                <div key={o.outletId} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                      <Building2 className="w-3.5 h-3.5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                      <p className="text-xs text-gray-400 font-mono">{o.outletId} · {o.city}</p>
                    </div>
                  </div>
                  <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded-full font-medium flex items-center gap-1 shrink-0">
                    <Eye className="w-3 h-3" /> Active
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
