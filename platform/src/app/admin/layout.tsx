'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useMemo, useEffect } from 'react';
import {
  ChevronLeft, ChevronRight, LogOut, ChevronDown, Wallet, Building2,
} from 'lucide-react';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { useTenantFeatures } from '@/lib/tenant-features';
import { selectAdminNav } from '@/lib/admin-nav';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { useAdminSession, adminRoleLabel } from '@/lib/admin-session';
import { RequireAuth } from '@/components/auth/require-auth';
import { logout, PORTAL_ROLES, getStoredUser } from '@/lib/auth-client';
import { useAssumedContext } from '@/lib/use-assumed-context';
import { OperatorBanner } from '@/components/operator/operator-banner';
import { SiteFooter } from '@/components/layout/site-footer';
import { AdminRouteGuard } from '@/components/rbac/admin-route-guard';


export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname     = usePathname();
  const router       = useRouter();
  const clientConfig = useClientConfig();
  // Feature gating is DB-sourced via the authenticated tenant-config endpoint
  // (§A-DOMAIN "P5"), NOT the in-code registry. Branding still comes from clientConfig.
  const { features, capabilities } = useTenantFeatures('/api/admin/settings/config');
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
  // Employee Rewards: the admin shell is now capability-gated. `selectAdminNav` picks the
  // world's nav tree by the tenant's resolved earnerModel (OUTLET → the trade tree, byte-
  // identical to before; EMPLOYEE → the employee cockpit), then applies the same role/feature/
  // visibility gates. Pure + unit-tested in lib/__tests__/admin-nav.test.ts.
  const navItems = useMemo(
    () =>
      selectAdminNav({
        capabilities,
        role: adminSession.role,
        canManageSchemes: adminSession.canManageSchemes,
        visibilityEnabled,
        features: features as unknown as Record<string, boolean>,
      }),
    [capabilities, features, adminSession.canManageSchemes, adminSession.role, visibilityEnabled],
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
                timeZone: 'Asia/Kolkata',
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
