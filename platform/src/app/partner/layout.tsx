'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Home, Wallet, Gift, Eye, User, Bell } from 'lucide-react';
import { NavBottom } from '@/components/layout/nav-bottom';
import { Sidebar } from '@/components/layout/sidebar';
import type { NavItem } from '@/components/layout/nav-bottom';
import type { SidebarSection } from '@/components/layout/sidebar';

const mobileNavItems: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/wallet', label: 'Wallet', icon: Wallet },
  { href: '/rewards', label: 'Rewards', icon: Gift },
  { href: '/schemes', label: 'Schemes', icon: Eye },
  { href: '/profile', label: 'Profile', icon: User },
];

const sidebarSections: SidebarSection[] = [
  {
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: Home },
      { href: '/wallet', label: 'My Wallet', icon: Wallet },
      { href: '/rewards', label: 'Rewards', icon: Gift },
      { href: '/schemes', label: 'Schemes', icon: Eye },
      { href: '/profile', label: 'Profile', icon: User },
    ],
  },
];

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const handleLogout = () => {
    // Clear session and redirect
    document.cookie = 'session=; Max-Age=0; path=/';
    router.push('/login');
  };

  return (
    <div className="min-h-screen flex">
      <Sidebar
        sections={sidebarSections}
        onLogout={handleLogout}
        userName="Retailer"
        userRole="Partner Portal"
        logoLabel="Deoleo Loyalty"
      />

      <div className="flex-1 flex flex-col min-h-screen">
        {/* Top header */}
        <header className="sticky top-0 z-30 bg-white border-b border-gray-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
                <div className="w-8 h-8 bg-[#C8102E] rounded-lg flex items-center justify-center">
                  <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
                    <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
                  </svg>
                </div>
              </Link>
              <h2 className="text-base font-semibold text-gray-900 hidden sm:block">
                Partner Portal
              </h2>
            </div>

            <div className="flex items-center gap-2">
              <button className="p-2 rounded-full hover:bg-gray-100 text-gray-500 transition-colors relative">
                <Bell className="h-5 w-5" />
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#C8102E] rounded-full" />
              </button>
              <Link
                href="/profile"
                className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-gray-100 transition-colors"
              >
                <div className="w-7 h-7 bg-[#1A1A2E] rounded-full flex items-center justify-center">
                  <User className="h-4 w-4 text-white" />
                </div>
                <span className="hidden sm:block text-sm font-medium text-gray-700">
                  My Account
                </span>
              </Link>
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 pb-20 lg:pb-6 px-4 py-5 max-w-4xl mx-auto w-full">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <div className="lg:hidden">
        <NavBottom items={mobileNavItems} />
      </div>
    </div>
  );
}
