'use client';

import { useState, useMemo, useRef } from 'react';
import {
  Store, Plus, Search, Upload, X,
  CheckCircle, Clock, XCircle, AlertCircle,
  Building2, MapPin, ChevronDown, Download,
  RefreshCw, Users, FileCheck, Trash2, Loader2,
} from 'lucide-react';
import Link from 'next/link';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type OutletKYCStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
type OutletType      = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface OutletMaster {
  outletId:       string;
  name:           string;
  type:           OutletType;
  beat:           string;
  territory:      string;
  assignedTo:     string;
  assignedRole:   string;
  kycStatus:      OutletKYCStatus;
  addedDate:      string;
  phoneVerified?: boolean;
}

interface SalesUser {
  id:        string;
  name:      string;
  role:      string;
  territory: string;
  beat:      string;
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const TERRITORIES = ['Mumbai West', 'Mumbai East', 'Mumbai North', 'Delhi NCR', 'Bengaluru', 'Ahmedabad'];
const BEATS: Record<string, string[]> = {
  'Mumbai West':  ['Andheri Beat', 'Borivali Beat', 'Kandivali Beat', 'Malad Beat', 'Goregaon Beat'],
  'Mumbai East':  ['Thane Beat', 'Mulund Beat', 'Bhandup Beat'],
  'Mumbai North': ['Dahisar Beat', 'Vasai Beat', 'Mira Road Beat'],
  'Delhi NCR':    ['Connaught Place Beat', 'Noida Beat', 'Gurgaon Beat'],
  'Bengaluru':    ['Indiranagar Beat', 'Koramangala Beat', 'Whitefield Beat'],
  'Ahmedabad':    ['Navrangpura Beat', 'Satellite Beat', 'Vastrapur Beat'],
};

const SALES_USERS: SalesUser[] = [
  { id: 'u1',  name: 'Anil Sharma',    role: 'ISR', territory: 'Mumbai West',  beat: 'Andheri Beat'       },
  { id: 'u2',  name: 'Ravi Pillai',    role: 'ISR', territory: 'Mumbai West',  beat: 'Borivali Beat'      },
  { id: 'u3',  name: 'Deepa Nair',     role: 'ISR', territory: 'Mumbai West',  beat: 'Kandivali Beat'     },
  { id: 'u4',  name: 'Kiran Joshi',    role: 'ISR', territory: 'Mumbai East',  beat: 'Thane Beat'         },
  { id: 'u5',  name: 'Sanjay Kumar',   role: 'ISR', territory: 'Delhi NCR',    beat: 'Noida Beat'         },
  { id: 'u6',  name: 'Priya Mehta',    role: 'SO',  territory: 'Mumbai West',  beat: 'Andheri Beat'       },
  { id: 'u7',  name: 'Anita Rao',      role: 'ISR', territory: 'Bengaluru',    beat: 'Koramangala Beat'   },
  { id: 'u8',  name: 'Manoj Desai',    role: 'ISR', territory: 'Ahmedabad',    beat: 'Satellite Beat'     },
];

const OUTLET_MASTER: OutletMaster[] = [
  /* ── Approved KYC ── */
  { outletId: 'OUT-2026-K01', name: 'Kumar General Store',   type: 'SSS',     beat: 'Andheri Beat',   territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'APPROVED',     addedDate: '2026-03-01', phoneVerified: true  },
  { outletId: 'OUT-2026-K04', name: 'Singh Supermart',       type: 'WHOLESALER',   beat: 'Malad Beat',     territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'APPROVED',     addedDate: '2026-03-01', phoneVerified: true  },
  { outletId: 'OUT-2026-K10', name: 'Sharma General Store',  type: 'SSS',     beat: 'Connaught Place Beat', territory: 'Delhi NCR',  assignedTo: 'Sanjay Kumar', assignedRole: 'ISR', kycStatus: 'APPROVED', addedDate: '2026-03-15', phoneVerified: true  },
  { outletId: 'OUT-2026-K11', name: 'Krishnamurthy & Sons',  type: 'WHOLESALER',   beat: 'Koramangala Beat', territory: 'Bengaluru',  assignedTo: 'Anita Rao',    assignedRole: 'ISR', kycStatus: 'APPROVED',    addedDate: '2026-03-10', phoneVerified: true  },
  /* ── KYC in progress ── */
  { outletId: 'OUT-2026-K02', name: 'Sharma Kirana',         type: 'SSS',     beat: 'Borivali Beat',  territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'IN_PROGRESS',  addedDate: '2026-04-01', phoneVerified: true  },
  { outletId: 'OUT-2026-K05', name: 'Mehta Provisions',      type: 'SUB_STOCKIST', beat: 'Kandivali Beat', territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'SUBMITTED',    addedDate: '2026-04-15', phoneVerified: true  },
  { outletId: 'OUT-2026-K06', name: 'Desai Grocers',         type: 'SSS',     beat: 'Goregaon Beat',  territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'IN_PROGRESS',  addedDate: '2026-04-15', phoneVerified: false },
  /* ── Rejected ── */
  { outletId: 'OUT-2026-K03', name: 'Patel Grocery',         type: 'SSS',     beat: 'Thane Beat',     territory: 'Mumbai East', assignedTo: 'Kiran Joshi',  assignedRole: 'ISR', kycStatus: 'REJECTED',     addedDate: '2026-04-01', phoneVerified: true  },
  { outletId: 'OUT-2026-K09', name: 'Gupta Provisions',      type: 'SSS',     beat: 'Noida Beat',     territory: 'Delhi NCR',   assignedTo: 'Sanjay Kumar', assignedRole: 'ISR', kycStatus: 'REJECTED',     addedDate: '2026-04-05', phoneVerified: true  },
  /* ── Not started (feeds the sales KYC new-flow dropdown) ── */
  { outletId: 'OUT-2026-001', name: 'Verma Traders',         type: 'SSS',     beat: 'Andheri Beat',   territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-002', name: 'Joshi Provisions',      type: 'SSS',     beat: 'Andheri Beat',   territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-003', name: 'Nair General Store',    type: 'WHOLESALER',   beat: 'Andheri Beat',   territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-004', name: 'Gupta Kirana',          type: 'SSS',     beat: 'Andheri Beat',   territory: 'Mumbai West', assignedTo: 'Anil Sharma',  assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-005', name: 'Agarwal Mart',          type: 'SUB_STOCKIST', beat: 'Kandivali Beat', territory: 'Mumbai West', assignedTo: 'Deepa Nair',   assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-006', name: 'Rao Superstore',        type: 'WHOLESALER',   beat: 'Kandivali Beat', territory: 'Mumbai West', assignedTo: 'Deepa Nair',   assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-01' },
  { outletId: 'OUT-2026-007', name: 'Mishra Brothers',       type: 'SSS',     beat: 'Borivali Beat',  territory: 'Mumbai West', assignedTo: 'Ravi Pillai',  assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-05' },
  { outletId: 'OUT-2026-008', name: 'Shetty Provision Mart', type: 'SSS',     beat: 'Borivali Beat',  territory: 'Mumbai West', assignedTo: 'Ravi Pillai',  assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-05' },
  { outletId: 'OUT-2026-009', name: 'Ahuja Stores',          type: 'SSS',     beat: 'Noida Beat',     territory: 'Delhi NCR',   assignedTo: 'Sanjay Kumar', assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-10' },
  { outletId: 'OUT-2026-010', name: 'Khatri Mart',           type: 'WHOLESALER',   beat: 'Gurgaon Beat',   territory: 'Delhi NCR',   assignedTo: 'Sanjay Kumar', assignedRole: 'ISR', kycStatus: 'NOT_STARTED',  addedDate: '2026-05-10' },
];

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const TYPE_LABEL: Record<OutletType, string> = {
  SSS:     'SSS',
  WHOLESALER:   'Wholesaler',
  SUB_STOCKIST: 'Sub-Stockist',
};

const KYC_STATUS_CONFIG: Record<OutletKYCStatus, {
  label: string; icon: React.ReactNode; rowCls: string; badgeCls: string;
}> = {
  NOT_STARTED:  { label: 'Not Started',  icon: <AlertCircle  className="w-3.5 h-3.5" />, rowCls: '', badgeCls: 'bg-gray-100 text-gray-600'       },
  IN_PROGRESS:  { label: 'In Progress',  icon: <Clock        className="w-3.5 h-3.5" />, rowCls: '', badgeCls: 'bg-blue-100 text-blue-700'        },
  SUBMITTED:    { label: 'Submitted',    icon: <Clock        className="w-3.5 h-3.5" />, rowCls: '', badgeCls: 'bg-purple-100 text-purple-700'    },
  APPROVED:     { label: 'KYC Approved', icon: <CheckCircle  className="w-3.5 h-3.5" />, rowCls: '', badgeCls: 'bg-green-100 text-green-700'      },
  REJECTED:     { label: 'Rejected',     icon: <XCircle      className="w-3.5 h-3.5" />, rowCls: '', badgeCls: 'bg-red-100 text-red-700'          },
};

/* ─── Add Outlet Modal ────────────────────────────────────────────────────────── */

interface AddOutletModalProps {
  onClose: () => void;
  onAdd:   (o: OutletMaster) => void;
  existingCount: number;
}

function AddOutletModal({ onClose, onAdd, existingCount }: AddOutletModalProps) {
  const nextId = `OUT-2026-${String(existingCount + 1).padStart(3, '0')}`;
  const [form, setForm] = useState({
    outletId:   nextId,
    name:       '',
    type:       'SSS' as OutletType,
    territory:  'Mumbai West',
    beat:       '',
    assignedTo: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const beatsForTerritory = BEATS[form.territory] ?? [];

  const assignableUsers = SALES_USERS.filter(
    (u) => u.territory === form.territory,
  );

  const handleSave = async () => {
    if (!form.name || !form.beat || !form.assignedTo) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 700));
    const user = SALES_USERS.find((u) => u.id === form.assignedTo);
    onAdd({
      outletId:     form.outletId,
      name:         form.name,
      type:         form.type,
      beat:         form.beat,
      territory:    form.territory,
      assignedTo:   user?.name ?? '',
      assignedRole: user?.role ?? 'ISR',
      kycStatus:    'NOT_STARTED',
      addedDate:    new Date().toISOString().slice(0, 10),
    });
    setSaving(false);
    onClose();
  };

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white';
  const labelCls = 'text-xs font-medium text-gray-600 block mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-gray-900">Add New Outlet</h2>
            <p className="text-xs text-gray-400 mt-0.5">This outlet will appear in the ISR's KYC dropdown</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-4">
          {/* Outlet ID */}
          <div>
            <label className={labelCls}>Outlet ID</label>
            <div className="flex gap-2">
              <input
                className={`${inputCls} font-mono`}
                value={form.outletId}
                onChange={set('outletId')}
              />
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, outletId: nextId }))}
                className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-500 transition-colors"
                title="Reset to auto-generated"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">Auto-generated. Can be edited to match your outlet code.</p>
          </div>

          {/* Name */}
          <div>
            <label className={labelCls}>Outlet / Shop Name *</label>
            <input
              className={inputCls}
              placeholder="e.g. Verma Traders"
              value={form.name}
              onChange={set('name')}
            />
          </div>

          {/* Type */}
          <div>
            <label className={labelCls}>Outlet Type *</label>
            <select className={inputCls} value={form.type} onChange={set('type')}>
              <option value="SSS">Retailer</option>
              <option value="WHOLESALER">Wholesaler</option>
              <option value="SUB_STOCKIST">Sub-Stockist</option>
            </select>
          </div>

          {/* Territory */}
          <div>
            <label className={labelCls}>Territory *</label>
            <select
              className={inputCls}
              value={form.territory}
              onChange={(e) => setForm((f) => ({ ...f, territory: e.target.value, beat: '', assignedTo: '' }))}
            >
              {TERRITORIES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Beat */}
          <div>
            <label className={labelCls}>Beat / Area *</label>
            <select
              className={inputCls}
              value={form.beat}
              onChange={set('beat')}
            >
              <option value="">Select beat…</option>
              {beatsForTerritory.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          {/* Assign To */}
          <div>
            <label className={labelCls}>Assign to Sales User *</label>
            <select
              className={inputCls}
              value={form.assignedTo}
              onChange={set('assignedTo')}
            >
              <option value="">Select ISR / SO…</option>
              {assignableUsers.length === 0 ? (
                <option disabled>No users for this territory</option>
              ) : (
                assignableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role}) · {u.beat}
                  </option>
                ))
              )}
            </select>
            {form.territory && assignableUsers.length === 0 && (
              <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> No sales users mapped to {form.territory} yet.
              </p>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-gray-100" />

          {/* Info callout */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700 space-y-1">
            <p className="font-semibold">What happens next?</p>
            <ul className="list-disc list-inside space-y-0.5 text-blue-600">
              <li>Outlet appears in <strong>{form.assignedTo ? (SALES_USERS.find(u=>u.id===form.assignedTo)?.name ?? 'the assigned ISR') : 'the assigned ISR'}'s</strong> New KYC dropdown</li>
              <li>ISR fills KYC form and submits for admin review</li>
              <li>Admin reviews documents here and approves/rejects</li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!form.name || !form.beat || !form.assignedTo || saving}
            className="flex-1 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Saving…
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" /> Add Outlet
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Bulk Upload Modal ───────────────────────────────────────────────────────── */

function BulkUploadModal({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    await new Promise((r) => setTimeout(r, 1500));
    setUploading(false);
    setDone(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">Bulk Upload Outlets</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {done ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-emerald-600" />
              </div>
              <p className="text-sm font-semibold text-gray-900">Upload successful!</p>
              <p className="text-xs text-gray-500">Outlets are being processed and will appear in the list shortly.</p>
              <button onClick={onClose} className="px-5 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)]">Done</button>
            </div>
          ) : (
            <>
              {/* Template download */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-gray-700">Download CSV Template</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Fill in the template and upload below</p>
                </div>
                <button className="flex items-center gap-1.5 text-xs text-[var(--brand-primary)] font-semibold hover:underline">
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
              </div>

              {/* Template columns info */}
              <div className="text-xs text-gray-500 space-y-1">
                <p className="font-medium text-gray-700">Required CSV columns:</p>
                <div className="font-mono text-[11px] bg-gray-50 px-3 py-2 rounded-lg border border-gray-200 text-gray-600">
                  outlet_name, type, territory, beat, assigned_to_email
                </div>
                <p className="text-[10px] text-gray-400">Outlet IDs are auto-generated. type must be RETAILER / WHOLESALER / SUB_STOCKIST.</p>
              </div>

              {/* Upload area */}
              <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {!file ? (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full border-2 border-dashed border-gray-200 rounded-xl py-8 flex flex-col items-center gap-2 hover:border-[var(--brand-primary)]/40 hover:bg-green-50/30 transition-colors"
                >
                  <Upload className="w-8 h-8 text-gray-300" />
                  <p className="text-sm font-medium text-gray-600">Click to upload CSV or Excel</p>
                  <p className="text-xs text-gray-400">Max 5 MB</p>
                </button>
              ) : (
                <div className="border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3">
                  <FileCheck className="w-5 h-5 text-[var(--brand-primary)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
                    <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                  </div>
                  <button onClick={() => setFile(null)} className="text-gray-400 hover:text-gray-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Cancel</button>
                <button
                  onClick={handleUpload}
                  disabled={!file || uploading}
                  className="flex-1 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {uploading ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                      Uploading…
                    </>
                  ) : (
                    <><Upload className="w-4 h-4" /> Upload</>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Bulk Delete Modal ───────────────────────────────────────────────────────── */

function BulkDeleteModal({ selected, onConfirm, onClose }: {
  selected: OutletMaster[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone]       = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    await onConfirm();
    setLoading(false);
    setDone(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Delete Outlets</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4">
          {done ? (
            <div className="flex flex-col items-center py-4 gap-3">
              <CheckCircle className="w-10 h-10 text-green-500" />
              <p className="text-sm font-medium text-gray-800">
                {selected.length} outlet{selected.length !== 1 ? 's' : ''} deleted
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-700 mb-3">
                Permanently remove <span className="font-semibold">{selected.length}</span> outlet{selected.length !== 1 ? 's' : ''}?
                This will also release all sales user assignments.
              </p>
              <ul className="max-h-40 overflow-y-auto space-y-1 mb-3">
                {selected.map((o) => (
                  <li key={o.outletId} className="flex items-center gap-2 text-sm text-gray-600 py-1 border-b border-gray-50 last:border-0">
                    <Building2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span>{o.name}</span>
                    <span className="text-xs text-gray-400 ml-auto font-mono">{o.outletId}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                This action cannot be undone. Outlets will be soft-deleted and hidden from all views.
              </p>
            </>
          )}
        </div>
        <div className="flex gap-3 px-5 py-4 border-t border-gray-100">
          {done ? (
            <button onClick={onClose} className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium">Done</button>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
              <button
                onClick={handleConfirm}
                disabled={loading}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Deleting…</> : 'Confirm Delete'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────────── */

export default function OutletMasterPage() {
  const [outlets,       setOutlets]       = useState<OutletMaster[]>(OUTLET_MASTER);
  const [search,        setSearch]        = useState('');
  const [territoryF,    setTerritoryF]    = useState('ALL');
  const [assignedF,     setAssignedF]     = useState('ALL');
  const [kycStatusF,    setKycStatusF]    = useState<OutletKYCStatus | 'ALL'>('ALL');
  const [showAddModal,  setShowAddModal]  = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [selectedIds,   setSelectedIds]   = useState<Set<string>>(new Set());
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  /* ── Derived stats ── */
  const stats = useMemo(() => ({
    total:      outlets.length,
    notStarted: outlets.filter((o) => o.kycStatus === 'NOT_STARTED').length,
    inProgress: outlets.filter((o) => o.kycStatus === 'IN_PROGRESS' || o.kycStatus === 'SUBMITTED').length,
    approved:   outlets.filter((o) => o.kycStatus === 'APPROVED').length,
    rejected:   outlets.filter((o) => o.kycStatus === 'REJECTED').length,
  }), [outlets]);

  /* ── Filtered list ── */
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return outlets.filter((o) => {
      const matchSearch =
        !search ||
        o.name.toLowerCase().includes(q) ||
        o.outletId.toLowerCase().includes(q) ||
        o.assignedTo.toLowerCase().includes(q) ||
        o.beat.toLowerCase().includes(q);
      const matchTerritory  = territoryF === 'ALL'  || o.territory  === territoryF;
      const matchAssigned   = assignedF  === 'ALL'  || o.assignedTo === assignedF;
      const matchKYCStatus  = kycStatusF === 'ALL'  || o.kycStatus  === kycStatusF;
      return matchSearch && matchTerritory && matchAssigned && matchKYCStatus;
    });
  }, [outlets, search, territoryF, assignedF, kycStatusF]);

  const uniqueAssignees = useMemo(
    () => [...new Set(outlets.map((o) => o.assignedTo))].sort(),
    [outlets],
  );

  const handleAdd = (o: OutletMaster) => setOutlets((prev) => [o, ...prev]);

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const allIds = filtered.map(o => o.outletId);
    const allChecked = allIds.every(id => selectedIds.has(id));
    setSelectedIds(() => {
      const next = new Set(selectedIds);
      allIds.forEach(id => allChecked ? next.delete(id) : next.add(id));
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    await fetch('/api/admin/outlets/bulk-delete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ outletIds: ids }),
    });
    setOutlets(prev => prev.filter(o => !selectedIds.has(o.outletId)));
    setSelectedIds(new Set());
  };

  const selectedOutlets = outlets.filter(o => selectedIds.has(o.outletId));
  const allFilteredChecked = filtered.length > 0 && filtered.every(o => selectedIds.has(o.outletId));
  const someFilteredChecked = filtered.some(o => selectedIds.has(o.outletId));

  const selectCls = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]';

  return (
    <div className="space-y-5 fade-in">

      {/* ── Page title ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Outlet Master</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Pre-register outlets and assign them to your sales team for KYC collection.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setShowBulkModal(true)}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Upload className="w-4 h-4" /> Bulk Upload
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Outlet
          </button>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total Outlets',  value: stats.total,      icon: Store,         cls: 'text-gray-600 bg-gray-100',   filter: 'ALL'         },
          { label: 'KYC Pending',    value: stats.notStarted, icon: AlertCircle,   cls: 'text-gray-600 bg-gray-100',   filter: 'NOT_STARTED' },
          { label: 'In Progress',    value: stats.inProgress, icon: Clock,         cls: 'text-blue-600 bg-blue-100',   filter: 'IN_PROGRESS' },
          { label: 'KYC Approved',   value: stats.approved,   icon: CheckCircle,   cls: 'text-green-600 bg-green-100', filter: 'APPROVED'    },
          { label: 'Rejected',       value: stats.rejected,   icon: XCircle,       cls: 'text-red-600 bg-red-100',     filter: 'REJECTED'    },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              onClick={() => setKycStatusF(s.filter as OutletKYCStatus | 'ALL')}
              className={`bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-3 hover:shadow-md transition-all text-left ${
                kycStatusF === s.filter ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/20' : ''
              }`}
            >
              <div className={`p-2 rounded-lg ${s.cls}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xl font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Filters ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <div className="flex flex-col sm:flex-row gap-3 flex-1 flex-wrap">
            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search outlet, ID, ISR, beat…"
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              />
            </div>
            {/* Territory */}
            <select value={territoryF} onChange={(e) => setTerritoryF(e.target.value)} className={selectCls}>
              <option value="ALL">All Territories</option>
              {TERRITORIES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {/* Assigned To */}
            <select value={assignedF} onChange={(e) => setAssignedF(e.target.value)} className={selectCls}>
              <option value="ALL">All Sales Users</option>
              {uniqueAssignees.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            {/* KYC Status */}
            <select
              value={kycStatusF}
              onChange={(e) => setKycStatusF(e.target.value as OutletKYCStatus | 'ALL')}
              className={selectCls}
            >
              <option value="ALL">All KYC Statuses</option>
              <option value="NOT_STARTED">Not Started</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          {/* Export */}
          <button className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors shrink-0">
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-3 bg-[#1A1A2E] text-white rounded-xl">
          <span className="text-sm font-medium">
            {selectedIds.size} outlet{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowDeleteModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 hover:bg-red-600 rounded-lg text-xs font-medium transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Selected
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-medium transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredChecked}
                    ref={el => { if (el) el.indeterminate = someFilteredChecked && !allFilteredChecked; }}
                    onChange={toggleAll}
                    className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Outlet ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Outlet</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Beat / Territory</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Assigned To</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">KYC Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Date Added</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center">
                    <Store className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No outlets match your filters</p>
                  </td>
                </tr>
              ) : (
                filtered.map((o) => {
                  const sc = KYC_STATUS_CONFIG[o.kycStatus];
                  return (
                    <tr
                      key={o.outletId}
                      className={`hover:bg-gray-50 transition-colors cursor-pointer ${selectedIds.has(o.outletId) ? 'bg-green-50' : ''}`}
                      onClick={() => toggleOne(o.outletId)}
                    >
                      {/* Checkbox */}
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(o.outletId)}
                          onChange={() => toggleOne(o.outletId)}
                          className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)] cursor-pointer"
                        />
                      </td>
                      {/* Outlet ID */}
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <span className="font-mono text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                          {o.outletId}
                        </span>
                      </td>

                      {/* Outlet name */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 bg-gray-100 rounded-full flex items-center justify-center shrink-0">
                            <Building2 className="w-3.5 h-3.5 text-gray-500" />
                          </div>
                          <span className="text-sm font-medium text-gray-900">{o.name}</span>
                        </div>
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          o.type === 'WHOLESALER'   ? 'bg-blue-50 text-blue-700'   :
                          o.type === 'SUB_STOCKIST' ? 'bg-purple-50 text-purple-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {TYPE_LABEL[o.type]}
                        </span>
                      </td>

                      {/* Beat / Territory */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 text-sm text-gray-700">
                          <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-gray-700">{o.beat}</p>
                            <p className="text-[10px] text-gray-400">{o.territory}</p>
                          </div>
                        </div>
                      </td>

                      {/* Assigned To */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center shrink-0">
                            <Users className="w-3 h-3 text-[var(--brand-primary)]" />
                          </div>
                          <div>
                            <p className="text-xs font-medium text-gray-800">{o.assignedTo}</p>
                            <p className="text-[10px] text-gray-400">{o.assignedRole}</p>
                          </div>
                        </div>
                      </td>

                      {/* KYC Status */}
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${sc.badgeCls}`}>
                          {sc.icon}
                          {sc.label}
                        </span>
                        {o.kycStatus !== 'NOT_STARTED' && o.phoneVerified !== undefined && (
                          <p className={`text-[10px] mt-0.5 ${o.phoneVerified ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {o.phoneVerified ? '✓ Phone verified' : '⚠ Phone not verified'}
                          </p>
                        )}
                      </td>

                      {/* Date Added */}
                      <td className="px-4 py-3 text-xs text-gray-500">{o.addedDate}</td>

                      {/* Action */}
                      <td className="px-4 py-3">
                        {o.kycStatus === 'NOT_STARTED' ? (
                          <span className="text-xs text-gray-400 italic">Awaiting ISR</span>
                        ) : o.kycStatus === 'SUBMITTED' || o.kycStatus === 'IN_PROGRESS' ? (
                          <Link
                            href={`/admin/kyc`}
                            className="inline-flex items-center gap-1 text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium"
                          >
                            Review <ChevronDown className="w-3 h-3 rotate-[-90deg]" />
                          </Link>
                        ) : o.kycStatus === 'APPROVED' ? (
                          <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                            <CheckCircle className="w-3.5 h-3.5" /> Active
                          </span>
                        ) : (
                          <Link
                            href={`/admin/kyc`}
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 font-medium"
                          >
                            View rejection
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Showing {filtered.length} of {outlets.length} outlets
          </p>
          <p className="text-xs text-gray-400">
            {stats.notStarted} awaiting KYC · {stats.inProgress} in progress · {stats.approved} active
          </p>
        </div>
      </div>

      {/* ── Flow guide callout ── */}
      <div className="bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20 rounded-xl p-4">
        <p className="text-xs font-bold text-[var(--brand-primary)] mb-2">How Outlet Master works</p>
        <div className="flex items-start gap-2 flex-wrap">
          {[
            { step: '1', text: 'Admin adds outlet here with ID, name, type, beat & assigns to ISR' },
            { step: '2', text: 'ISR sees the outlet in their "New KYC" dropdown' },
            { step: '3', text: 'ISR selects outlet, verifies mobile via OTP, fills KYC form & submits' },
            { step: '4', text: 'Admin reviews documents in KYC Management → Approve / Reject' },
          ].map((item) => (
            <div key={item.step} className="flex items-start gap-2 text-xs text-gray-600 min-w-[200px] flex-1">
              <span className="w-5 h-5 bg-[var(--brand-primary)] text-white rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                {item.step}
              </span>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Modals ── */}
      {showAddModal && (
        <AddOutletModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAdd}
          existingCount={outlets.length}
        />
      )}
      {showBulkModal && (
        <BulkUploadModal onClose={() => setShowBulkModal(false)} />
      )}
      {showDeleteModal && (
        <BulkDeleteModal
          selected={selectedOutlets}
          onConfirm={handleBulkDelete}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
}
