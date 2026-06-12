'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  FileCheck, XCircle, ChevronRight, Clock, Bell, Tag,
  RefreshCw, Layers,
  CheckCircle2, ArrowLeft, ListTodo,
  UserCheck, X, MessageSquare, ChevronLeft, Loader2,
} from 'lucide-react';
import { KYCStatus } from '@/types';
import { fetchTaskConfig, DEFAULT_TASK_CONFIG, type TaskConfig } from '@/lib/task-config';
import {
  fetchOutletVisibilityStatuses,
  VISIBILITY_ELIGIBLE_OUTLET_TYPES,
  DEMO_TASK_VISIBILITY_MAP,
  type VisibilityStatusMap,
} from '@/lib/visibility-upload';
import { getRole, type SalesRole } from '@/lib/sales-role';
import {
  getAllPendingSchemes,
  saveSalesEnrollment,
  isOutletEnrolledInScheme,
  getSalesEnrollments,
  formatDeadline,
  type Scheme,
} from '@/lib/schemes';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface OutletRow {
  id: string; kycId: string; name: string; mobile: string;
  location: string; type: OutletType; kycStatus: KYCStatus;
  kycSubmittedAt?: string;
  outletCode: string;  // matches Outlet.outletCode for visibility lookup
}

interface TaskItem {
  id: string; title: string; subtitle: string;
  href?: string; priority: 'high' | 'medium' | 'low';
  ageDays?: number;
}

interface TaskGroup {
  id:           string;
  label:        string;
  icon:         React.ReactNode;
  items:        TaskItem[];
  accentBg:     string;
  accentBorder: string;
  accentText:   string;
  badgeBg:      string;
  /** When set, tapping the row navigates here instead of expanding */
  href?:        string;
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const MOCK_OUTLETS: OutletRow[] = [
  { id: 'o1', kycId: 'k1', outletCode: 'OUT-TASK-001', name: 'Kumar General Store', mobile: '9876543210', location: 'Andheri, Mumbai',  type: 'SSS',     kycStatus: KYCStatus.APPROVED              },
  { id: 'o2', kycId: 'k2', outletCode: 'OUT-TASK-002', name: 'Sharma Kirana',       mobile: '9765432109', location: 'Borivali, Mumbai', type: 'SSS',     kycStatus: KYCStatus.PENDING,               kycSubmittedAt: '2026-05-01' },
  { id: 'o3', kycId: 'k3', outletCode: 'OUT-TASK-003', name: 'Patel Grocery',       mobile: '9654321098', location: 'Thane West',       type: 'SSS',     kycStatus: KYCStatus.REJECTED,              kycSubmittedAt: '2026-04-20' },
  { id: 'o4', kycId: 'k4', outletCode: 'OUT-TASK-004', name: 'Singh Supermart',     mobile: '9543210987', location: 'Malad East',       type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED              },
  { id: 'o5', kycId: 'k5', outletCode: 'OUT-TASK-005', name: 'Mehta Provisions',    mobile: '9432109876', location: 'Kandivali',        type: 'SUB_STOCKIST', kycStatus: KYCStatus.PENDING_GIFSY         },
  { id: 'o6', kycId: 'k6', outletCode: 'OUT-TASK-006', name: 'Ravi Traders',        mobile: '9321098765', location: 'Bandra, Mumbai',   type: 'SSS',     kycStatus: KYCStatus.RESUBMISSION_REQUIRED, kycSubmittedAt: '2026-04-28' },
  { id: 'o7', kycId: 'k7', outletCode: 'OUT-TASK-007', name: 'Suresh Wholesale',    mobile: '9210987654', location: 'Kurla, Mumbai',    type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED              },
  { id: 'o8', kycId: 'k8', outletCode: 'OUT-TASK-008', name: 'Desai Mart',          mobile: '9123456780', location: 'Goregaon, Mumbai', type: 'SSS',     kycStatus: KYCStatus.PENDING,               kycSubmittedAt: '2026-05-05' },
  { id: 'o9', kycId: 'k9', outletCode: 'OUT-TASK-009', name: 'Verma Stores',        mobile: '9001234567', location: 'Andheri, Mumbai',  type: 'SSS',     kycStatus: KYCStatus.PENDING_SO_APPROVAL,   kycSubmittedAt: '2026-05-15' },
];

const REKYC_OUTLETS = [
  { id: 'o7', name: 'Suresh Wholesale', location: 'Kurla, Mumbai',  reason: 'KYC expired — renewal required', submittedAt: '2026-03-10' },
  { id: 'o4', name: 'Singh Supermart',  location: 'Malad East',     reason: 'GST number updated — re-verify',  submittedAt: '2026-03-15' },
];

// VISIBILITY_TASKS is now computed dynamically from API data in TasksPage.
// RETAILER and MT outlets without an APPROVED status for the current month
// appear as pending visibility tasks.  See state: visibilityItems.

const HO_TASKS: TaskItem[] = [
  { id: 'h1', title: 'May MTD review call',       subtitle: 'Tomorrow 10:00 AM — join via Teams',    priority: 'high',   ageDays: 0 },
  { id: 'h2', title: 'Submit beat plan for June', subtitle: 'Deadline: 30 May — pending submission', priority: 'high',   ageDays: 2 },
  { id: 'h3', title: 'Festival scheme briefing',  subtitle: 'Watch recorded session before Friday',  priority: 'medium', ageDays: 1 },
];

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function ageInDays(dateStr?: string): number {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function maskMobile(mobile: string): string {
  return `+91 ${mobile.slice(0, 2)}·····${mobile.slice(-3)}`;
}

const OUTLET_TYPE_LABEL: Record<OutletType, string> = {
  SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist',
};

/* ─── Priority dot ───────────────────────────────────────────────────────────── */

function PriorityDot({ priority }: { priority: TaskItem['priority'] }) {
  return (
    <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[5px] ${
      priority === 'high' ? 'bg-red-400' : priority === 'medium' ? 'bg-amber-400' : 'bg-gray-300'
    }`} />
  );
}

/* ─── Age badge ──────────────────────────────────────────────────────────────── */

function AgeBadge({ ageDays }: { ageDays?: number }) {
  if (!ageDays || ageDays <= 0) return null;
  if (ageDays >= 7) {
    return (
      <span className="shrink-0 flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
        <Clock className="h-2.5 w-2.5" />
        {ageDays}d · Overdue
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
      {ageDays}d
    </span>
  );
}

/* ─── Task group row (accordion) ────────────────────────────────────────────── */

function TaskGroupRow({ group }: { group: TaskGroup }) {
  const [open, setOpen] = useState(false);
  const oldestAge = group.items.reduce((max, i) => Math.max(max, i.ageDays ?? 0), 0);

  const headerInner = (
    <>
      <div className={`p-2 rounded-xl ${group.accentBg} shrink-0`}>{group.icon}</div>
      <p className="text-sm font-semibold text-gray-800 flex-1 text-left leading-snug">{group.label}</p>
      {oldestAge > 0 && (
        <span className={`text-[10px] font-semibold shrink-0 ${oldestAge >= 7 ? 'text-red-500' : 'text-gray-400'}`}>
          {oldestAge}d
        </span>
      )}
      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${group.badgeBg} ${group.accentText} shrink-0`}>
        {group.items.length}
      </span>
      <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${!group.href && open ? 'rotate-90' : ''} text-gray-400`} />
    </>
  );

  return (
    <div className="bg-white border-b border-gray-100 last:border-0">
      {group.href ? (
        <Link href={group.href} className="w-full flex items-center gap-3 px-4 py-4 active:bg-gray-50 transition-colors">
          {headerInner}
        </Link>
      ) : (
        <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 px-4 py-4 active:bg-gray-50 transition-colors">
          {headerInner}
        </button>
      )}

      {!group.href && open && (
        <div className={`mx-4 mb-4 rounded-xl border ${group.accentBorder} overflow-hidden`}>
          {group.items.map((item, i) => (
            <div key={item.id} className={`flex items-start gap-3 px-4 py-3 bg-white ${i < group.items.length - 1 ? 'border-b border-gray-50' : ''}`}>
              <PriorityDot priority={item.priority} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[13px] font-medium text-gray-800 leading-snug">{item.title}</p>
                  <AgeBadge ageDays={item.ageDays} />
                </div>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">{item.subtitle}</p>
              </div>
              {item.href && (
                <Link href={item.href} onClick={(e) => e.stopPropagation()} className="shrink-0 p-1 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
                  <ChevronRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Scheme Enrollment Sheet ────────────────────────────────────────────────── */

type EnrollView = 'list' | 'otp' | 'success';

function SchemeEnrollmentSheet({
  scheme,
  outlets,
  onClose,
}: {
  scheme: Scheme;
  outlets: OutletRow[];
  onClose: () => void;
}) {
  const [view, setView]                   = useState<EnrollView>('list');
  const [selectedOutlet, setSelectedOutlet] = useState<OutletRow | null>(null);
  const [otp, setOtp]                     = useState(['', '', '', '', '', '']);
  const [otpError, setOtpError]           = useState(false);

  /* Track which outlet IDs got enrolled this session (plus pre-existing) */
  const [enrolledIds, setEnrolledIds] = useState<string[]>(() =>
    getSalesEnrollments()
      .filter((e) => e.schemeId === scheme.id)
      .map((e) => e.outletId),
  );

  const isEnrolled = (outletId: string) => enrolledIds.includes(outletId);

  /* Outlets eligible for this scheme — enrolled ones pushed to bottom */
  const eligibleOutlets = outlets
    .filter((o) => scheme.eligibility.includes('ALL') || scheme.eligibility.includes(o.type as any))
    .sort((a, b) => Number(isEnrolled(a.id)) - Number(isEnrolled(b.id)));

  /* OTP input refs */
  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const r4 = useRef<HTMLInputElement>(null);
  const r5 = useRef<HTMLInputElement>(null);
  const inputRefs = [r0, r1, r2, r3, r4, r5];

  const handleOtpChange = (idx: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...otp];
    next[idx] = value.slice(-1);
    setOtp(next);
    setOtpError(false);
    if (value && idx < 5) inputRefs[idx + 1].current?.focus();
  };

  const handleOtpKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) {
      inputRefs[idx - 1].current?.focus();
    }
  };

  const handleVerifyOtp = () => {
    const code = otp.join('');
    if (code.length < 6) { setOtpError(true); return; }
    /* Demo: any 6-digit code accepted */
    saveSalesEnrollment(scheme.id, selectedOutlet!.id);
    setEnrolledIds((prev) => [...prev, selectedOutlet!.id]);
    setView('success');
  };

  const handleDone = () => {
    setView('list');
    setSelectedOutlet(null);
    setOtp(['', '', '', '', '', '']);
    setOtpError(false);
  };

  /* Focus first OTP box when view transitions */
  useEffect(() => {
    if (view === 'otp') {
      setTimeout(() => r0.current?.focus(), 120);
    }
  }, [view]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet */}
      <div className="relative bg-white rounded-t-3xl max-h-[90dvh] flex flex-col overflow-hidden shadow-2xl">

        {/* ── VIEW: Outlet list ────────────────────────────────────────────── */}
        {view === 'list' && (
          <>
            {/* Header */}
            <div className="px-5 pt-5 pb-4 border-b border-gray-100 shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-widest mb-0.5">Scheme Enrollment</p>
                  <h2 className="text-base font-bold text-gray-900 leading-snug">{scheme.name}</h2>
                  <p className="text-[12px] text-gray-400 mt-0.5">{scheme.period} · Accept by {formatDeadline(scheme.acceptDeadline)}</p>
                </div>
                <button onClick={onClose} className="p-2 -mr-1 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors shrink-0">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {/* Eligible types */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {scheme.eligibility.map((e) => (
                  <span key={e} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                    {e === 'ALL' ? 'All outlets' : OUTLET_TYPE_LABEL[e as OutletType] ?? e}
                  </span>
                ))}
              </div>
            </div>

            {/* Outlet list */}
            <div className="overflow-y-auto flex-1">
              {eligibleOutlets.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-gray-400">
                  <UserCheck className="h-8 w-8" />
                  <p className="text-sm">No eligible outlets on your beat</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {eligibleOutlets.map((outlet) => {
                    const enrolled = isEnrolled(outlet.id);
                    return (
                      <div key={outlet.id} className="flex items-center gap-3 px-5 py-4">
                        {/* Outlet info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold text-gray-800 truncate">{outlet.name}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            {outlet.location} · {OUTLET_TYPE_LABEL[outlet.type]}
                          </p>
                          <p className="text-[11px] text-gray-400">{maskMobile(outlet.mobile)}</p>
                        </div>
                        {/* Action */}
                        {enrolled ? (
                          <span className="shrink-0 flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-emerald-50 text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Enrolled
                          </span>
                        ) : (
                          <button
                            onClick={() => { setSelectedOutlet(outlet); setOtp(['','','','','','']); setOtpError(false); setView('otp'); }}
                            className="shrink-0 text-[12px] font-semibold px-3.5 py-1.5 rounded-xl bg-emerald-600 text-white active:bg-emerald-700 transition-colors"
                          >
                            Enroll
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── VIEW: OTP verification ───────────────────────────────────────── */}
        {view === 'otp' && selectedOutlet && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Header */}
            <div className="px-5 pt-5 pb-4 border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setView('list'); setOtp(['','','','','','']); setOtpError(false); }}
                  className="p-2 -ml-1 rounded-xl hover:bg-gray-100 text-gray-500 transition-colors"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <div className="flex-1">
                  <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-widest">OTP Verification</p>
                  <h2 className="text-base font-bold text-gray-900">{selectedOutlet.name}</h2>
                </div>
                <button onClick={onClose} className="p-2 -mr-1 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 pt-6 pb-8">
              {/* OTP sent notice */}
              <div className="flex items-start gap-3 p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 mb-7">
                <MessageSquare className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-[12px] font-semibold text-emerald-800">OTP sent to outlet owner</p>
                  <p className="text-[12px] text-emerald-700 mt-0.5">{maskMobile(selectedOutlet.mobile)}</p>
                </div>
              </div>

              {/* OTP boxes */}
              <p className="text-[13px] font-semibold text-gray-700 mb-3 text-center">Enter 6-digit OTP</p>
              <div className="flex justify-center gap-3 mb-2">
                {otp.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={inputRefs[idx]}
                    type="tel"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    className={`w-14 h-14 text-center text-2xl font-bold rounded-2xl border-2 outline-none transition-colors
                      ${otpError
                        ? 'border-red-400 bg-red-50 text-red-600'
                        : digit
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                          : 'border-gray-200 bg-gray-50 text-gray-800'
                      } focus:border-emerald-500 focus:bg-white`}
                  />
                ))}
              </div>

              {otpError && (
                <p className="text-center text-[12px] text-red-500 font-medium mt-1">
                  Incorrect OTP. Please try again.
                </p>
              )}

              {/* Demo hint */}
              <p className="text-center text-[11px] text-gray-400 mt-3">
                Demo mode — enter any 6 digits to verify
              </p>

              {/* Verify button */}
              <button
                onClick={handleVerifyOtp}
                disabled={otp.join('').length < 6}
                className="w-full mt-7 py-3.5 rounded-2xl bg-emerald-600 text-white text-sm font-bold
                  disabled:opacity-40 active:bg-emerald-700 transition-colors"
              >
                Verify &amp; Enroll
              </button>
            </div>
          </div>
        )}

        {/* ── VIEW: Success + WhatsApp mock ────────────────────────────────── */}
        {view === 'success' && selectedOutlet && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-5 pt-8 pb-8">
              {/* Success icon */}
              <div className="flex flex-col items-center gap-3 mb-7">
                <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                  <CheckCircle2 className="h-9 w-9 text-emerald-600" />
                </div>
                <div className="text-center">
                  <h2 className="text-lg font-bold text-gray-900">Enrolled Successfully!</h2>
                  <p className="text-[13px] text-gray-500 mt-1">
                    <span className="font-semibold text-gray-700">{selectedOutlet.name}</span> is now registered
                    in {scheme.name}.
                  </p>
                </div>
              </div>

              {/* WhatsApp confirmation mock */}
              <div className="rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
                {/* WhatsApp header bar */}
                <div className="flex items-center gap-2.5 px-4 py-3 bg-[#075e54]">
                  <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center">
                    <MessageSquare className="h-3.5 w-3.5 text-white" />
                  </div>
                  <div>
                    <p className="text-white text-[12px] font-semibold leading-none">Deoleo Loyalty</p>
                    <p className="text-white/60 text-[10px] mt-0.5">Official notification</p>
                  </div>
                </div>

                {/* Chat area */}
                <div className="bg-[#ece5dd] px-4 py-4">
                  {/* Received bubble (outlet owner) */}
                  <div className="flex justify-start mb-2">
                    <div className="bg-white rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm max-w-[90%]">
                      <p className="text-[12px] text-gray-800 leading-relaxed">
                        ✅ Dear <strong>{selectedOutlet.name}</strong>,<br /><br />
                        You have been successfully enrolled in the{' '}
                        <strong>{scheme.name}</strong> scheme ({scheme.period}).<br /><br />
                        Track your progress and rewards on the Deoleo Loyalty portal.
                        <br /><br />
                        — Deoleo India Trade Team
                      </p>
                      <div className="flex items-center justify-end gap-1 mt-1.5">
                        <p className="text-[10px] text-gray-400">
                          {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
                        </p>
                        <span className="text-[10px] text-[#53bdeb] font-bold">✓✓</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-gray-400 text-center mt-3">
                Confirmation sent to {maskMobile(selectedOutlet.mobile)}
              </p>
            </div>

            {/* Done button */}
            <div className="px-5 pb-6 pt-2 shrink-0 border-t border-gray-100">
              <button
                onClick={handleDone}
                className="w-full py-3.5 rounded-2xl bg-emerald-600 text-white text-sm font-bold active:bg-emerald-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Scheme Enrollment Task Group ───────────────────────────────────────────── */

function SchemeEnrollmentGroup({ schemes, outlets }: { schemes: Scheme[]; outlets: OutletRow[] }) {
  const [open, setOpen]               = useState(false);
  const [activeScheme, setActiveScheme] = useState<Scheme | null>(null);

  return (
    <>
      <div className="bg-white border-b border-gray-100 last:border-0">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-3 px-4 py-4 active:bg-gray-50 transition-colors"
        >
          <div className="p-2 rounded-xl bg-emerald-50 shrink-0">
            <Tag className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="text-sm font-semibold text-gray-800 flex-1 text-left leading-snug">Scheme Enrollment</p>
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">
            {schemes.length}
          </span>
          <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''} text-gray-400`} />
        </button>

        {open && (
          <div className="mx-4 mb-4 rounded-xl border border-emerald-200 overflow-hidden">
            {schemes.map((scheme, i) => (
              <div
                key={scheme.id}
                className={`px-4 py-3 bg-white ${i < schemes.length - 1 ? 'border-b border-gray-100' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-gray-800 leading-snug truncate">{scheme.name}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {scheme.period} · Accept by {formatDeadline(scheme.acceptDeadline)}
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveScheme(scheme)}
                    className="shrink-0 flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-xl bg-emerald-600 text-white active:bg-emerald-700 transition-colors"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    Enroll
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {activeScheme && (
        <SchemeEnrollmentSheet
          scheme={activeScheme}
          outlets={outlets}
          onClose={() => setActiveScheme(null)}
        />
      )}
    </>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function TasksPage() {
  const [outlets,         setOutlets]         = useState<OutletRow[]>([]);
  const [taskConfig,      setTaskConfig]       = useState<TaskConfig | null>(null);
  const [role,            setRoleState]        = useState<SalesRole>('SO');
  const [pendingSchemes,  setPendingSchemes]   = useState<Scheme[]>([]);
  const [visibilityItems, setVisibilityItems]  = useState<TaskItem[]>([]);
  const [loading,         setLoading]          = useState(true);

  useEffect(() => {
    setRoleState(getRole());

    // Synchronous data (localStorage / mock)
    setOutlets(MOCK_OUTLETS);
    setPendingSchemes(getAllPendingSchemes());

    // Async: task config + visibility statuses — run in parallel, single loading gate
    const currentMonth   = new Date().toISOString().slice(0, 7);
    const visibleOutlets = MOCK_OUTLETS.filter((o) =>
      VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(o.type),
    );
    const codes = visibleOutlets.map((o) => o.outletCode);

    Promise.all([
      fetchTaskConfig(),
      fetchOutletVisibilityStatuses(codes, currentMonth),
    ]).then(([config, apiMap]) => {
      setTaskConfig(config);

      // Merge API data over demo data (API wins; demo fills gaps)
      const merged: VisibilityStatusMap = { ...DEMO_TASK_VISIBILITY_MAP, ...apiMap };

      const items: TaskItem[] = visibleOutlets
        .filter((o) => merged[o.outletCode]?.status !== 'APPROVED')
        .map((o) => {
          const s = merged[o.outletCode]?.status;
          return {
            id:       `vis-${o.id}`,
            title:    o.name,
            subtitle: s === 'UNDER_REVIEW'
              ? 'Visibility submitted — awaiting approval'
              : `${o.location} · Visibility capture pending this month`,
            href:     '/sales/visibility',
            priority: s === 'UNDER_REVIEW' ? ('medium' as const) : ('high' as const),
          };
        });

      setVisibilityItems(items);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const onStorage = () => {
      setRoleState(getRole());
      setPendingSchemes(getAllPendingSchemes());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* ── Build task groups ── */
  const taskGroups: TaskGroup[] = useMemo(() => {
    if (!taskConfig) return [];

    const isFieldRole  = role === 'XSR' || role === 'SO';
    const approvalStatus =
      role === 'SO'  ? KYCStatus.PENDING_SO_APPROVAL  :
      role === 'ASM' ? KYCStatus.PENDING_ASM_APPROVAL :
      null;
    const approverLabel =
      role === 'SO'  ? 'XSR' :
      role === 'ASM' ? 'SO'  :
      null;
    const groups: TaskGroup[] = [];

    if (isFieldRole) {
      if (REKYC_OUTLETS.length > 0) {
        groups.push({
          id: 're_kyc', label: 'Re-KYC Required',
          icon: <RefreshCw className="h-4 w-4 text-purple-600" />,
          items: REKYC_OUTLETS.map((o) => ({
            id: o.id, title: o.name, subtitle: o.reason,
            href: `/sales/kyc/${o.id}`, priority: 'high' as const,
            ageDays: ageInDays(o.submittedAt),
          })),
          accentBg: 'bg-purple-50', accentBorder: 'border-purple-200',
          accentText: 'text-purple-700', badgeBg: 'bg-purple-100',
          href: '/sales/kyc?status=RE_KYC_REQUIRED',
        });
      }

      const pendingOutlets = outlets.filter((o) => o.kycStatus === KYCStatus.PENDING);
      if (pendingOutlets.length > 0) {
        groups.push({
          id: 'pending_kyc', label: 'Pending KYC',
          icon: <Clock className="h-4 w-4 text-amber-600" />,
          items: pendingOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · KYC not yet submitted`,
            href: `/sales/kyc/${o.id}`, priority: 'medium' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-amber-50', accentBorder: 'border-amber-200',
          accentText: 'text-amber-700', badgeBg: 'bg-amber-100',
          href: '/sales/kyc?status=PENDING',
        });
      }
    }

    if (approvalStatus) {
      const approvalOutlets = outlets.filter((o) => o.kycStatus === approvalStatus);
      if (approvalOutlets.length > 0) {
        groups.push({
          id: 'approval_required', label: 'Approval Required',
          icon: <FileCheck className="h-4 w-4 text-blue-600" />,
          items: approvalOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · KYC submitted by ${approverLabel} — awaiting your approval`,
            href: `/sales/kyc/${o.id}`, priority: 'high' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
          accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
          href: '/sales/kyc?status=APPROVAL_REQUIRED',
        });
      }
    }

    if (isFieldRole) {
      const rejectedOutlets = outlets.filter((o) =>
        o.kycStatus === KYCStatus.REJECTED || o.kycStatus === KYCStatus.RESUBMISSION_REQUIRED,
      );
      if (rejectedOutlets.length > 0) {
        groups.push({
          id: 'rejected_kyc', label: 'Rejected KYC',
          icon: <XCircle className="h-4 w-4 text-red-600" />,
          items: rejectedOutlets.map((o) => ({
            id: o.id, title: o.name,
            subtitle: `${o.location} · Resubmission required`,
            href: `/sales/kyc/${o.id}`, priority: 'high' as const,
            ageDays: ageInDays(o.kycSubmittedAt),
          })),
          accentBg: 'bg-red-50', accentBorder: 'border-red-200',
          accentText: 'text-red-700', badgeBg: 'bg-red-100',
          href: '/sales/kyc?status=REJECTED',
        });
      }

      // visibilityItems: dynamically fetched each session.
      // APPROVED outlets are excluded. New month → all outlets reappear.
      if (visibilityItems.length > 0) {
        groups.push({
          id: 'visibility', label: 'Visibility',
          icon: <FileCheck className="h-4 w-4 text-blue-600" />,
          items: visibilityItems,
          accentBg: 'bg-blue-50', accentBorder: 'border-blue-200',
          accentText: 'text-blue-700', badgeBg: 'bg-blue-100',
        });
      }
    }

    if (HO_TASKS.length > 0) {
      groups.push({
        id: 'ho_notification', label: 'HO Notifications / Reminders',
        icon: <Bell className="h-4 w-4 text-indigo-600" />,
        items: HO_TASKS,
        accentBg: 'bg-indigo-50', accentBorder: 'border-indigo-200',
        accentText: 'text-indigo-700', badgeBg: 'bg-indigo-100',
      });
    }

    // HO Notifications / Reminders (admin-configurable, date-filtered)
    const now2 = new Date();
    const activeHoItems = taskConfig.customTaskItems.filter((item) => {
      if (item.startsAt && new Date(item.startsAt) > now2) return false;
      if (item.endsAt   && new Date(item.endsAt)   < now2) return false;
      return true;
    });
    if (activeHoItems.length > 0) {
      groups.push({
        id: 'admin_tasks', label: taskConfig.customTaskLabel,
        icon: <Bell className="h-4 w-4 text-indigo-600" />,
        items: activeHoItems,
        accentBg: 'bg-indigo-50', accentBorder: 'border-indigo-200',
        accentText: 'text-indigo-700', badgeBg: 'bg-indigo-100',
      });
    }

    return groups;
  }, [outlets, taskConfig, role, visibilityItems]);

  const isFieldRole  = role === 'XSR' || role === 'SO';
  const schemeCount  = pendingSchemes.length;
  const totalTasks   = taskGroups.reduce((s, g) => s + g.items.length, 0) + (isFieldRole ? schemeCount : 0);

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <Link href="/sales/dashboard" className="p-2 -ml-2 rounded-xl hover:bg-gray-100 transition-colors text-gray-500">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <ListTodo className="h-5 w-5 text-[var(--brand-primary)]" /> Tasks
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">Your pending action items</p>
        </div>
        {totalTasks > 0 && (
          <span className="text-[11px] font-bold bg-[var(--brand-primary)] text-white px-2 py-1 rounded-full">
            {totalTasks}
          </span>
        )}
      </div>

      {/* Category list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
        </div>
      ) : taskGroups.length === 0 && (!isFieldRole || schemeCount === 0) ? (
        <div className="flex flex-col items-center gap-3 py-16 bg-white rounded-2xl border border-gray-100">
          <CheckCircle2 className="h-10 w-10 text-emerald-400" />
          <p className="text-sm font-semibold text-gray-700">All clear!</p>
          <p className="text-xs text-gray-400">No pending tasks right now</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
          {taskGroups.map((group) => (
            <TaskGroupRow key={group.id} group={group} />
          ))}
          {/* Dynamic scheme enrollment — field roles only */}
          {isFieldRole && schemeCount > 0 && (
            <SchemeEnrollmentGroup schemes={pendingSchemes} outlets={outlets} />
          )}
        </div>
      )}
    </div>
  );
}
