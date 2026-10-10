'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Home, Wallet, Gift, Package, User, Trophy } from 'lucide-react';
import { NavBottom, type NavItem } from '@/components/layout/nav-bottom';
import { Sidebar, type SidebarSection } from '@/components/layout/sidebar';
import { SiteFooter } from '@/components/layout/site-footer';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { RequireAuth } from '@/components/auth/require-auth';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { logout, PORTAL_ROLES } from '@/lib/auth-client';
import { authHeader } from '@/lib/api-client';
import type { EmployeeMe } from './_lib/employee';

/* ─── REP (Employee Rewards) shell ────────────────────────────────────────────
   Mirror of the partner layout: a mobile-first earner shell (desktop sidebar +
   mobile bottom-nav), Britannia-/tenant-themed via the shared clientConfig branding
   tokens, auth-gated to the EMPLOYEE (SALES_*) roles. The employee is account-first
   (no outlet switcher). Login already routes a SALES_* user of an EMPLOYEE_REWARDS
   tenant here (auth is untouched). Identity (name/employee code) comes from
   GET /api/auth/me → user.salesUser — no partner-identity hook (that calls
   /partner/me, which an employee has no record on). ─────────────────────────── */

const NAV_TABS: NavItem[] = [
  { href: '/rep', label: 'Home', icon: Home },
  { href: '/rep/rewards', label: 'Rewards', icon: Gift },
  { href: '/rep/contests', label: 'Contests', icon: Trophy },
  { href: '/rep/orders', label: 'Orders', icon: Package },
  { href: '/rep/wallet', label: 'Wallet', icon: Wallet },
  { href: '/rep/profile', label: 'Profile', icon: User },
];

const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    items: [
      { href: '/rep', label: 'Home', icon: Home },
      { href: '/rep/wallet', label: 'My Wallet', icon: Wallet },
      { href: '/rep/rewards', label: 'Rewards', icon: Gift },
      { href: '/rep/contests', label: 'Contests', icon: Trophy },
      { href: '/rep/orders', label: 'My Orders', icon: Package },
      { href: '/rep/profile', label: 'Profile', icon: User },
    ],
  },
];

export default function RepLayout({ children }: { children: React.ReactNode }) {
  const clientConfig = useClientConfig();
  const [name, setName] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');

  // Light identity fetch for the header/sidebar display only (real data gates are the
  // per-page endpoints + backend scoping). Failure leaves the labels blank — the shell
  // still renders and every page is independently guarded.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: EmployeeMe }) => {
        if (cancelled || !json.success || !json.data) return;
        const u = json.data.user;
        if (u?.name) setName(u.name);
        if (u?.salesUser?.employeeCode) setEmployeeCode(u.salesUser.employeeCode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = () => {
    void logout();
  };

  return (
    <div className="min-h-screen flex">
      <Sidebar
        sections={SIDEBAR_SECTIONS}
        onLogout={handleLogout}
        userName={name || 'My Rewards'}
        userRole={employeeCode ? `Emp ${employeeCode}` : undefined}
        logoLabel={clientConfig.branding.displayName}
        wordmarkWhiteUrl={clientConfig.branding.wordmarkWhiteUrl}
      />

      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Top header */}
        <header className="sticky top-0 z-30">
          {/* iOS safe-area strip — brand-tinted, zero height off-iOS (same as partner). */}
          <div
            aria-hidden="true"
            style={{ height: 'env(safe-area-inset-top)', backgroundColor: 'var(--brand-primary)' }}
          />
          <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              {clientConfig.branding.wordmarkColorUrl ? (
                <Link href="/rep" className="lg:hidden shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={clientConfig.branding.wordmarkColorUrl}
                    alt={clientConfig.branding.displayName}
                    className="h-7 w-auto"
                  />
                </Link>
              ) : (
                <Link href="/rep" className="flex items-center gap-2 lg:hidden shrink-0">
                  <div className="w-8 h-8 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center">
                    <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                      <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
                    </svg>
                  </div>
                </Link>
              )}
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900 leading-tight truncate">
                  {name || clientConfig.branding.displayName}
                </p>
                <p className="text-xs text-gray-400 leading-tight truncate">
                  {employeeCode ? `Employee · ${employeeCode}` : 'My Rewards'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <NotificationBell tone="light" fallbackUrl="/rep" />
              <Link
                href="/rep/profile"
                className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-gray-100 transition-colors"
              >
                <div className="w-7 h-7 bg-[#1A1A2E] rounded-full flex items-center justify-center">
                  <User className="h-4 w-4 text-white" />
                </div>
                <span className="hidden sm:block text-sm font-medium text-gray-700">My Account</span>
              </Link>
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 pb-24 px-4 py-5 max-w-4xl mx-auto w-full">
          <RequireAuth allowedRoles={PORTAL_ROLES.sales}>{children}</RequireAuth>
          <SiteFooter />
        </main>
      </div>

      {/* Bottom nav */}
      <NavBottom items={NAV_TABS} />
    </div>
  );
}
