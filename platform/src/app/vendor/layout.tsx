'use client';

/**
 * /vendor — the hard-scoped VENDOR portal shell (design §2).
 *
 * Gate: VENDOR only. The whole area is route-guarded with allowedRoles={['VENDOR']}
 * (defence-in-depth; the edge proxy + backend are the real enforcement + the data
 * boundary scopes every read/write by vendorId AND the grant's clientId). A non-VENDOR
 * role that lands here is bounced to its own home by RequireAuth.
 *
 * The shell fetches GET /api/vendor/me once for the header (vendor name · tenant ·
 * approval policy) and shares it with the pages via VendorMeProvider. A SUSPENDED
 * vendor — or any /me 403 (grant revoked mid-session) — renders a clear BLOCKED screen
 * instead of the portal (task: "a vendor whose account is suspended should see a clear
 * blocked state if any call 403s").
 *
 * Nav: Catalogue · Orders. Mirrors the partner shell (Sidebar + mobile bottom nav).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Package, Truck, Loader2, AlertTriangle, ShieldAlert, Building2, BadgeCheck,
} from 'lucide-react';
import { NavBottom } from '@/components/layout/nav-bottom';
import type { NavItem } from '@/components/layout/nav-bottom';
import { Sidebar } from '@/components/layout/sidebar';
import type { SidebarSection } from '@/components/layout/sidebar';
import { SiteFooter } from '@/components/layout/site-footer';
import { RequireAuth } from '@/components/auth/require-auth';
import { logout } from '@/lib/auth-client';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { api } from '@/lib/api-client';
import { VendorMeProvider } from '@/lib/vendor-context';
import { type VendorMe, approvalPolicyLabel, isBlockedError } from '@/lib/vendor';

const NAV: NavItem[] = [
  { href: '/vendor/catalogue', label: 'Catalogue', icon: Package },
  { href: '/vendor/orders', label: 'Orders', icon: Truck },
];

export default function VendorLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth allowedRoles={['VENDOR']}>
      <VendorShell>{children}</VendorShell>
    </RequireAuth>
  );
}

function VendorShell({ children }: { children: React.ReactNode }) {
  const clientConfig = useClientConfig();
  const [me, setMe] = useState<VendorMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBlocked(false);
    const res = await api.get<VendorMe>('/api/vendor/me');
    if (res.success) {
      if (res.data?.vendor?.status === 'SUSPENDED') {
        setMe(res.data);
        setBlocked(true);
      } else {
        setMe(res.data);
      }
    } else if (isBlockedError(res.error, res.status)) {
      setBlocked(true);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sidebarSections: SidebarSection[] = [{ items: NAV }];

  const handleLogout = () => { void logout(); };

  // ── Blocked (suspended vendor or revoked grant) ──────────────────────────────
  if (blocked) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-2xl p-8 text-center">
          <div className="p-3 bg-red-50 rounded-full inline-flex text-red-500 mb-4">
            <ShieldAlert className="w-7 h-7" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">Access unavailable</h1>
          <p className="text-sm text-gray-600 mt-2">
            {me?.vendor?.status === 'SUSPENDED'
              ? 'Your vendor account is currently suspended. While it is suspended you cannot manage your catalogue or orders.'
              : 'Your access to this vendor portal has been removed or is no longer active.'}
          </p>
          <p className="text-xs text-gray-400 mt-3">
            If you think this is a mistake, please contact your Gifsy account manager.
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <button
              onClick={() => void load()}
              className="px-4 py-2 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Try again
            </button>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-xs font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[#a50d26]"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <Sidebar
        sections={sidebarSections}
        onLogout={handleLogout}
        userName={me?.vendor?.name ?? 'Vendor'}
        userRole={me?.clientName ?? me?.clientId ?? ''}
        logoLabel={clientConfig.branding.displayName}
        wordmarkWhiteUrl={clientConfig.branding.wordmarkWhiteUrl}
      />

      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Top header — vendor name · tenant · approval policy */}
        <header className="sticky top-0 z-30">
          <div aria-hidden="true" style={{ height: 'env(safe-area-inset-top)', backgroundColor: 'var(--brand-primary)' }} />
          <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3 min-w-0">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 leading-tight truncate">
                {me?.vendor?.name ?? (loading ? 'Loading…' : 'Vendor portal')}
              </p>
              <p className="text-xs text-gray-400 leading-tight truncate flex items-center gap-1.5">
                <Building2 className="w-3 h-3 shrink-0" />
                {me?.clientName ?? me?.clientId ?? '—'}
              </p>
            </div>
            {me?.approvalPolicy && (
              <span
                className="hidden sm:inline-flex items-center gap-1.5 shrink-0 text-[11px] font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-full px-3 py-1"
                title="How your catalogue changes go live"
                data-testid="approval-policy-chip"
              >
                <BadgeCheck className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
                {approvalPolicyLabel(me.approvalPolicy)}
              </span>
            )}
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 pb-24 px-4 py-5 max-w-5xl mx-auto w-full">
          {loading ? (
            <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
              Loading your portal…
            </div>
          ) : error ? (
            <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
              <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
              <p className="text-red-700">{error}</p>
              <button
                onClick={() => void load()}
                className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Retry
              </button>
            </div>
          ) : (
            <VendorMeProvider value={me}>{children}</VendorMeProvider>
          )}
          <SiteFooter />
        </main>
      </div>

      {/* Bottom nav (mobile) */}
      <NavBottom items={NAV} />
    </div>
  );
}
