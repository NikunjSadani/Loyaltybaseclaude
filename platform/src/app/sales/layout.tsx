'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ClipboardList, MapPin, User, Bell, X, FileCheck, AlertTriangle, CheckCircle, Coins, Users, ChevronDown, HeadphonesIcon, ListTodo, Trophy } from 'lucide-react';
import { NavBottom } from '@/components/layout/nav-bottom';
import type { NavItem } from '@/components/layout/nav-bottom';
import {
  type SalesRole,
  ROLE_LABELS,
  ROLE_NAMES,
  ROLE_TERRITORY,
  ROLE_EMP_IDS,
  getRole,
  setRole,
  hasTeamView,
} from '@/lib/sales-role';

const BASE_NAV: NavItem[] = [
  { href: '/sales/dashboard',   label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sales/kyc',         label: 'KYC',       icon: ClipboardList },
  { href: '/sales/outlets',     label: 'Outlets',   icon: MapPin },
  { href: '/sales/leaderboard', label: 'Ranks',     icon: Trophy },
  { href: '/sales/support',     label: 'Support',   icon: HeadphonesIcon },
];

const TEAM_NAV: NavItem = { href: '/sales/team', label: 'Team', icon: Users };

const ALL_ROLES: SalesRole[] = ['XSR', 'SO', 'ASM', 'RSM', 'ZM', 'NM'];

const NOTIFICATIONS = [
  { id: 1, icon: FileCheck,    iconBg: 'bg-green-100 text-green-600',  title: 'KYC Approved',       body: 'Kumar General Store KYC has been approved.', time: '10 min ago', unread: true },
  { id: 2, icon: AlertTriangle,iconBg: 'bg-amber-100 text-amber-600',  title: 'KYC Rejected',        body: 'Patel Grocery — re-upload required.',         time: '1 hr ago',  unread: true },
  { id: 3, icon: CheckCircle,  iconBg: 'bg-blue-100 text-blue-600',    title: 'Visibility Approved', body: 'Singh Supermart display submission approved.', time: '3 hrs ago', unread: false },
  { id: 4, icon: Coins,        iconBg: 'bg-purple-100 text-purple-600',title: 'Target Achievement',  body: 'You have reached 76% of your monthly target.', time: '1 day ago', unread: false },
];

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [role, setRoleState] = useState<SalesRole>('SO');
  const [rolePicker, setRolePicker] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState(NOTIFICATIONS);

  useEffect(() => {
    setRoleState(getRole());
  }, []);

  const unreadCount = notifications.filter((n) => n.unread).length;

  const openNotif = () => {
    setNotifOpen(true);
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
  };

  const switchRole = (r: SalesRole) => {
    setRole(r);
    setRoleState(r);
    setRolePicker(false);
  };

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
              <p className="text-white font-semibold text-sm leading-tight">{ROLE_NAMES[role]}</p>
              <p className="text-white/50 text-xs">{ROLE_EMP_IDS[role]}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Demo role switcher */}
            <div className="relative">
              <button
                onClick={() => setRolePicker((v) => !v)}
                className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/10 hover:bg-white/20 text-white/70 text-[10px] font-semibold transition-colors"
              >
                DEMO
                <ChevronDown className="h-3 w-3" />
              </button>
              {rolePicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setRolePicker(false)} />
                  <div className="absolute right-0 top-full mt-1.5 z-50 bg-white rounded-xl shadow-xl border border-gray-100 py-1 min-w-[160px]">
                    {ALL_ROLES.map((r) => (
                      <button
                        key={r}
                        onClick={() => switchRole(r)}
                        className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-gray-50 transition-colors ${r === role ? 'text-[var(--brand-primary)] font-semibold' : 'text-gray-700'}`}
                      >
                        <span>{ROLE_LABELS[r]}</span>
                        {r === role && <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)]" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <button
              onClick={openNotif}
              className="p-2 rounded-full hover:bg-white/10 text-white/70 transition-colors relative"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[var(--brand-primary)] rounded-full" />
              )}
            </button>
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
      <main className="flex-1 pb-20 px-4 py-5">{children}</main>

      {/* Mobile bottom nav */}
      <NavBottom items={navItems} />

      {/* Notification slide-up panel */}
      {notifOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setNotifOpen(false)} />
          {/* Panel */}
          <div className="relative bg-white rounded-t-2xl max-h-[75vh] flex flex-col">
            {/* Handle */}
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
          </div>
        </div>
      )}
    </div>
  );
}
