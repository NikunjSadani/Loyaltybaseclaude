'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useMemo, useEffect } from 'react';
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
  Landmark,
  Smartphone,
  BookOpen,
} from 'lucide-react';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { useTenantFeatures } from '@/lib/tenant-features';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { useAdminSession, adminRoleLabel } from '@/lib/admin-session';
import { RequireAuth } from '@/components/auth/require-auth';
import { logout, PORTAL_ROLES, getStoredUser } from '@/lib/auth-client';
import { useAssumedContext } from '@/lib/use-assumed-context';
import { OperatorBanner } from '@/components/operator/operator-banner';
import { SiteFooter } from '@/components/layout/site-footer';
import { AdminRouteGuard } from '@/components/rbac/admin-route-guard';

// All possible nav items — feature flags control which are visible
const ALL_NAV_ITEMS = [
  { href: '/admin/dashboard', label: 'Overview', icon: LayoutDashboard, featureFlag: null },
  {
    href: '/admin/dashboards',
    label: 'Dashboards',
    icon: BarChart2,
    featureFlag: null,
    children: [
      { href: '/admin/dashboards/kyc',            label: 'KYC Dashboard'       },
      { href: '/admin/dashboards/program-health', label: 'Program Health'      },
      { href: '/admin/dashboards/operations',     label: 'Operations'          },
      { href: '/admin/dashboards/finance',        label: 'Finance & Liability' },
    ],
  },
  {
    href: '/admin/kyc',
    label: 'KYC Management',
    icon: FileCheck,
    featureFlag: 'kycApprovalFlow' as const,
    children: [
      { href: '/admin/kyc',            label: 'KYC Submissions'  },
      // NOTE(P3): mark gifsyOnly:true once real roles are wired — KYC approval is Gifsy-operated.
      // Left visible for now so the DEMO surfaces it (gifsyOnly links are hidden in demo mode).
      { href: '/admin/kyc/approvals',  label: 'KYC Approvals' },
    ],
  },
  {
    href: '/admin/users',
    label: 'User Management',
    icon: Users,
    featureFlag: null,
    children: [
      // NOTE: list the more-specific child paths FIRST. The header-title resolver below
      // matches a child via `startsWith(child.href + '/')`, and '/admin/users' is a prefix
      // of '/admin/users/outlets' — putting User Accounts last keeps the outlets page's
      // title correct while still exact-matching '/admin/users' for itself.
      { href: '/admin/users/outlets', label: 'Outlet Management'   },
      // Owner Groups (parent multi-outlet management) — usable by GIFSY_ADMIN AND
      // CLIENT_ADMIN (create/list/ungroup are partners:manage_outlets), so NOT gifsyOnly.
      // Listed before the bare '/admin/users' so the header-title resolver's
      // startsWith(child.href + '/') match stays correct.
      { href: '/admin/users/parents', label: 'Owner Groups'        },
      { href: '/admin/hierarchy',     label: 'Employee Hierarchy'  },
      { href: '/admin/users',         label: 'User Accounts'       },
    ],
  },
  { href: '/admin/schemes',  label: 'Scheme Management',icon: Tag,          featureFlag: null, gifsyOnly: true  },
  // Outlet Wallet — GIFSY-only points wallet viewer + manual credit/debit adjust (money-adjacent).
  // Page guarded to GIFSY_ADMIN via admin/outlet-wallet/layout.tsx; nav hidden for CLIENT_ADMIN.
  { href: '/admin/outlet-wallet', label: 'Outlet Wallet', icon: Wallet, featureFlag: null, gifsyOnly: true },
  // Tenant read-only scheme coverage reports (D2/D26). Shown to tenant admins
  // (CLIENT_ADMIN / MIS_USER) only — GIFSY manages + reports from /admin/schemes.
  { href: '/admin/scheme-reports', label: 'Scheme Reports', icon: FileBarChart2, featureFlag: null, tenantReportOnly: true },
  // Visibility (POSM) capture management is GIFSY-only (config / form / approve-reject queue).
  { href: '/admin/visibility', label: 'Visibility (POSM)', icon: Eye, featureFlag: null, gifsyOnly: true },
  // Tenant read-only POSM coverage reports — shown to tenant admins (CLIENT_ADMIN / MIS_USER) only.
  { href: '/admin/visibility-reports', label: 'Visibility Reports', icon: FileBarChart2, featureFlag: null, tenantReportOnly: true },
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
    // Q1: payout management is GIFSY-only — hidden from CLIENT_ADMIN nav (and the pages are
    // guarded to GIFSY_ADMIN via admin/payouts/layout.tsx). MIS dropped from the backend too.
    href: '/admin/payouts',
    label: 'Payout Management',
    icon: CreditCard,
    featureFlag: 'walletModule' as const,
    gifsyOnly: true,
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
  {
    href: '/admin/tds',
    label: 'TDS & Invoicing',
    icon: Landmark,
    featureFlag: null,
    children: [
      // List more-specific paths before '/admin/tds' so the header-title resolver
      // (startsWith(child.href + '/')) resolves each page correctly.
      { href: '/admin/tds-config',         label: 'TDS Treatment'       }, // section+methodology; tenant read-only
      { href: '/admin/tds-payouts',        label: 'Payout Report'       }, // role-scoped (own tenant for CLIENT_ADMIN)
      { href: '/admin/tds-recovery',       label: 'Recovery / Attribution' }, // role-scoped (own recovery liability)
      { href: '/admin/tds-rcm',            label: 'RCM (Unregistered)', gifsyOnly: true },
      { href: '/admin/gst-reimbursements', label: 'GST Reimbursements', gifsyOnly: true },
      { href: '/admin/tds',                label: 'TDS Ledger (194R/194C)' }, // existing 194R/194C compute+export
    ],
  },
  { href: '/admin/tickets',  label: 'Tickets',          icon: TicketCheck,   featureFlag: null },
  { href: '/admin/banners',  label: 'Banners',          icon: Megaphone,     featureFlag: null },
  { href: '/admin/reports',  label: 'Reports',          icon: FileBarChart2, featureFlag: null },
  { href: '/admin/app-adoption', label: 'App Adoption', icon: Smartphone,    featureFlag: null },
  // Help & Guides — internal operating guides for the Gifsy ops team. gifsyOnly: shown to
  // GIFSY_ADMIN + GIFSY_STAFF (canManageSchemes), hidden from CLIENT_ADMIN / MIS_USER; the
  // pages are also role-guarded via admin/guides/layout.tsx.
  { href: '/admin/guides', label: 'Help & Guides', icon: BookOpen, featureFlag: null, gifsyOnly: true },
  { href: '/admin/settings', label: 'Settings',         icon: Settings,      featureFlag: null },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname     = usePathname();
  const router       = useRouter();
  const clientConfig = useClientConfig();
  // Feature gating is DB-sourced via the authenticated tenant-config endpoint
  // (§A-DOMAIN "P5"), NOT the in-code registry. Branding still comes from clientConfig.
  const { features } = useTenantFeatures('/api/admin/settings/config');
  const adminSession = useAdminSession();
  // Master Visibility switch (per-tenant, default OFF). Lives in GifsySettings, NOT ClientConfig
  // features — so it is gated here directly rather than via the featureFlag map below.
  const visibilityEnabled = useGifsySettings().visibilityEnabled === true;

  // RBAC Option-X (P5 UI/UX audit M2): a GIFSY_STAFF reaches the admin shell ONLY while assumed
  // into a granted brand. An un-assumed staff who lands on /admin/* has no coherent state here
  // (owner nav they can't use, backend-403'd widgets) → bounce them to their /gifsy launchpad.
  // `assumed` is optimistic (localStorage hint) then reconciled to server truth, so an actually-
  // assumed staff is never bounced. Non-staff roles are unaffected.
  const { assumed } = useAssumedContext();
  useEffect(() => {
    if (getStoredUser()?.role === 'GIFSY_STAFF' && !assumed) {
      router.replace('/gifsy');
    }
  }, [assumed, router]);

  function handleLogout() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('admin_role_demo');
    }
    logout(); // clears token + user, redirects to /auth/login
  }
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Filter nav items by feature flags AND role
  const navItems = useMemo(
    () =>
      ALL_NAV_ITEMS.filter((item) => {
        // gifsyOnly items (e.g. Scheme Management) are hidden from CLIENT_ADMIN
        if ((item as { gifsyOnly?: boolean }).gifsyOnly && !adminSession.canManageSchemes) return false;
        // tenantReportOnly items (Scheme Reports) are hidden from GIFSY_ADMIN, who
        // gets the full management + report surface under Scheme Management instead.
        if ((item as { tenantReportOnly?: boolean }).tenantReportOnly && adminSession.canManageSchemes) return false;
        // Master Visibility switch gates the Visibility Approval page AND (ANDed with its own
        // featureFlag) the Visibility Invoices group — both hidden when Visibility is OFF.
        if (item.href === '/admin/visibility') return visibilityEnabled;
        if (item.href === '/admin/visibility-reports') return visibilityEnabled;
        if (item.href === '/admin/invoices' && !visibilityEnabled) return false;
        if (!item.featureFlag) return true;
        return !!(features as unknown as Record<string, boolean>)[item.featureFlag];
      }),
    [features, adminSession.canManageSchemes, visibilityEnabled],
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
    <div className="flex flex-col h-screen bg-gray-50 overflow-hidden print:h-auto print:overflow-visible print:block">
      {/* Operator-context banner — shown when a GIFSY operator is working in a brand (A2/#51) */}
      <div className="print:hidden">
        <OperatorBanner />
      </div>
      <div className="flex flex-1 min-h-0 overflow-hidden print:overflow-visible print:min-h-0 print:block">
      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-[#1A1A2E] text-slate-200 transition-all duration-300 ${
          collapsed ? 'w-16' : 'w-64'
        } flex-shrink-0 print:hidden`}
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
                  {adminRoleLabel(adminSession.role)}
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
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden print:overflow-visible print:block">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0 z-10 print:hidden">
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
            {/* Notifications hidden until P7 notification worker (#21) */}

            {/* User menu */}
            <div className="relative">
              <button
                onClick={() => { setUserMenuOpen(!userMenuOpen); }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="w-7 h-7 rounded-full bg-[var(--brand-primary)] flex items-center justify-center text-white text-xs font-bold">
                  {adminSession.name
                    .split(' ')
                    .map((w) => w[0])
                    .filter(Boolean)
                    .slice(0, 2)
                    .join('')
                    .toUpperCase() || 'A'}
                </div>
                <div className="text-left hidden sm:block">
                  <div className="text-xs font-semibold text-gray-800">{adminSession.name}</div>
                  <div className="text-xs text-gray-500">
                    {adminRoleLabel(adminSession.role)}
                  </div>
                </div>
                <ChevronDown className="w-3 h-3 text-gray-400" />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-11 w-44 bg-white rounded-xl shadow-lg border border-gray-200 z-50 py-1">
                  <a href="#" className="block px-4 py-2 text-xs text-gray-700 hover:bg-gray-50">Profile Settings</a>
                  <a href="#" className="block px-4 py-2 text-xs text-gray-700 hover:bg-gray-50">Change Password</a>
                  <hr className="my-1 border-gray-100" />
                  <button onClick={handleLogout} className="block w-full text-left px-4 py-2 text-xs text-red-600 hover:bg-red-50">Sign Out</button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6 print:overflow-visible print:p-0">
          <RequireAuth allowedRoles={PORTAL_ROLES.admin}>
            {/* RBAC Option-X P6: a GIFSY_STAFF landing on a route their role lacks sees a
                clear AccessDenied message instead of a raw 403. INERT for every other role. */}
            <AdminRouteGuard>{children}</AdminRouteGuard>
          </RequireAuth>
          <SiteFooter />
        </main>
      </div>
      </div>
    </div>
  );
}
