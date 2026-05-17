'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  FileCheck, AlertTriangle, XCircle, Plus, Search,
  ChevronRight, Clock, MapPin,
} from 'lucide-react';
import { StatsCard } from '@/components/ui/stats-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';
import { KYCStatus } from '@/types';

interface OutletRow {
  id: string;
  name: string;
  mobile: string;
  location: string;
  kycStatus: KYCStatus;
  lastVisit?: string;
  targetAchievement?: number;
}

interface ActivityItem {
  id: string;
  text: string;
  time: string;
  type: 'kyc' | 'visit' | 'visibility' | 'approval';
}

const kycBadge: Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }> = {
  [KYCStatus.APPROVED]: { variant: 'success', label: 'Approved' },
  [KYCStatus.PENDING]: { variant: 'warning', label: 'Pending' },
  [KYCStatus.SUBMITTED]: { variant: 'info', label: 'Submitted' },
  [KYCStatus.UNDER_REVIEW]: { variant: 'info', label: 'In Review' },
  [KYCStatus.REJECTED]: { variant: 'danger', label: 'Rejected' },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger', label: 'Re-upload' },
};

const MOCK_OUTLETS: OutletRow[] = [
  { id: 'o1', name: 'Kumar General Store', mobile: '9876543210', location: 'Andheri, Mumbai', kycStatus: KYCStatus.APPROVED, lastVisit: '2026-05-14', targetAchievement: 76 },
  { id: 'o2', name: 'Sharma Kirana', mobile: '9765432109', location: 'Borivali, Mumbai', kycStatus: KYCStatus.PENDING, lastVisit: '2026-05-10', targetAchievement: 42 },
  { id: 'o3', name: 'Patel Grocery', mobile: '9654321098', location: 'Thane West', kycStatus: KYCStatus.REJECTED, lastVisit: '2026-05-08', targetAchievement: 28 },
  { id: 'o4', name: 'Singh Supermart', mobile: '9543210987', location: 'Malad East', kycStatus: KYCStatus.APPROVED, lastVisit: '2026-05-12', targetAchievement: 91 },
  { id: 'o5', name: 'Mehta Provisions', mobile: '9432109876', location: 'Kandivali, Mumbai', kycStatus: KYCStatus.SUBMITTED, targetAchievement: 55 },
];

const MOCK_ACTIVITY: ActivityItem[] = [
  { id: 'a1', text: 'KYC submitted for Patel Grocery', time: '2 hours ago', type: 'kyc' },
  { id: 'a2', text: 'Visibility rejected – Singh Supermart', time: '4 hours ago', type: 'visibility' },
  { id: 'a3', text: 'Kumar General Store KYC approved', time: 'Yesterday', type: 'approval' },
  { id: 'a4', text: 'Visited Sharma Kirana outlet', time: 'Yesterday', type: 'visit' },
];

export default function SalesDashboard() {
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setOutlets(MOCK_OUTLETS);
      setActivity(MOCK_ACTIVITY);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const pendingKYC = outlets.filter((o) => o.kycStatus === KYCStatus.PENDING || o.kycStatus === KYCStatus.SUBMITTED).length;
  const rejectedKYC = outlets.filter((o) => o.kycStatus === KYCStatus.REJECTED || o.kycStatus === KYCStatus.RESUBMISSION_REQUIRED).length;

  const filtered = outlets.filter((o) =>
    o.name.toLowerCase().includes(search.toLowerCase()) ||
    o.mobile.includes(search),
  );

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">Your daily task overview</p>
        </div>
        <Link href="/sales/kyc/new">
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" />
            New KYC
          </Button>
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* Pending action cards */}
          <div className="grid grid-cols-2 gap-3">
            <Link href="/sales/kyc?status=PENDING">
              <StatsCard
                icon={<FileCheck className="h-5 w-5" />}
                title="Pending KYC"
                value={pendingKYC}
                accentColor={pendingKYC > 0 ? '#C8102E' : '#059669'}
                className={pendingKYC > 0 ? 'border-red-200' : ''}
              />
            </Link>
            <Link href="/sales/kyc?status=REJECTED">
              <StatsCard
                icon={<XCircle className="h-5 w-5" />}
                title="Rejected KYC"
                value={rejectedKYC}
                accentColor={rejectedKYC > 0 ? '#d97706' : '#059669'}
                className={rejectedKYC > 0 ? 'border-amber-200' : ''}
              />
            </Link>
          </div>

          {/* Outlet list */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>My Outlets</CardTitle>
                <span className="text-xs text-gray-500">{outlets.length} total</span>
              </div>
              <div className="relative mt-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or mobile..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#C8102E]/20 focus:border-[#C8102E]"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filtered.length === 0 ? (
                <EmptyState
                  icon={<MapPin className="h-8 w-8" />}
                  title="No outlets found"
                  description="Try adjusting your search."
                  className="py-8"
                />
              ) : (
                <div className="divide-y divide-gray-50">
                  {filtered.map((outlet) => {
                    const { variant, label } = kycBadge[outlet.kycStatus];
                    return (
                      <Link
                        key={outlet.id}
                        href={`/sales/kyc/${outlet.id}`}
                        className="flex items-center gap-3 py-3 hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
                      >
                        <div className="p-2 bg-gray-50 rounded-lg shrink-0">
                          <MapPin className="h-4 w-4 text-gray-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{outlet.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-gray-400 truncate">{outlet.location}</span>
                            {outlet.lastVisit && (
                              <span className="text-xs text-gray-400 shrink-0">
                                · {formatDate(outlet.lastVisit)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant={variant}>{label}</Badge>
                          {outlet.targetAchievement !== undefined && (
                            <span className={`text-[10px] font-medium ${
                              outlet.targetAchievement >= 80 ? 'text-emerald-600' :
                              outlet.targetAchievement >= 50 ? 'text-amber-600' : 'text-red-600'
                            }`}>
                              {outlet.targetAchievement}% target
                            </span>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent activity */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {activity.map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <div className="p-1.5 bg-gray-50 rounded-lg shrink-0 mt-0.5">
                      {item.type === 'kyc' && <FileCheck className="h-3.5 w-3.5 text-blue-500" />}
                      {item.type === 'visibility' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                      {item.type === 'approval' && <FileCheck className="h-3.5 w-3.5 text-emerald-500" />}
                      {item.type === 'visit' && <MapPin className="h-3.5 w-3.5 text-gray-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800">{item.text}</p>
                      <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        {item.time}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
