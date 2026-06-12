'use client';

import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  Users, Download, Upload, Search, AlertTriangle, CheckCircle,
  XCircle, FileSpreadsheet, BookOpen, ArrowLeft, Info, ChevronDown,
  ChevronRight, Shield, UserCheck, UserX,
} from 'lucide-react';
import Link from 'next/link';
import * as XLSX from 'xlsx';
import {
  validateHeaders,
  validateEmployeeUpload,
  parseUploadRows,
  getEmployees,
  saveEmployees,
  DEOLEO_HIERARCHY,
  getTemplateData,
  generateGuideHtml,
} from '@/lib/employee-hierarchy';
import type {
  HierarchyEmployee,
  EmployeeUploadValidationResult,
  EmployeeRowValidationResult,
} from '@/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG = DEOLEO_HIERARCHY;

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label, value, testId, accent = false,
}: { label: string; value: number; testId: string; accent?: boolean }) {
  return (
    <div className={`bg-white rounded-xl border px-4 py-3 flex flex-col gap-0.5 ${accent ? 'border-red-200' : 'border-gray-200'}`}>
      <p data-testid={testId} className={`text-2xl font-bold ${accent ? 'text-red-600' : 'text-gray-900'}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: HierarchyEmployee['status'] }) {
  return (
    <span
      data-testid="status-badge"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
        status === 'ACTIVE'
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-amber-100 text-amber-700'
      }`}
    >
      {status === 'ACTIVE'
        ? <UserCheck className="h-2.5 w-2.5" />
        : <UserX className="h-2.5 w-2.5" />
      }
      {status}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-block bg-blue-50 text-blue-700 text-[10px] font-bold px-1.5 py-0.5 rounded">
      {role}
    </span>
  );
}

function ValidationRowItem({ row }: { row: EmployeeRowValidationResult }) {
  const [expanded, setExpanded] = useState(false);
  const isOk = row.status === 'OK';
  const isWarn = row.status === 'WARNING';

  return (
    <div
      className={`border rounded-lg text-sm overflow-hidden ${
        isOk ? 'border-emerald-200' : isWarn ? 'border-amber-200' : 'border-red-200'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left ${
          isOk ? 'bg-emerald-50' : isWarn ? 'bg-amber-50' : 'bg-red-50'
        }`}
      >
        <span className="w-14 text-xs text-gray-500 flex-shrink-0">Row {row.rowNum}</span>
        {isOk
          ? <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0" />
          : isWarn
            ? <Info className="h-4 w-4 text-amber-600 flex-shrink-0" />
            : <XCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
        }
        <span className="font-mono text-xs font-semibold flex-1 truncate">{row.employeeId || '(blank)'}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
          row.action === 'CREATE'
            ? 'bg-blue-100 text-blue-700'
            : row.action === 'UPDATE_INFO'
              ? 'bg-purple-100 text-purple-700'
              : row.action === 'UPDATE_HIERARCHY'
                ? 'bg-orange-100 text-orange-700'
                : 'bg-gray-100 text-gray-500'
        }`}>
          {row.action}
        </span>
        {(row.errors.length > 0 || row.warnings.length > 0) && (
          expanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                   : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
        )}
      </button>
      {expanded && (row.errors.length > 0 || row.warnings.length > 0) && (
        <div className="px-3 py-2.5 border-t border-current/10 space-y-1">
          {row.errors.map((e, i) => (
            <p key={i} className="text-xs text-red-700 flex gap-2">
              <span className="mt-0.5 flex-shrink-0">✕</span>{e}
            </p>
          ))}
          {row.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-700 flex gap-2">
              <span className="mt-0.5 flex-shrink-0">!</span>{w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Downloads ────────────────────────────────────────────────────────────────

function downloadTemplate() {
  const { headers, exampleRows, dosAndDontsRows } = getTemplateData(CONFIG);

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Dos & Don'ts ── opens first so users read it before data entry
  const ddSheet = XLSX.utils.aoa_to_sheet(dosAndDontsRows);
  ddSheet['!cols'] = [
    { wch: 28 },   // Col A — label / symbol
    { wch: 90 },   // Col B — explanation
  ];
  XLSX.utils.book_append_sheet(wb, ddSheet, 'Dos & Don\'ts');

  // ── Sheet 2: Employee Upload ── the actual data entry sheet
  const dataRows = [headers as unknown as string[], ...exampleRows];
  const dataSheet = XLSX.utils.aoa_to_sheet(dataRows);
  dataSheet['!cols'] = headers.map((h) => ({
    // Wider columns for the ID and explanation columns
    wch: h.includes('Manager') ? 34 : h === 'Employee Name' ? 26 : 22,
  }));
  XLSX.utils.book_append_sheet(wb, dataSheet, 'Employee Upload');

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob   = new Blob(
    [buffer],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  );
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Employee_Hierarchy_Upload_Template.xlsx';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function downloadGuide() {
  const html  = generateGuideHtml(CONFIG);
  const blob  = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url   = URL.createObjectURL(blob);
  const link  = document.createElement('a');
  link.href = url;
  link.download = 'Employee_Hierarchy_Operations_Guide.html';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HierarchyPage() {
  const [employees, setEmployees] = useState<HierarchyEmployee[]>(() => getEmployees());
  const [search, setSearch] = useState('');
  const [validation, setValidation] = useState<EmployeeUploadValidationResult | null>(null);
  const [pendingRows, setPendingRows] = useState<Record<string, string>[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const totalCount       = employees.length;
  const activeCount      = employees.filter(e => e.status === 'ACTIVE').length;
  const placeholderCount = employees.filter(e => e.status === 'PLACEHOLDER').length;

  // ── Filtered employee list ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(e =>
      e.id.toLowerCase().includes(q) ||
      (e.name  ?? '').toLowerCase().includes(q) ||
      (e.mobile ?? '').includes(q),
    );
  }, [employees, search]);

  // ── File parsing ───────────────────────────────────────────────────────────
  const processFile = useCallback((file: File) => {
    setParseError(null);
    setValidation(null);
    setPendingRows([]);
    setSuccessMsg(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data     = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        const rawRows  = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });

        if (rawRows.length === 0) {
          setParseError('The uploaded file has no data rows.');
          return;
        }

        // Pass 1: headers
        const headers = Object.keys(rawRows[0]);
        const headerErr = validateHeaders(headers);
        if (headerErr) {
          setValidation({
            headerError: headerErr,
            rows: [],
            hasErrors: true,
            canProceed: false,
            summary: { total: 0, creates: 0, updates: 0, errors: 1 },
          });
          return;
        }

        // Pass 2: rows
        const uploadRows = parseUploadRows(rawRows);
        const result     = validateEmployeeUpload(uploadRows, employees, CONFIG);

        setValidation(result);
        setPendingRows(rawRows);
      } catch {
        setParseError('Could not read the file. Please ensure it is a valid Excel (.xlsx) file.');
      }
    };
    reader.readAsArrayBuffer(file);
  }, [employees]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    // Reset input so the same file can be re-uploaded after fixing
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  // ── Confirm upload ─────────────────────────────────────────────────────────
  const confirmUpload = () => {
    if (!validation?.canProceed) return;
    setConfirming(true);

    // Apply changes from pending rows to employees list
    const uploadRows = parseUploadRows(pendingRows);
    const updatedMap = new Map<string, HierarchyEmployee>(
      employees.map(e => [e.id, e]),
    );

    for (const row of uploadRows) {
      const id      = row.employeeId.trim();
      const roleL   = CONFIG.find(l => l.roleCode.toUpperCase() === row.hierarchy.toUpperCase());
      const isLeaf  = roleL?.isLeaf ?? false;
      const isRoot  = roleL?.isRoot ?? false;
      const status: HierarchyEmployee['status'] =
        row.employeeName.trim() || row.employeePhone.trim() ? 'ACTIVE' : 'PLACEHOLDER';

      const existing = updatedMap.get(id);
      const newEmp: HierarchyEmployee = {
        id,
        tenantId:   'deoleo',
        roleCode:   roleL?.roleCode ?? row.hierarchy.trim().toUpperCase(),
        roleLabel:  roleL?.roleLabel ?? row.hierarchy.trim().toUpperCase(),
        reportsToId: isRoot ? null : (row.reportingManagerEmployeeId.trim() || null),
        hierarchyPath: existing?.hierarchyPath ?? `/${id}/`, // simplified for demo
        name:    row.employeeName.trim()  || null,
        mobile:  row.employeePhone.trim() || null,
        status,
        hasOutlets:   existing?.hasOutlets    ?? isLeaf,
        hasSubReports: existing?.hasSubReports ?? false,
      };
      updatedMap.set(id, newEmp);
    }

    const newList = Array.from(updatedMap.values());
    setEmployees(newList);
    saveEmployees(newList);

    const { creates, updates } = validation.summary;
    setSuccessMsg(
      `Upload confirmed: ${creates} employee${creates !== 1 ? 's' : ''} created, ` +
      `${updates} updated.`,
    );
    setValidation(null);
    setPendingRows([]);
    setConfirming(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/dashboard" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Users className="h-5 w-5 text-[var(--brand-primary)]" />
            Employee Hierarchy
          </h1>
          <p className="text-xs text-gray-500">
            Manage sales team structure · Bulk upload via Excel
          </p>
        </div>
        <div className="flex gap-2">
          <button
            data-testid="download-guide"
            onClick={downloadGuide}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50 transition-colors"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Download Guide
          </button>
          <button
            data-testid="download-template"
            onClick={downloadTemplate}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Download Template
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Total Positions"  value={totalCount}       testId="stat-total" />
        <StatCard label="Active"           value={activeCount}      testId="stat-active" />
        <StatCard label="Placeholders"     value={placeholderCount} testId="stat-placeholder" accent />
      </div>

      {/* Success banner */}
      {successMsg && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0" />
          <p className="text-sm text-emerald-800 font-medium">{successMsg}</p>
          <button
            onClick={() => setSuccessMsg(null)}
            className="ml-auto p-1 rounded hover:bg-emerald-100 text-emerald-600"
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Upload section */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Upload className="h-4 w-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Upload Employee Hierarchy</p>
        </div>

        {/* Drag & drop area */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`mx-4 my-4 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            isDragOver ? 'border-[var(--brand-primary)] bg-red-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <FileSpreadsheet className="h-8 w-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600">
            Drag & drop your Excel file here, or click to browse
          </p>
          <p className="text-xs text-gray-400 mt-1">
            .xlsx only — CSV is not supported · Always use the provided template
          </p>
          <input
            data-testid="hierarchy-upload-input"
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        {/* Parse error */}
        {parseError && (
          <div className="mx-4 mb-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-700">{parseError}</p>
          </div>
        )}

        {/* Validation panel */}
        {validation && (
          <div data-testid="validation-panel" className="mx-4 mb-4 space-y-3">
            {/* Header error (Pass 1 failure) */}
            {validation.headerError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="h-4 w-4 text-red-600" />
                  <p className="text-sm font-semibold text-red-800">Header Error — Upload Rejected</p>
                </div>
                <p className="text-sm text-red-700">{validation.headerError}</p>
                <p className="text-xs text-red-600 mt-2">
                  Download the template to get the correct column headers, then re-upload.
                </p>
              </div>
            )}

            {/* Summary */}
            {!validation.headerError && (
              <>
                <div className={`rounded-xl p-4 border ${
                  validation.hasErrors
                    ? 'bg-red-50 border-red-200'
                    : 'bg-emerald-50 border-emerald-200'
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {validation.hasErrors
                        ? <XCircle className="h-4 w-4 text-red-600" />
                        : <CheckCircle className="h-4 w-4 text-emerald-600" />
                      }
                      <p className={`text-sm font-semibold ${
                        validation.hasErrors ? 'text-red-800' : 'text-emerald-800'
                      }`}>
                        {validation.hasErrors
                          ? `${validation.summary.errors} row${validation.summary.errors !== 1 ? 's' : ''} with errors — fix and re-upload`
                          : 'All rows valid — ready to confirm'
                        }
                      </p>
                    </div>
                    <div className="flex gap-3 text-xs text-gray-500">
                      <span>{validation.summary.total} rows</span>
                      <span className="text-blue-600 font-medium">+{validation.summary.creates} new</span>
                      <span className="text-purple-600 font-medium">~{validation.summary.updates} updates</span>
                    </div>
                  </div>
                </div>

                {/* Row results */}
                <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {validation.rows.map(row => (
                    <ValidationRowItem key={`${row.rowNum}-${row.employeeId}`} row={row} />
                  ))}
                </div>

                {/* Confirm button */}
                {validation.canProceed && (
                  <button
                    data-testid="confirm-upload-btn"
                    onClick={confirmUpload}
                    disabled={confirming}
                    className="w-full py-2.5 rounded-xl bg-[var(--brand-primary)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
                  >
                    {confirming ? 'Applying changes…' : `Confirm Upload (${validation.summary.creates + validation.summary.updates} changes)`}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Search + Employee list */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            data-testid="employee-search"
            type="text"
            placeholder="Search by Employee ID, Name, or Phone…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
              <XCircle className="h-4 w-4" />
            </button>
          )}
          <span className="text-xs text-gray-400 flex-shrink-0">{filtered.length} of {totalCount}</span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Users className="h-8 w-8 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">No employees match "{search}"</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(emp => (
              <div
                key={emp.id}
                data-testid="employee-row"
                className="px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  {/* Role badge + ID */}
                  <div className="flex-shrink-0 w-16">
                    <RoleBadge role={emp.roleCode} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-semibold text-gray-900">{emp.id}</span>
                      <StatusBadge status={emp.status} />
                      {emp.hasOutlets && (
                        <span className="text-[10px] bg-violet-50 text-violet-700 px-1.5 py-0.5 rounded font-medium">
                          has outlets
                        </span>
                      )}
                      {emp.hasSubReports && (
                        <span className="text-[10px] bg-sky-50 text-sky-700 px-1.5 py-0.5 rounded font-medium">
                          has sub-reports
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-700 mt-0.5">
                      {emp.name ?? <span className="text-gray-400 italic">Vacant position</span>}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5 font-mono">{emp.hierarchyPath}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-gray-500">{emp.mobile ?? '—'}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {emp.reportsToId ? `→ ${emp.reportsToId}` : 'Root'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reference — hierarchy levels */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <button
          type="button"
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          onClick={(e) => {
            const el = (e.currentTarget.nextSibling as HTMLElement);
            el.style.display = el.style.display === 'none' ? '' : 'none';
          }}
        >
          <span className="flex items-center gap-2">
            <Info className="h-4 w-4 text-gray-400" />
            Hierarchy Level Reference
          </span>
          <ChevronDown className="h-4 w-4 text-gray-400" />
        </button>
        <div style={{ display: 'none' }} className="border-t border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Level</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Role</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Owns Outlets</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Root</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {[...CONFIG].reverse().map(l => (
                <tr key={l.level} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-500 text-xs">{l.level}</td>
                  <td className="px-4 py-2 font-mono font-bold text-gray-900">{l.roleCode}</td>
                  <td className="px-4 py-2 text-xs">{l.isLeaf ? '✓ Yes' : '—'}</td>
                  <td className="px-4 py-2 text-xs">{l.isRoot ? '✓ Yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
