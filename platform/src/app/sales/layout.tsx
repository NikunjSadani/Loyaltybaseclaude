'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ClipboardList, MapPin, User, Users, HeadphonesIcon, Trophy } from 'lucide-react';
import { NavBottom } from '@/components/layout/nav-bottom';
import type { NavItem } from '@/components/layout/nav-bottom';
import { SiteFooter } from '@/components/layout/site-footer';
import {
  type SalesRole,
  getRole,
  hasTeamView,
} from '@/lib/sales-role';
import { RequireAuth } from '@/components/auth/require-auth';
import { PORTAL_ROLES, getStoredUser } from '@/lib/auth-client';

const BASE_NAV: NavItem[] = [
  { href: '/sales/dashboard',   label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sales/kyc',         label: 'KYC',       icon: ClipboardList },
  { href: '/sales/outlets',     label: 'Outlets',   icon: MapPin },
  { href: '/sales/leaderboard', label: 'Ranks',     icon: Trophy },
  { href: '/sales/support',     label: 'Support',   icon: HeadphonesIcon },
];

const TEAM_NAV: NavItem = { href: '/sales/team', label: 'Team', icon: Users };

// Notifications hidden until P7 notification worker (#21)

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [role, setRoleState] = useState<SalesRole>('SO');
  // REAL identity from the backend sales record (name + employee ID), replacing
  // the demo ROLE_NAMES/ROLE_EMP_IDS personas AND the demo role switcher.
  const [userName, setUserName] = useState('');
  const [empId, setEmpId] = useState('');

  useEffect(() => {
    setRoleState(getRole());
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    fetch('/api/sales/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((res) => {
        if (res?.success) {
          setUserName(res.data.name ?? getStoredUser()?.name ?? '');
          setEmpId(res.data.employeeCode ?? '');
        } else {
          setUserName(getStoredUser()?.name ?? '');
        }
      })
      .catch(() => setUserName(getStoredUser()?.name ?? ''));
  }, []);

  // For manager roles swap "Outlets" for "Team" (managers work through people, not direct outlets)
  const navItems: NavItem[] = hasTeamView(role)
    ? [BASE_NAV[0], BASE_NAV[1], TEAM_NAV, BASE_NAV[3], BASE_NAV[4]]
    : BASE_NAV;
  // BASE_NAV[3] = Leaderboard, BASE_NAV[4] = Support (same for both field & manager roles)

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Top header */}
      <header className="sticky top-0 z-30 bg-[#1A1A2E] text-white px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center">
              <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
              </svg>
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-tight">{userName}</p>
              <p className="text-white/50 text-xs">{empId || ' '}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Notifications hidden until P7 notification worker (#21) */}
            <Link
              href="/sales/profile"
              className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-white/10 transition-colors"
            >
              <div className="w-7 h-7 bg-[var(--brand-primary)] rounded-full flex items-center justify-center">
                <User className="h-4 w-4 text-white" />
              </div>
            </Link>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 pb-20 px-4 py-5"><RequireAuth allowedRoles={PORTAL_ROLES.sales}>{children}</RequireAuth><SiteFooter /></main>

      {/* Mobile bottom nav */}
      <NavBottom items={navItems} />

    </div>
  );
}
