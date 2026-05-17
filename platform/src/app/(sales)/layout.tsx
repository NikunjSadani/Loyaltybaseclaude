'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ClipboardList, MapPin, Eye, User, Bell } from 'lucide-react';
import { NavBottom } from '@/components/layout/nav-bottom';
import type { NavItem } from '@/components/layout/nav-bottom';

const mobileNavItems: NavItem[] = [
  { href: '/sales/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sales/kyc', label: 'KYC', icon: ClipboardList },
  { href: '/sales/outlets', label: 'Outlets', icon: MapPin },
  { href: '/sales/visibility', label: 'Visibility', icon: Eye },
  { href: '/sales/profile', label: 'Profile', icon: User },
];

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Top header */}
      <header className="sticky top-0 z-30 bg-[#1A1A2E] text-white px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#C8102E] rounded-lg flex items-center justify-center">
              <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
              </svg>
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-tight">Sales Portal</p>
              <p className="text-white/50 text-xs">Deoleo Loyalty</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 rounded-full hover:bg-white/10 text-white/70 transition-colors relative">
              <Bell className="h-5 w-5" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#C8102E] rounded-full" />
            </button>
            <Link
              href="/sales/profile"
              className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-white/10 transition-colors"
            >
              <div className="w-7 h-7 bg-[#C8102E] rounded-full flex items-center justify-center">
                <User className="h-4 w-4 text-white" />
              </div>
              <span className="text-sm font-medium text-white/80 hidden sm:block">Sales</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 pb-20 px-4 py-5">{children}</main>

      {/* Mobile bottom nav */}
      <NavBottom items={mobileNavItems} />
    </div>
  );
}
