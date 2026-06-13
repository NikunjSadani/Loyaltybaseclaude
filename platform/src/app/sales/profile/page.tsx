'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, Phone, Mail, MapPin, Award, LogOut,
  ChevronRight, Shield, Bell, HelpCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface SalesProfile {
  name: string;
  mobile: string;
  email?: string;
  role: string;
  territory: string;
  employeeId: string;
  reportingManager: string;
  joinedDate: string;
  totalOutlets: number;
  kycCompleted: number;
  visibilitySubmissions: number;
}

const MOCK_PROFILE: SalesProfile = {
  name: 'Rajesh Kumar',
  mobile: '9876543210',
  email: 'rajesh.kumar@deoleo.com',
  role: 'Sales Officer',
  territory: 'Mumbai West',
  employeeId: 'EMP-2023-0028',
  reportingManager: 'Priya Mehta (ASM)',
  joinedDate: '2023-06-10',
  totalOutlets: 59,
  kycCompleted: 44,
  visibilitySubmissions: 95,
};

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onClick?: () => void;
  danger?: boolean;
}

function MenuItem({ icon, label, value, onClick, danger }: MenuItemProps) {
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
      {!danger && <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />}
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
    reportingTo?: { user?: { name?: string }; hierarchyLevel?: { name?: string } } | null;
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

  return {
    name:            user.name,
    mobile:          user.phone ?? '',
    email:           user.email,
    role:            MOCK_PROFILE.role,   // hierarchyLevel not included in basic /me response; fallback
    territory,
    employeeId:      su?.employeeCode ?? '',
    reportingManager,
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

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((json: { success: boolean; data?: { user: Parameters<typeof mapUserToProfile>[0] }; error?: string }) => {
        if (json.success && json.data) {
          setProfile(mapUserToProfile(json.data.user));
        } else {
          setError(json.error ?? 'Failed to load profile');
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
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="info" className="text-[10px]">{profile.role}</Badge>
                <span className="text-xs text-gray-400">{profile.employeeId}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1 truncate">{profile.territory}</p>
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
          />
          {profile.email && (
            <MenuItem
              icon={<Mail className="h-4 w-4" />}
              label="Email"
              value={profile.email}
            />
          )}
          <MenuItem
            icon={<MapPin className="h-4 w-4" />}
            label="Territory"
            value={profile.territory}
          />
          <MenuItem
            icon={<Award className="h-4 w-4" />}
            label="Reporting Manager"
            value={profile.reportingManager}
          />
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
          <MenuItem
            icon={<HelpCircle className="h-4 w-4" />}
            label="Help & Support"
          />
        </CardContent>
      </Card>

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
    </div>
  );
}
