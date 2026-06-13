'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Home, Wallet, Gift, User, Bell, CheckCircle,
  Coins, Trophy, X, HeadphonesIcon, Target, Banknote, Medal,
} from 'lucide-react';
import { NavBottom } from '@/components/layout/nav-bottom';
import { Sidebar } from '@/components/layout/sidebar';
import type { NavItem } from '@/components/layout/nav-bottom';
import type { SidebarSection } from '@/components/layout/sidebar';
import {
  usePartnerSession, OUTLET_TYPE_LABELS, OUTLET_TYPE_COLORS,
  type OutletType,
} from '@/lib/partner-session';
import { useClientConfig } from '@/lib/platform/client-config-context';

/* ── Demo switcher (dev only) ────────────────────────────────────────────────
   In production this is replaced by actual auth. */
import { setDemoOutletType } from '@/lib/partner-session';

function DemoSwitcher({ current }: { current: OutletType }) {
  const types: OutletType[] = ['WHOLESALER', 'SSS', 'SUB_STOCKIST', 'SSS_TOT'];
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex gap-1 bg-gray-900/90 backdrop-blur rounded-full px-3 py-1.5 shadow-lg lg:bottom-4">
      <span className="text-[10px] text-gray-400 self-center mr-1">Demo:</span>
      {types.map(t => (
        <button
          key={t}
          onClick={() => { setDemoOutletType(t); window.location.reload(); }}
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
            current === t ? 'bg-[var(--brand-primary)] text-white' : 'text-gray-300 hover:text-white'
          }`}
        >
          {t === 'SUB_STOCKIST' ? 'SS' : t === 'WHOLESALER' ? 'WS' : t}
        </button>
      ))}
    </div>
  );
}

/* ── Notifications ───────────────────────────────────────────────────────────── */

function getNotifications(track: 'POINTS' | 'INR') {
  if (track === 'POINTS') {
    return [
      { id: 1, icon: Coins,       iconBg: 'bg-emerald-100 text-emerald-600', title: '200 points credited',      body: 'KPI achievement — May 2026 cycle confirmed.',         time: '2 min ago',  unread: true  },
      { id: 2, icon: Trophy,      iconBg: 'bg-amber-100 text-amber-600',     title: 'Rank improved!',           body: 'You moved up to Rank #12 on the leaderboard.',       time: '1 hr ago',   unread: true  },
      { id: 3, icon: CheckCircle, iconBg: 'bg-blue-100 text-blue-600',       title: 'Redemption confirmed',     body: 'Amazon Voucher ₹500 — delivery in 3–5 days.',        time: '3 hrs ago',  unread: false },
    ];
  }
  return [
    { id: 1, icon: Banknote,    iconBg: 'bg-emerald-100 text-emerald-600', title: 'Payout confirmed — ₹8,000',  body: 'UTR 506210001234 · Payment transferred to your bank.', time: '2 min ago',  unread: true  },
    { id: 2, icon: CheckCircle, iconBg: 'bg-blue-100 text-blue-600',       title: 'KPI achievement confirmed',  body: 'April 2026 — 100% achieved. Payout processing.',       time: '1 day ago',  unread: true  },
    { id: 3, icon: Target,      iconBg: 'bg-amber-100 text-amber-600',     title: 'Target updated',             body: 'May 2026 target has been set. Check your dashboard.',  time: '3 days ago', unread: false },
  ];
}

/* ── Page ─────────────────────────────────────────────────────────────────────── */

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  const router       = useRouter();
  const session      = usePartnerSession();
  const clientConfig = useClientConfig();
  const features     = clientConfig.features;
  const [notifOpen,      setNotifOpen]      = useState(false);
  const [notifications,  setNotifications]  = useState(() => getNotifications(session.track));

  const unreadCount = notifications.filter(n => n.unread).length;
  const markAllRead = () => setNotifications(prev => prev.map(n => ({ ...n, unread: false })));

  const handleLogout = () => {
    document.cookie = 'token=; Max-Age=0; path=/';
    router.push('/auth/login');
  };

  /* ── Nav items — gated by feature flags ── */
  const walletOn      = features.walletModule;
  const rewardsOn     = features.walletModule && session.track === 'POINTS';
  const leaderboardOn = features.partnerApp.showLeaderboard;

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
        ...(walletOn      ? [{ href: '/partner/wallet',      label: 'My Wallet',  icon: Wallet }] : []),
        ...(rewardsOn     ? [{ href: '/partner/rewards',     label: 'Rewards',    icon: Gift   }] : []),
        { href: '/partner/targets',      label: 'Targets',      icon: Target        },
        ...(leaderboardOn ? [{ href: '/partner/leaderboard', label: 'Leaderboard', icon: Medal  }] : []),
        { href: '/partner/support',      label: 'Support',      icon: HeadphonesIcon },
        { href: '/partner/profile',      label: 'Profile',      icon: User          },
      ],
    },
  ];

  const typeColors = OUTLET_TYPE_COLORS[session.outletType];

  return (
    <div className="min-h-screen flex">
      <Sidebar
        sections={sidebarSections}
        onLogout={handleLogout}
        userName={session.firmName}
        userRole={`${session.partnerName} · ${session.tier} Partner`}
        logoLabel={clientConfig.branding.displayName}
      />

      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Top header */}
        <header className="sticky top-0 z-30 bg-white border-b border-gray-200 px-4 py-3">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              <Link href="/partner/dashboard" className="flex items-center gap-2 lg:hidden shrink-0">
                <div className="w-8 h-8 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center">
                  <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                    <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
                  </svg>
                </div>
              </Link>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-bold text-gray-900 leading-tight truncate">{session.firmName}</p>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${typeColors.bg} ${typeColors.text}`}>
                    {OUTLET_TYPE_LABELS[session.outletType]}
                  </span>
                </div>
                <p className="text-xs text-gray-400 leading-tight truncate">
                  {session.partnerName} · {session.tier} Partner
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Notification bell */}
              <button
                onClick={() => { setNotifOpen(true); markAllRead(); }}
                className="p-2 rounded-full hover:bg-gray-100 text-gray-500 transition-colors relative"
                aria-label="Notifications"
              >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[var(--brand-primary)] rounded-full" />
                )}
              </button>

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
          {children}
        </main>
      </div>

      {/* Bottom nav */}
      <NavBottom items={mobileNavItems} />

      {/* Demo outlet type switcher */}
      <DemoSwitcher current={session.outletType} />

      {/* Notification panel */}
      {notifOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNotifOpen(false)} />
          <div className="relative bg-white rounded-t-2xl max-h-[75vh] flex flex-col">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">Notifications</h3>
              <button onClick={() => setNotifOpen(false)} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto divide-y divide-gray-50">
              {notifications.map((n) => {
                const Icon = n.icon;
                return (
                  <div key={n.id} className="flex items-start gap-3 px-5 py-4">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${n.iconBg}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{n.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{n.body}</p>
                      <p className="text-xs text-gray-400 mt-1">{n.time}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-3 border-t border-gray-100">
              <Link href="/partner/wallet" className="text-sm text-[var(--brand-primary)] font-medium" onClick={() => setNotifOpen(false)}>
                View all activity →
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
