'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Home, Wallet, Gift, User, HeadphonesIcon, Target, Medal,
  Store, Users, ChevronDown, Check, ClipboardList,
} from 'lucide-react';
import { setActivePartner } from '@/lib/active-partner-actions';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { NavBottom } from '@/components/layout/nav-bottom';
import { Sidebar } from '@/components/layout/sidebar';
import { SiteFooter } from '@/components/layout/site-footer';
import type { NavItem } from '@/components/layout/nav-bottom';
import type { SidebarSection } from '@/components/layout/sidebar';
import { usePartnerIdentity } from '@/lib/partner-identity';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { RequireAuth } from '@/components/auth/require-auth';
import { logout, PORTAL_ROLES } from '@/lib/auth-client';

/* ── Outlet switcher (Wave 3) ───────────────────────────────────────────────────
   Compact header control shown ONLY to a login that operates more than one outlet.
   Lists the operable outlets, marks the one currently active (matching
   `active_partner_id`, or the own outlet when nothing is selected), and on selection
   writes the cookie via setActivePartner then hard-reloads /partner/dashboard so all
   data refetches under the newly-active outlet. Single-outlet logins never render it. */
export function OutletSwitcher({
  outlets,
  activePartnerId,
}: {
  outlets: import('@/lib/partner-identity').OperableOutlet[];
  activePartnerId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isCurrent = (o: import('@/lib/partner-identity').OperableOutlet) =>
    activePartnerId ? o.partnerId === activePartnerId : o.isOwnLogin;
  const current = outlets.find(isCurrent) ?? outlets[0];

  const choose = async (partnerId: string) => {
    setBusy(true);
    await setActivePartner(partnerId);
    // Hard reload so the proxy re-injects x-active-partner-id and every page refetches.
    window.location.href = '/partner/dashboard';
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 pl-2 pr-2 py-1.5 rounded-full hover:bg-gray-100 text-gray-600 transition-colors max-w-[9rem]"
      >
        <Store className="h-4 w-4 shrink-0 text-[var(--brand-primary)]" />
        <span className="hidden sm:block text-sm font-medium truncate">
          {current?.businessName ?? 'Switch outlet'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 mt-1 w-64 max-h-80 overflow-y-auto bg-white rounded-xl border border-gray-200 shadow-lg z-50 py-1"
          >
            <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Switch outlet
            </p>
            {outlets.map((o) => {
              const active = isCurrent(o);
              return (
                <button
                  key={o.partnerId}
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => (active ? setOpen(false) : choose(o.partnerId))}
                  className="w-full flex items-center gap-2 text-left px-3 py-2.5 hover:bg-gray-50 disabled:opacity-60"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{o.businessName}</p>
                    <p className="text-xs text-gray-400 truncate">{o.outletCode}</p>
                  </div>
                  {active && <Check className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────────── */

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  const router       = useRouter();
  const identity     = usePartnerIdentity(); // REAL identity + presence signals (replaces demo persona/track)
  const clientConfig = useClientConfig();
  // Feature gating is DB-sourced from the same authenticated /partner/me response
  // (§A-DOMAIN "P5"), NOT the in-code registry. Branding still comes from clientConfig.
  const features     = identity.features;

  const handleLogout = () => {
    // logout() clears the httpOnly cookies server-side + local display state, then redirects.
    void logout();
  };

  // Wave 3 — Group Overview is login-scoped, NOT an operable outlet. Clear the
  // active-partner cookie before navigating (exactly like the picker's chooseGroupOverview),
  // so a user who had switched to a sibling returns to their OWN outlet context after
  // viewing the overview. Plain <Link> otherwise; only wired for the gated group entry.
  const handleGroupOverview: React.MouseEventHandler<HTMLAnchorElement> = async (e) => {
    e.preventDefault();
    await setActivePartner(null);
    router.push('/partner/group');
  };

  /* ── Nav items — gated by feature flags ── */
  const walletOn      = features.walletModule;
  const rewardsOn     = features.walletModule && identity.hasPointsActivity;
  const leaderboardOn = features.partnerApp.showLeaderboard;
  // Wave 3 — the read-only group overview nav entry (page built by FE-2), shown only
  // when this login belongs to an owner group.
  const groupOn       = identity.groupOverviewAvailable;

  const mobileNavItems: NavItem[] = [
    { href: '/partner/dashboard',    label: 'Home',       icon: Home          },
    ...(walletOn      ? [{ href: '/partner/wallet',      label: 'Wallet',     icon: Wallet } as NavItem] : []),
    { href: '/partner/targets',      label: 'Targets',    icon: Target        },
    ...(leaderboardOn ? [{ href: '/partner/leaderboard', label: 'Ranking',    icon: Medal  } as NavItem] : []),
    { href: '/partner/support',      label: 'Support',    icon: HeadphonesIcon },
    ...(rewardsOn     ? [{ href: '/partner/rewards',     label: 'Redeem',     icon: Gift   } as NavItem] : []),
  ];

  const sidebarSections: SidebarSection[] = [
    {
      items: [
        { href: '/partner/dashboard',    label: 'Dashboard',    icon: Home          },
        ...(groupOn       ? [{ href: '/partner/group',       label: 'Group Overview', icon: Users, onClick: handleGroupOverview }] : []),
        ...(walletOn      ? [{ href: '/partner/wallet',      label: 'My Wallet',  icon: Wallet }] : []),
        ...(rewardsOn     ? [{ href: '/partner/rewards',     label: 'Rewards',    icon: Gift   }] : []),
        { href: '/partner/targets',      label: 'Targets',      icon: Target        },
        ...(leaderboardOn ? [{ href: '/partner/leaderboard', label: 'Leaderboard', icon: Medal  }] : []),
        { href: '/partner/schemes',      label: 'Activations',  icon: ClipboardList },
        { href: '/partner/support',      label: 'Support',      icon: HeadphonesIcon },
        { href: '/partner/profile',      label: 'Profile',      icon: User          },
      ],
    },
  ];

  return (
    <div className="min-h-screen flex">
      <Sidebar
        sections={sidebarSections}
        onLogout={handleLogout}
        userName={identity.businessName}
        userRole={identity.ownerName}
        logoLabel={clientConfig.branding.displayName}
        wordmarkWhiteUrl={clientConfig.branding.wordmarkWhiteUrl}
      />

      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Top header */}
        <header className="sticky top-0 z-30">
          {/* iOS safe-area strip — brand-tinted so the WHITE status-bar icons stay
              readable behind it on an installed PWA (Option C). Zero height off-iOS
              (env(safe-area-inset-top)=0), so the header is unchanged in a browser. */}
          <div aria-hidden="true" style={{ height: 'env(safe-area-inset-top)', backgroundColor: 'var(--brand-primary)' }} />
          <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              {/* Brand mark (mobile only — desktop shows it in the sidebar). The colour
                  wordmark sits on the white header; falls back to the hex mark per tenant. */}
              {clientConfig.branding.wordmarkColorUrl ? (
                <Link href="/partner/dashboard" className="lg:hidden shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={clientConfig.branding.wordmarkColorUrl}
                    alt={clientConfig.branding.displayName}
                    className="h-7 w-auto"
                  />
                </Link>
              ) : (
                <Link href="/partner/dashboard" className="flex items-center gap-2 lg:hidden shrink-0">
                  <div className="w-8 h-8 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center">
                    <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                      <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
                    </svg>
                  </div>
                </Link>
              )}
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900 leading-tight truncate">{identity.businessName}</p>
                <p className="text-xs text-gray-400 leading-tight truncate">
                  {identity.ownerName}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Outlet switcher (Wave 3) — only for a login that operates >1 outlet. */}
              {identity.operableOutlets.length > 1 && (
                <OutletSwitcher
                  outlets={identity.operableOutlets}
                  activePartnerId={identity.activePartnerId}
                />
              )}

              {/* Notification bell (real feed — Phase 1) */}
              <NotificationBell tone="light" fallbackUrl="/partner/dashboard" />

              <Link
                href="/partner/profile"
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
          <RequireAuth allowedRoles={PORTAL_ROLES.partner}>{children}</RequireAuth>
          <SiteFooter />
        </main>
      </div>

      {/* Bottom nav */}
      <NavBottom items={mobileNavItems} />
    </div>
  );
}
