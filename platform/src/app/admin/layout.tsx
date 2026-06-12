'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useMemo } from 'react';
import {
  LayoutDashboard,
  FileCheck,
  Users,
  Tag,
  Eye,
  CreditCard,
  BarChart2,
  FileBarChart2,
  Settings,
  ChevronLeft,
  ChevronRight,
  Bell,
  LogOut,
  ChevronDown,
  Wallet,
  Building2,
  Megaphone,
  TicketCheck,
  Target,
  Gift,
  BadgeCheck,
  Banknote,
  ShoppingBag,
  TrendingUp,
  Coins,
} from 'lucide-react';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { useAdminSession, setDemoAdminRole } from '@/lib/admin-session';

// All possible nav items — feature flags control which are visible
const ALL_NAV_ITEMS = [
  { href: '/admin/dashboard', label: 'Overview', icon: LayoutDashboard, featureFlag: null },
  {
    href: '/admin/dashboards',
    label: 'Dashboards',
    icon: BarChart2,
    featureFlag: null,
    children: [
      { href: '/admin/dashboards/kyc',          label: 'KYC Dashboard'             },
      { href: '/admin/dashboards/payments',     label: 'Payments Dashboard'        },
      { href: '/admin/dashboards/redemptions',  label: 'Gift Redemption Dashboard' },
      { href: '/admin/dashboards/engagement',   label: 'Engagement Dashboard'      },
    ],
  },
  {
    href: '/admin/kyc',
    label: 'KYC Management',
    icon: FileCheck,
    featureFlag: 'kycApprovalFlow' as const,
    children: [
      { href: '/admin/kyc',        label: 'KYC Submissions'  },
      { href: '/admin/approvals',  label: 'KYC Approvals'    },
    ],
  },
  {
    href: '/admin/users',
    label: 'User Management',
    icon: Users,
    featureFlag: null,
    children: [
      { href: '/admin/users/outlets', label: 'Outlet Management'   },
      { href: '/admin/hierarchy',     label: 'Employee Hierarchy'  },
    ],
  },
  { href: '/admin/schemes',  label: 'Scheme Management',icon: Tag,          featureFlag: null, gifsyOnly: true  },
  { href: '/admin/visibility', label: 'Visibility Approval', icon: Eye,     featureFlag: null },
  {
    href: '/admin/invoices',
    label: 'Visibility Invoices',
    icon: FileCheck,
    featureFlag: 'visibilityInvoiceModule' as const,
    children: [
      { href: '/admin/invoices',        label: 'Invoice List'    },
      { href: '/admin/invoices/upload', label: 'Upload Payouts'  },
    ],
  },
  {
    href: '/admin/payouts',
    label: 'Payout Management',
    icon: CreditCard,
    featureFlag: 'walletModule' as const,
    children: [
      { href: '/admin/payouts',      label: 'Payout Batches'  },
      { href: '/admin/payouts/fund', label: 'Fund Management' },
    ],
  },
  { href: '/admin/gifts',    label: 'Gift Catalogue',  icon: Gift,          featureFlag: 'walletModule' as const },
  { href: process.env.NEXT_PUBLIC_EXCEL_TARGETS_ONLY === 'true' ? '/admin/targets/upload' : '/admin/targets', label: 'Targets', icon: Target, featureFlag: null },
  { href: '/admin/sales',    label: 'Sales Data',       icon: TrendingUp,    featureFlag: null },
  {
    href: '/admin/credits-payouts',
    label: 'Credits & Payouts',
    icon: Coins,
    featureFlag: null,
    children: [
      { href: '/admin/credits-payouts/upload',  label: 'Upload Credits'    },
      { href: '/admin/credits-payouts/status',  label: 'Payout Status'     },
      { href: '/admin/credits-payouts/payout',  label: 'Payout Download', gifsyOnly: true },
      { href: '/admin/credits-payouts/fields',  label: 'Field Configuration' },
    ],
  },
  { href: '/admin/tickets',  label: 'Tickets',          icon: TicketCheck,   featureFlag: null },
  { href: '/admin/banners',  label: 'Banners',          icon: Megaphone,     featureFlag: null },
  { href: '/admin/reports',  label: 'Reports',          icon: FileBarChart2, featureFlag: null },
  { href: '/admin/settings', label: 'Settings',         icon: Settings,      featureFlag: null },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname     = usePathname();
  const router       = useRouter();
  const clientConfig = useClientConfig();
  const features     = clientConfig.features;
  const adminSession = useAdminSession();

  function handleLogout() {
    // Clear session and navigate to root (L5 fix)
    if (typeof window !== 'undefined') {
      localStorage.removeItem('admin_role_demo');
    }
    router.push('/');
  }
  const [collapsed, setCollapsed] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Filter nav items by feature flags AND role
  const navItems = useMemo(
    () =>
      ALL_NAV_ITEMS.filter((item) => {
        // gifsyOnly items (e.g. Scheme Management) are hidden from CLIENT_ADMIN
        if ((item as { gifsyOnly?: boolean }).gifsyOnly && !adminSession.canManageSchemes) return false;
        if (!item.featureFlag) return true;
        return !!(features as unknown as Record<string, boolean>)[item.featureFlag];
      }),
    [features, adminSession.canManageSchemes],
  );

  // Auto-expand the parent whose child matches the current path
  const getInitialExpanded = (): string | null => {
    for (const item of navItems) {
      if (item.children) {
        if (item.children.some((c) => pathname === c.href || pathname.startsWith(c.href + '/'))) {
          return item.href;
        }
      }
    }
    return null;
  };
  const [expandedItem, setExpandedItem] = useState<string | null>(getInitialExpanded);

  // A nav item is "active" if the current path matches it OR any of its children
  const isActive = (href: string, children?: { href: string }[]) => {
    if (children) {
      return children.some((c) => pathname === c.href || pathname.startsWith(c.href + '/'));
    }
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
              <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center">
                <Wallet className="w-4 h-4 text-white" />
              </div>
              <div>
                <div className="text-sm font-bold text-white">LoyaltyBase</div>
                <div className="text-xs text-slate-400">Admin Portal</div>
              </div>
            </div>
          )}
          {collapsed && (
            <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center mx-auto">
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
              <Building2 className="w-4 h-4 text-[var(--brand-primary)]" />
              <div>
                <div className="text-xs font-semibold text-white">{clientConfig.branding.displayName}</div>
                <div className="text-xs text-slate-400">
                  {adminSession.role === 'GIFSY_ADMIN' ? 'Gifsy Admin' : 'Client Admin'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto py-4 space-y-1 px-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href, item.children);
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
                          ? 'bg-[var(--brand-primary)] text-white'
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
                        {item.children!
                          .filter((child) => !(child as { gifsyOnly?: boolean }).gifsyOnly || adminSession.canManageSchemes)
                          .map((child) => (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`block px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                              pathname === child.href
                                ? 'bg-[var(--brand-primary)]/20 text-[#22c55e]'
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
                        ? 'bg-[var(--brand-primary)] text-white'
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
        <div className="border-t border-slate-700 p-3 space-y-1">
          {/* Dev role switcher — demo only */}
          {!collapsed && (
            <div className="flex gap-1 mb-2">
              {(['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setDemoAdminRole(r)}
                  className={`flex-1 py-1 rounded text-[10px] font-semibold transition-all ${
                    adminSession.role === r
                      ? 'bg-[var(--brand-primary)] text-white'
                      : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-white'
                  }`}
                  title={`Switch to ${r}`}
                >
                  {r === 'CLIENT_ADMIN' ? 'Client' : 'Gifsy'}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={handleLogout}
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
              {(() => {
                for (const n of navItems) {
                  if (n.children) {
                    const child = n.children.find((c) => pathname === c.href || pathname.startsWith(c.href + '/'));
                    if (child) return child.label;
                  }
                  if (isActive(n.href)) return n.label;
                }
                return 'Admin Portal';
              })()}
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
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[var(--brand-primary)]"></span>
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
                <div className="w-7 h-7 rounded-full bg-[var(--brand-primary)] flex items-center justify-center text-white text-xs font-bold">
                  RA
                </div>
                <div className="text-left hidden sm:block">
                  <div className="text-xs font-semibold text-gray-800">{adminSession.name}</div>
                  <div className="text-xs text-gray-500">
                    {adminSession.role === 'GIFSY_ADMIN' ? 'Gifsy Admin' : 'Client Admin'}
                  </div>
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
