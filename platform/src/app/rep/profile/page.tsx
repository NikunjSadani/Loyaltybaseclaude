'use client';

import React, { useEffect, useState } from 'react';
import { User, IdCard, MapPin, Map, Phone, LogOut, UserCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { authHeader } from '@/lib/api-client';
import { logout } from '@/lib/auth-client';
import type { EmployeeMe } from '../_lib/employee';

/* ─── REP Profile ─────────────────────────────────────────────────────────────
   Name + Employee Code + region/zone (+ reporting manager) from GET /api/auth/me →
   user.salesUser. Read-only — the rep app does not edit identity. ─────────────── */

interface Profile {
  name: string;
  phone: string;
  employeeCode: string;
  region: string;
  zone: string;
  managerName?: string | null;
  managerDesignation?: string | null;
}

export default function RepProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: EmployeeMe }) => {
        if (cancelled || !json.success || !json.data) return;
        const u = json.data.user;
        const su = u?.salesUser;
        setProfile({
          name: u?.name ?? '—',
          phone: u?.phone ?? '—',
          employeeCode: su?.employeeCode ?? '—',
          region: su?.region ?? '—',
          zone: su?.zone ?? '—',
          managerName: su?.reportingTo?.name ?? null,
          managerDesignation: su?.reportingTo?.designation ?? null,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const rows = profile
    ? [
        { icon: IdCard, label: 'Employee Code', value: profile.employeeCode },
        { icon: Phone, label: 'Mobile', value: profile.phone },
        { icon: MapPin, label: 'Region', value: profile.region },
        { icon: Map, label: 'Zone', value: profile.zone },
      ]
    : [];

  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-lg font-bold text-gray-900">Profile</h1>

      {/* Identity header */}
      <Card>
        <CardContent className="px-4 py-5 flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
            <UserCircle className="h-8 w-8 text-[var(--brand-primary)]" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-gray-900 truncate">{profile?.name ?? '—'}</p>
            <p className="text-xs text-gray-500 truncate">
              {profile?.employeeCode && profile.employeeCode !== '—'
                ? `Employee · ${profile.employeeCode}`
                : 'Employee'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Detail rows */}
      <Card>
        <CardContent className="px-0 py-0 divide-y divide-gray-50">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                <row.icon className="h-4 w-4 text-gray-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide">{row.label}</p>
                <p className="text-sm font-medium text-gray-800 truncate">{row.value}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Reporting manager */}
      {profile?.managerName && (
        <Card>
          <CardContent className="px-4 py-3.5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
              <User className="h-4 w-4 text-gray-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-gray-400 uppercase tracking-wide">Reporting Manager</p>
              <p className="text-sm font-medium text-gray-800 truncate">
                {profile.managerName}
                {profile.managerDesignation ? ` · ${profile.managerDesignation}` : ''}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Button variant="outline" className="w-full" onClick={() => void logout()}>
        <LogOut className="h-4 w-4" /> Sign Out
      </Button>
    </div>
  );
}
