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
  [KYCStatus.RE_UPLOAD_REQUIRED]:    { variant: 'danger',  label: 'Rejected'       },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Rejected'       },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC'         },
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'    },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested' },
};

/* (member data wired to /api/sales/team/[memberId]) */

/* ─── Page ─────────────────────────────────────────────────────────────────── */

export default function MemberDetailPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const router = useRouter();
  const [loading,     setLoading]  = useState(true);
  const [member,      setMember]   = useState<MemberDetail | null>(null);
  const [fetchError,  setError]    = useState('');

  useEffect(() => {
    if (!memberId) return;
    fetch(`/api/sales/team/${memberId}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.success) setMember(body.data.member);
        else setError(body.error ?? 'Failed to load');
      })
      .catch(() => setError('Network error'))
      .finally(() => setLoading(false));
  }, [memberId]);

  if (!loading && (fetchError || !member)) {
    return (
      <div className="space-y-4 fade-in">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <p className="text-gray-500">{fetchError || 'Member not found.'}</p>
      </div>
    );
  }

  // Safe after the early-return guard above
  const m = member as MemberDetail;

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
                {m.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-gray-900">{m.name}</p>
              <p className="text-sm text-gray-500">{ROLE_LABELS[m.role]}</p>
              {m.employeeId && (
                <p className="text-xs text-gray-400 mt-0.5 font-mono">{m.employeeId}</p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">{m.mobile}</p>
            </div>
            <div className="text-right shrink-0">
              <p className={`text-2xl font-bold ${m.targetPct >= 80 ? 'text-emerald-600' : m.targetPct >= 60 ? 'text-amber-600' : 'text-red-600'}`}>
                {m.targetPct}%
              </p>
              <p className="text-[10px] text-gray-400">target</p>
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'KYC Done',    value: m.kycDone,            icon: FileCheck,    color: 'text-emerald-600' },
              { label: 'KYC Pending', value: m.kycPending,         icon: AlertTriangle,color: 'text-amber-600' },
              { label: 'Visibility',  value: m.visibilityPending,  icon: Eye,          color: 'text-blue-500' },
              { label: m.teamSize !== undefined ? 'Team' : 'Outlets',
                value: m.teamSize ?? m.outlets.length,
                icon: m.teamSize !== undefined ? Users : MapPin,
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
          {m.outlets.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-[#16a34a]" />
                  Outlets
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-gray-50">
                  {m.outlets.map((o) => {
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
          {m.activity.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {m.activity.map((item) => (
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
