'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, Phone, Mail, Award, LogOut,
  ChevronRight, Shield, Bell, X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { ROLE_LABELS, type SalesRole } from '@/lib/sales-role';
import { authHeader } from '@/lib/api-client';
import PwaAppSettings from '@/components/pwa/PwaAppSettings';

interface SalesProfile {
  name: string;
  mobile: string;
  email?: string;
  role: string;
  territory: string;
  employeeId: string;
  reportingManager: string;
  reportingDesignation: string;
  reportingPhone: string;
  joinedDate: string;
  totalOutlets: number;
  kycCompleted: number;
  visibilitySubmissions: number;
}


interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onClick?: () => void;
  danger?: boolean;
  /** Show the right-hand chevron (an affordance that the row is interactive). Default true. */
  showChevron?: boolean;
}

function MenuItem({ icon, label, value, onClick, danger, showChevron = true }: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
    >
      <div className={`p-2 rounded-lg shrink-0 ${danger ? 'bg-red-50' : 'bg-gray-50'}`}>
        <span className={danger ? 'text-red-500' : 'text-gray-500'}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${danger ? 'text-red-600' : 'text-gray-800'}`}>{label}</p>
        {value && <p className="text-xs text-gray-400 mt-0.5 truncate">{value}</p>}
      </div>
      {!danger && showChevron && <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />}
    </button>
  );
}

function mapUserToProfile(user: {
  name: string;
  phone?: string;
  email?: string;
  role?: string;
  salesUser?: {
    employeeCode?: string;
    region?: string;
    zone?: string;
    joinedAt?: string;
    reportingTo?: { user?: { name?: string; phone?: string }; hierarchyLevel?: { name?: string } } | null;
  } | null;
}): SalesProfile {
  const su = user.salesUser;
  const territory = su?.region ?? su?.zone ?? '';
  const joinedDate = su?.joinedAt ? su.joinedAt.slice(0, 10) : '';
  const reportingName = su?.reportingTo?.user?.name ?? '';
  const reportingLevel = su?.reportingTo?.hierarchyLevel?.name ?? '';
  const reportingManager = reportingName
    ? reportingLevel ? `${reportingName} (${reportingLevel})` : reportingName
    : '';
  const role = ROLE_LABELS[user.role as SalesRole] ?? user.role ?? '';

  return {
    name:            user.name,
    mobile:          user.phone ?? '',
    email:           user.email,
    role,
    territory,
    employeeId:      su?.employeeCode ?? '',
    reportingManager,
    reportingDesignation: reportingLevel,
    reportingPhone:       su?.reportingTo?.user?.phone ?? '',
    joinedDate,
    totalOutlets:         0,
    kycCompleted:         0,
    visibilitySubmissions: 0,
  };
}

export default function SalesProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<SalesProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showManager, setShowManager] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/auth/me', { headers: { ...authHeader() } }).then(r => r.json()),
      // Real outlet counts for the stat tiles (replaces the hardcoded 0s).
      fetch('/api/sales/outlets', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
    ])
      .then(([meJson, outletJson]: [
        { success: boolean; data?: { user: Parameters<typeof mapUserToProfile>[0] }; error?: string },
        { success: boolean; data?: { outlets: { kycStatus?: string }[] } } | null,
      ]) => {
        if (meJson.success && meJson.data) {
          const p = mapUserToProfile(meJson.data.user);
          const outlets = outletJson?.success ? (outletJson.data?.outlets ?? []) : [];
          p.totalOutlets = outlets.length;
          p.kycCompleted = outlets.filter((o) => o.kycStatus === 'APPROVED').length;
          setProfile(p);
        } else {
          setError(meJson.error ?? 'Failed to load profile');
        }
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    document.cookie = 'token=; Max-Age=0; path=/';
    router.push('/auth/login');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen px-6 text-center text-sm text-red-500">
        {error}
      </div>
    );
  }

  if (!profile) return null;

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <h1 className="text-xl font-bold text-gray-900">My Profile</h1>

      {/* Avatar card */}
      <Card>
        <CardContent className="pt-6 pb-5">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 bg-[#1A1A2E] rounded-2xl flex items-center justify-center shrink-0">
              <User className="h-8 w-8 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-gray-900 truncate">{profile.name}</h2>
              <span className="text-xs text-gray-400">{profile.employeeId}</span>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 mt-5 pt-5 border-t border-gray-100">
            <div className="text-center">
              <p className="text-xl font-bold text-gray-900">{profile.totalOutlets}</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Outlets</p>
            </div>
            <div className="text-center border-x border-gray-100">
              <p className="text-xl font-bold text-emerald-600">{profile.kycCompleted}</p>
              <p className="text-[10px] text-gray-400 mt-0.5">KYC Done</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-[var(--brand-primary)]">{profile.visibilitySubmissions}</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Visibility</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Contact details */}
      <Card>
        <CardContent className="px-0 py-1 divide-y divide-gray-50">
          <MenuItem
            icon={<Phone className="h-4 w-4" />}
            label="Mobile"
            value={`+91 ${profile.mobile}`}
            showChevron={false}
          />
          {profile.email && (
            <MenuItem
              icon={<Mail className="h-4 w-4" />}
              label="Email"
              value={profile.email}
              showChevron={false}
            />
          )}
          {profile.reportingManager && (
            <MenuItem
              icon={<Award className="h-4 w-4" />}
              label="Reporting Manager"
              value={profile.reportingManager}
              onClick={() => setShowManager(true)}
            />
          )}
        </CardContent>
      </Card>

      {/* Settings */}
      <Card>
        <CardContent className="px-0 py-1 divide-y divide-gray-50">
          <MenuItem
            icon={<Bell className="h-4 w-4" />}
            label="Notifications"
          />
          <MenuItem
            icon={<Shield className="h-4 w-4" />}
            label="Privacy & Security"
          />
        </CardContent>
      </Card>

      {/* App & Notifications (PWA install / push) */}
      <PwaAppSettings />

      {/* Logout */}
      <Card>
        <CardContent className="px-0 py-1">
          <MenuItem
            icon={<LogOut className="h-4 w-4" />}
            label="Logout"
            onClick={handleLogout}
            danger
          />
        </CardContent>
      </Card>

      {/* Reporting Manager details modal */}
      {showManager && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
          onClick={() => setShowManager(false)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-gray-900">Reporting Manager</h3>
              <button onClick={() => setShowManager(false)} className="p-1 rounded-lg hover:bg-gray-100" aria-label="Close">
                <X className="h-4 w-4 text-gray-400" />
              </button>
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-[#1A1A2E] rounded-xl flex items-center justify-center shrink-0">
                <User className="h-6 w-6 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{profile.reportingManager}</p>
                {profile.reportingDesignation && (
                  <p className="text-xs text-gray-500 truncate">{profile.reportingDesignation}</p>
                )}
              </div>
            </div>
            {profile.reportingPhone && (
              <a
                href={`tel:+91${profile.reportingPhone}`}
                className="flex items-center gap-3 px-4 py-3 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors"
              >
                <Phone className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
                <span className="text-sm font-medium text-gray-800">+91 {profile.reportingPhone}</span>
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
