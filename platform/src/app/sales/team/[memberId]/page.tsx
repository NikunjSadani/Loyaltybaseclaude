'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, MapPin, FileCheck, Eye, TrendingUp,
  AlertTriangle, CheckCircle, Clock, Users,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { type SalesRole, ROLE_LABELS } from '@/lib/sales-role';
import { KYCStatus } from '@/types';

/* ─── Mock detail data keyed by memberId ──────────────────────────────────── */

interface OutletRow {
  id: string;
  name: string;
  location: string;
  outletCode?: string;
  kycId?: string;
  kycStatus: KYCStatus;
  targetPct: number;
  lastVisit?: string;
}

interface ActivityItem {
  id: string;
  text: string;
  time: string;
  type: 'kyc' | 'visit' | 'visibility' | 'approval';
}

interface MemberDetail {
  id: string;
  name: string;
  role: SalesRole;
  territory: string;
  employeeId?: string;
  mobile: string;
  outlets: OutletRow[];
  activity: ActivityItem[];
  targetPct: number;
  kycDone: number;
  kycPending: number;
  visibilityPending: number;
  teamSize?: number;
}

const kycBadge: Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }> = {
  [KYCStatus.APPROVED]:              { variant: 'success', label: 'Approved'       },
  [KYCStatus.PENDING]:               { variant: 'warning', label: 'Pending'        },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'      },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'In Review'      },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'   },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'  },
  [KYCStatus.PENDING_RSM_APPROVAL]:  { variant: 'warning', label: 'Awaiting RSM'  },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Awaiting Gifsy' },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'       },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Re-upload'      },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC'         },
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'    },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested' },
};

const MEMBER_DATA: Record<string, MemberDetail> = {
  xsr1: {
    id: 'xsr1', name: 'Anil Sharma', role: 'XSR', territory: 'Andheri Beat',
    employeeId: 'EMP-2024-0041',
    mobile: '9876543210', targetPct: 82, kycDone: 15, kycPending: 3, visibilityPending: 2,
    outlets: [
      { id: 'o1', name: 'Kumar General Store',  location: 'Andheri W',   outletCode: 'OUT-MH-2801', kycId: 'k1', kycStatus: KYCStatus.APPROVED, targetPct: 91, lastVisit: '2026-05-14' },
      { id: 'o2', name: 'Star Kirana',          location: 'Andheri E',   outletCode: 'OUT-MH-2802', kycId: 'k2', kycStatus: KYCStatus.APPROVED, targetPct: 74, lastVisit: '2026-05-12' },
      { id: 'o3', name: 'Raj Provisions',       location: 'Chakala',     outletCode: 'OUT-MH-2803', kycId: 'k3', kycStatus: KYCStatus.PENDING,  targetPct: 38, lastVisit: '2026-05-10' },
      { id: 'o4', name: 'Om Supermart',         location: 'Andheri W',   outletCode: 'OUT-MH-2804', kycId: 'k4', kycStatus: KYCStatus.APPROVED, targetPct: 88 },
    ],
    activity: [
      { id: 'a1', text: 'KYC submitted for Raj Provisions',  time: '2 hours ago', type: 'kyc' },
      { id: 'a2', text: 'Visited Star Kirana outlet',        time: 'Yesterday',   type: 'visit' },
      { id: 'a3', text: 'Kumar General Store KYC approved',  time: '2 days ago',  type: 'approval' },
    ],
  },
  xsr2: {
    id: 'xsr2', name: 'Divya Pillai', role: 'XSR', territory: 'Juhu Beat',
    employeeId: 'EMP-2024-0042',
    mobile: '9765432109', targetPct: 58, kycDone: 9, kycPending: 5, visibilityPending: 4,
    outlets: [
      { id: 'o1', name: 'Juhu Mart',            location: 'Juhu',        outletCode: 'OUT-MH-2811', kycId: 'k5', kycStatus: KYCStatus.APPROVED, targetPct: 65, lastVisit: '2026-05-13' },
      { id: 'o2', name: 'Beach Provisions',     location: 'JVPD',        outletCode: 'OUT-MH-2812', kycId: 'k6', kycStatus: KYCStatus.PENDING,  targetPct: 42 },
      { id: 'o3', name: 'Gulshan Stores',       location: 'Vile Parle',  outletCode: 'OUT-MH-2813', kycId: 'k7', kycStatus: KYCStatus.REJECTED, targetPct: 22, lastVisit: '2026-05-09' },
    ],
    activity: [
      { id: 'a1', text: 'Visibility rejected – Gulshan Stores', time: '1 day ago',  type: 'visibility' },
      { id: 'a2', text: 'Visited Juhu Mart',                    time: '2 days ago', type: 'visit' },
    ],
  },
  xsr3: {
    id: 'xsr3', name: 'Kiran Rao', role: 'XSR', territory: 'Versova Beat',
    employeeId: 'EMP-2024-0051',
    mobile: '9654321098', targetPct: 91, kycDone: 10, kycPending: 1, visibilityPending: 0,
    outlets: [
      { id: 'o1', name: 'Versova Daily Needs',  location: 'Versova',     outletCode: 'OUT-MH-2821', kycId: 'k1', kycStatus: KYCStatus.APPROVED, targetPct: 95, lastVisit: '2026-05-15' },
      { id: 'o2', name: 'Royal Kirana',         location: 'Andheri W',   outletCode: 'OUT-MH-2822', kycId: 'k2', kycStatus: KYCStatus.APPROVED, targetPct: 88, lastVisit: '2026-05-14' },
      { id: 'o3', name: 'Four Seasons Mart',    location: 'Lokhandwala', outletCode: 'OUT-MH-2823', kycId: 'k3', kycStatus: KYCStatus.PENDING,  targetPct: 60 },
    ],
    activity: [
      { id: 'a1', text: 'Visited Versova Daily Needs',          time: '1 day ago',  type: 'visit' },
      { id: 'a2', text: 'Royal Kirana KYC approved',            time: '3 days ago', type: 'approval' },
    ],
  },
  xsr4: {
    id: 'xsr4', name: 'Meena Joshi', role: 'XSR', territory: 'DN Nagar Beat',
    employeeId: 'EMP-2024-0063',
    mobile: '9543210987', targetPct: 44, kycDone: 10, kycPending: 6, visibilityPending: 3,
    outlets: [
      { id: 'o1', name: 'Nagar General',        location: 'DN Nagar',    outletCode: 'OUT-MH-2861', kycId: 'k1', kycStatus: KYCStatus.PENDING,  targetPct: 35 },
      { id: 'o2', name: 'Sunrise Provisions',   location: 'Amboli',      outletCode: 'OUT-MH-2862', kycId: 'k2', kycStatus: KYCStatus.APPROVED, targetPct: 52, lastVisit: '2026-05-11' },
      { id: 'o3', name: 'Regal Stores',         location: 'DN Nagar',    outletCode: 'OUT-MH-2863', kycId: 'k3', kycStatus: KYCStatus.REJECTED, targetPct: 18 },
    ],
    activity: [
      { id: 'a1', text: 'KYC submitted for Nagar General',      time: '3 hours ago', type: 'kyc' },
      { id: 'a2', text: 'Visibility pending – Regal Stores',    time: 'Yesterday',   type: 'visibility' },
    ],
  },
  so1: {
    id: 'so1', name: 'Rajesh Kumar', role: 'SO', territory: 'Mumbai West',
    mobile: '9876543211', targetPct: 76, kycDone: 44, kycPending: 15, visibilityPending: 9, teamSize: 4,
    outlets: [],
    activity: [
      { id: 'a1', text: 'Team KYC count updated',    time: '1 hour ago',  type: 'kyc' },
      { id: 'a2', text: 'Target review completed',   time: 'Yesterday',   type: 'approval' },
    ],
  },
  so2: {
    id: 'so2', name: 'Nisha Verma', role: 'SO', territory: 'Mumbai East',
    mobile: '9765432110', targetPct: 88, kycDone: 39, kycPending: 8, visibilityPending: 5, teamSize: 3,
    outlets: [], activity: [],
  },
  so3: {
    id: 'so3', name: 'Arjun Patil', role: 'SO', territory: 'Thane City',
    mobile: '9654321099', targetPct: 55, kycDone: 32, kycPending: 20, visibilityPending: 12, teamSize: 4,
    outlets: [], activity: [],
  },
  so4: {
    id: 'so4', name: 'Sunita Desai', role: 'SO', territory: 'Navi Mumbai',
    mobile: '9543210988', targetPct: 93, kycDone: 34, kycPending: 4, visibilityPending: 2, teamSize: 3,
    outlets: [], activity: [],
  },
};

/* ─── Page ─────────────────────────────────────────────────────────────────── */

export default function MemberDetailPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 300);
    return () => clearTimeout(t);
  }, []);

  const member = MEMBER_DATA[memberId ?? ''];

  if (!loading && !member) {
    return (
      <div className="space-y-4 fade-in">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <p className="text-gray-500">Member not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Back */}
      <button onClick={() => router.back()} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Team
      </button>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* Profile card */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-[#16a34a]/10 flex items-center justify-center shrink-0">
              <span className="text-[#16a34a] font-bold text-lg">
                {member.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-gray-900">{member.name}</p>
              <p className="text-sm text-gray-500">{ROLE_LABELS[member.role]}</p>
              {member.employeeId && (
                <p className="text-xs text-gray-400 mt-0.5 font-mono">{member.employeeId}</p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">{member.mobile}</p>
            </div>
            <div className="text-right shrink-0">
              <p className={`text-2xl font-bold ${member.targetPct >= 80 ? 'text-emerald-600' : member.targetPct >= 60 ? 'text-amber-600' : 'text-red-600'}`}>
                {member.targetPct}%
              </p>
              <p className="text-[10px] text-gray-400">target</p>
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'KYC Done',    value: member.kycDone,            icon: FileCheck,    color: 'text-emerald-600' },
              { label: 'KYC Pending', value: member.kycPending,         icon: AlertTriangle,color: 'text-amber-600' },
              { label: 'Visibility',  value: member.visibilityPending,  icon: Eye,          color: 'text-blue-500' },
              { label: member.teamSize !== undefined ? 'Team' : 'Outlets',
                value: member.teamSize ?? member.outlets.length,
                icon: member.teamSize !== undefined ? Users : MapPin,
                color: 'text-gray-600' },
            ].map((s) => (
              <div key={s.label} className="bg-white rounded-xl border border-gray-100 p-3 flex flex-col items-center gap-1">
                <s.icon className={`h-4 w-4 ${s.color}`} />
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[9px] text-gray-400 text-center leading-tight">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Outlets (only shown for ISR) */}
          {member.outlets.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-[#16a34a]" />
                  Outlets
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-gray-50">
                  {member.outlets.map((o) => {
                    const { variant, label } = kycBadge[o.kycStatus];
                    const inner = (
                      <>
                        <div className="p-2 bg-gray-50 rounded-lg shrink-0">
                          <MapPin className="h-4 w-4 text-gray-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{o.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {o.outletCode ? (
                              <span className="text-xs text-gray-400 font-mono">{o.outletCode}</span>
                            ) : null}
                            {o.lastVisit && (
                              <span className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
                                <Clock className="h-3 w-3" />
                                {new Date(o.lastVisit).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant={variant}>{label}</Badge>
                          <span className={`text-[10px] font-medium ${o.targetPct >= 80 ? 'text-emerald-600' : o.targetPct >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                            {o.targetPct}% target
                          </span>
                        </div>
                      </>
                    );
                    return o.kycId ? (
                      <Link key={o.id} href={`/sales/kyc/${o.kycId}`} className="flex items-center gap-3 py-3 hover:bg-gray-50 -mx-1 px-1 rounded-lg transition-colors">
                        {inner}
                      </Link>
                    ) : (
                      <div key={o.id} className="flex items-center gap-3 py-3">
                        {inner}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent activity */}
          {member.activity.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {member.activity.map((item) => (
                    <div key={item.id} className="flex items-start gap-3">
                      <div className="p-1.5 bg-gray-50 rounded-lg shrink-0 mt-0.5">
                        {item.type === 'kyc'        && <FileCheck   className="h-3.5 w-3.5 text-blue-500"    />}
                        {item.type === 'visibility' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500"  />}
                        {item.type === 'approval'   && <CheckCircle  className="h-3.5 w-3.5 text-emerald-500"/>}
                        {item.type === 'visit'      && <MapPin       className="h-3.5 w-3.5 text-gray-500"   />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800">{item.text}</p>
                        <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                          <Clock className="h-3 w-3" /> {item.time}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
