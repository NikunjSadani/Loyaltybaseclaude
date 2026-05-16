'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  LayoutDashboard,
  FileCheck,
  Users,
  Tag,
  Eye,
  CreditCard,
  BarChart2,
  Settings,
  ChevronLeft,
  ChevronRight,
  Bell,
  LogOut,
  ChevronDown,
  Wallet,
  Building2,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/kyc', label: 'KYC Management', icon: FileCheck },
  { href: '/users', label: 'User Management', icon: Users },
  { href: '/schemes', label: 'Scheme Management', icon: Tag },
  { href: '/visibility', label: 'Visibility Approval', icon: Eye },
  {
    href: '/payouts',
    label: 'Payout Management',
    icon: CreditCard,
    children: [
      { href: '/payouts', label: 'Payout Batches' },
      { href: '/payouts/fund', label: 'Fund Management' },
    ],
  },
  { href: '/reports', label: 'Reports', icon: BarChart2 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedItem, setExpandedItem] = useState<string | null>('/payouts');
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === '/payouts') return pathname.startsWith('/payouts');
    return pathname === href || pathname.startsWith(href + '/');
  };

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-[#1A1A2E] text-slate-200 transition-all duration-300 ${
          collapsed ? 'w-16' : 'w-64'
        } flex-shrink-0`}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-slate-700">
          {!collapsed && (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[#C8102E] flex items-center justify-center">
                <Wallet className="w-4 h-4 text-white" />
              </div>
              <div>
                <div className="text-sm font-bold text-white">LoyaltyBase</div>
                <div className="text-xs text-slate-400">Admin Portal</div>
              </div>
            </div>
          )}
          {collapsed && (
            <div className="w-8 h-8 rounded-lg bg-[#C8102E] flex items-center justify-center mx-auto">
              <Wallet className="w-4 h-4 text-white" />
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* Client badge */}
        {!collapsed && (
          <div className="px-4 py-3 border-b border-slate-700">
            <div className="flex items-center gap-2 bg-[#16213E] rounded-lg px-3 py-2">
              <Building2 className="w-4 h-4 text-[#C8102E]" />
              <div>
                <div className="text-xs font-semibold text-white">Parle Agro Ltd</div>
                <div className="text-xs text-slate-400">Client Admin</div>
              </div>
            </div>
          </div>
        )}

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto py-4 space-y-1 px-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            const hasChildren = item.children && item.children.length > 0;

            return (
              <div key={item.href}>
                {hasChildren ? (
                  <>
                    <button
                      onClick={() =>
                        setExpandedItem(expandedItem === item.href ? null : item.href)
                      }
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                        active
                          ? 'bg-[#C8102E] text-white'
                          : 'text-slate-300 hover:bg-[#16213E] hover:text-white'
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {!collapsed && (
                        <>
                          <span className="flex-1 text-left">{item.label}</span>
                          <ChevronDown
                            className={`w-3 h-3 transition-transform ${
                              expandedItem === item.href ? 'rotate-180' : ''
                            }`}
                          />
                        </>
                      )}
                    </button>
                    {!collapsed && expandedItem === item.href && (
                      <div className="ml-7 mt-1 space-y-1">
                        {item.children!.map((child) => (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`block px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                              pathname === child.href
                                ? 'bg-[#C8102E]/20 text-[#e8294d]'
                                : 'text-slate-400 hover:text-white hover:bg-[#16213E]'
                            }`}
                          >
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                      active
                        ? 'bg-[#C8102E] text-white'
                        : 'text-slate-300 hover:bg-[#16213E] hover:text-white'
                    }`}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-700 p-3">
          <button
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-[#16213E] transition-all"
            title={collapsed ? 'Logout' : undefined}
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            {!collapsed && <span>Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0 z-10">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">
              {navItems.find((n) => isActive(n.href))?.label ?? 'Admin Portal'}
            </h1>
            <p className="text-xs text-gray-500">
              {new Date().toLocaleDateString('en-IN', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Notifications */}
            <div className="relative">
              <button
                onClick={() => { setNotifOpen(!notifOpen); setUserMenuOpen(false); }}
                className="relative p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <Bell className="w-5 h-5" />
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#C8102E]"></span>
              </button>
              {notifOpen && (
                <div className="absolute right-0 top-11 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50">
                  <div className="p-4 border-b border-gray-100">
                    <h3 className="font-semibold text-gray-900 text-sm">Notifications</h3>
                  </div>
                  <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                    {[
                      { text: '14 KYC submissions pending review', time: '2 min ago', type: 'warn' },
                      { text: 'Payout batch March 2025 processed', time: '1 hr ago', type: 'success' },
                      { text: 'Fund balance below threshold', time: '3 hrs ago', type: 'error' },
                      { text: 'New scheme "Summer Push" published', time: '5 hrs ago', type: 'info' },
                    ].map((n, i) => (
                      <div key={i} className="px-4 py-3 hover:bg-gray-50 cursor-pointer">
                        <p className="text-xs text-gray-700">{n.text}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{n.time}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative">
              <button
                onClick={() => { setUserMenuOpen(!userMenuOpen); setNotifOpen(false); }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="w-7 h-7 rounded-full bg-[#C8102E] flex items-center justify-center text-white text-xs font-bold">
                  RA
                </div>
                <div className="text-left hidden sm:block">
                  <div className="text-xs font-semibold text-gray-800">Rahul Agarwal</div>
                  <div className="text-xs text-gray-500">Client Admin</div>
                </div>
                <ChevronDown className="w-3 h-3 text-gray-400" />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-11 w-44 bg-white rounded-xl shadow-lg border border-gray-200 z-50 py-1">
                  <a href="#" className="block px-4 py-2 text-xs text-gray-700 hover:bg-gray-50">Profile Settings</a>
                  <a href="#" className="block px-4 py-2 text-xs text-gray-700 hover:bg-gray-50">Change Password</a>
                  <hr className="my-1 border-gray-100" />
                  <a href="#" className="block px-4 py-2 text-xs text-red-600 hover:bg-red-50">Sign Out</a>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
