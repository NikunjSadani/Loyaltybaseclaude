'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
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
import { useClientConfig } from '@/lib/platform/client-config-context';
import { appDisplayName } from '@/lib/platform/app-display-name';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { SalesFeaturesContext } from '@/lib/sales-features-context';
import { normalizeFeatures } from '@/lib/tenant-features';
import { getSalesMe } from '@/lib/cached-reads';
import { usePrefetchOnce } from '@/lib/navigation/prefetch-once';
import type { FeatureFlags } from '@/lib/platform/client-config';

const BASE_NAV: NavItem[] = [
  { href: '/sales/dashboard',   label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sales/kyc',         label: 'KYC',       icon: ClipboardList },
  { href: '/sales/outlets',     label: 'Outlets',   icon: MapPin },
  { href: '/sales/leaderboard', label: 'Ranks',     icon: Trophy },
  { href: '/sales/support',     label: 'Support',   icon: HeadphonesIcon },
];

const TEAM_NAV: NavItem = { href: '/sales/team', label: 'Team', icon: Users };
const SESSION_PREFETCH = ['/sales/profile', '/sales/tasks'] as const;

// Notifications hidden until P7 notification worker (#21)

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const clientConfig = useClientConfig();
  const [role, setRoleState] = useState<SalesRole>('SO');
  // REAL identity from the backend sales record (name + employee ID) — the demo
  // personas and role switcher have been retired.
  const [userName, setUserName] = useState('');
  const [empId, setEmpId] = useState('');
  // Tenant flags from the SAME /api/sales/me response (no extra request) — published to sales pages via
  // SalesFeaturesContext (e.g. Profile's "Help & videos" entry). null until it resolves → every flag reads OFF.
  const [features, setFeatures] = useState<FeatureFlags | null>(null);

  // Re-read on every screen change THROUGH the 60 s cache: at most one /api/sales/me a minute, and the features
  // published to every sales page (SalesFeaturesContext) are never more than ~60 s behind an admin toggle.
  const pathname = usePathname();
  useEffect(() => {
    setRoleState(getRole());
    // Session-cached (lib/cached-reads.ts, 60 s): shared with every page's useTenantFeatures('/api/sales/me').
    getSalesMe<{ name?: string; employeeCode?: string; features?: unknown }>()
      .then((res) => {
        if (res?.success && res.data) {
          setUserName(res.data.name ?? getStoredUser()?.name ?? '');
          setEmpId(res.data.employeeCode ?? '');
          setFeatures(normalizeFeatures(res.data.features));
        } else {
          // A failed re-read keeps what is already on screen.
          setUserName((prev) => prev || (getStoredUser()?.name ?? ''));
        }
      })
      .catch(() => setUserName((prev) => prev || (getStoredUser()?.name ?? '')));
  }, [pathname]);

  // For manager roles swap "Outlets" for "Team" (managers work through people, not direct outlets)
  const navItems: NavItem[] = hasTeamView(role)
    ? [BASE_NAV[0], BASE_NAV[1], TEAM_NAV, BASE_NAV[3], BASE_NAV[4]]
    : BASE_NAV;
  // BASE_NAV[3] = Leaderboard, BASE_NAV[4] = Support (same for both field & manager roles)

  // Header Profile link + the dashboard's Tasks shortcut: warmed ONCE per session (the bottom-nav tabs are warmed by
  // NavBottom itself). Replaces <Link>'s per-navigation auto prefetch — see components/navigation/no-prefetch-link.tsx.
  usePrefetchOnce(SESSION_PREFETCH);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Top header — pad the top by the iOS safe-area inset so the content clears
          the translucent status bar on an installed PWA (viewport-fit=cover +
          apple-mobile-web-app-status-bar-style=black-translucent). The navy bg fills
          the inset. Mirrors the bottom nav's safe-area-inset-bottom handling. */}
      <header
        className="sticky top-0 z-30 bg-[#1A1A2E] text-white px-4 pb-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {clientConfig.branding.wordmarkWhiteUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={clientConfig.branding.wordmarkWhiteUrl}
                alt={appDisplayName(clientConfig.branding)}
                className="h-7 w-auto shrink-0"
              />
            ) : (
              <div className="w-8 h-8 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center shrink-0">
                <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                  <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
                </svg>
              </div>
            )}
            <div className="min-w-0">
              <p className="text-white font-semibold text-sm leading-tight truncate">{userName}</p>
              <p className="text-white/50 text-xs">{empId || ' '}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Notification bell (real feed — Phase 1) */}
            <NotificationBell tone="dark" fallbackUrl="/sales/dashboard" />
            <Link
              href="/sales/profile"
              prefetch={false}
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
      <main className="flex-1 pb-20 px-4 py-5"><RequireAuth allowedRoles={PORTAL_ROLES.sales}><SalesFeaturesContext.Provider value={features}>{children}</SalesFeaturesContext.Provider></RequireAuth><SiteFooter /></main>

      {/* Mobile bottom nav */}
      <NavBottom items={navItems} />

    </div>
  );
}
