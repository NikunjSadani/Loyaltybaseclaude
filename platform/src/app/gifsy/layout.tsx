'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid, Users, Settings, Building2,
  LogOut, Globe, ShoppingBag,
  ShieldCheck, UserCog, Landmark,
} from 'lucide-react';
import { RequireAuth } from '@/components/auth/require-auth';
import { logout, PORTAL_ROLES, getStoredUser } from '@/lib/auth-client';
import { BrandSwitcher } from '@/components/operator/brand-switcher';
import { OperatorBanner } from '@/components/operator/operator-banner';

const NAV = [
  { href: '/gifsy',               label: 'Overview',       icon: LayoutGrid  },
  { href: '/gifsy/clients',       label: 'Clients',        icon: Building2   },
  { href: '/gifsy/outlet-types',  label: 'Outlet Types',   icon: ShoppingBag },
  { href: '/gifsy/users',         label: 'Platform Users', icon: Users       },
  { href: '/gifsy/roles',         label: 'Roles',          icon: ShieldCheck },
  { href: '/gifsy/staff',         label: 'Staff',          icon: UserCog     },
  { href: '/gifsy/tds-statutory', label: 'TDS Statutory',  icon: Landmark    },
  { href: '/gifsy/settings',      label: 'Settings',       icon: Settings    },
];

/**
 * The GIFSY_STAFF launchpad: a limited operator has no all-brands view — their entire
 * /gifsy surface is picking one granted brand to assume. The <BrandSwitcher panel>
 * renders the single / multiple / zero-brand cases.
 */
function StaffLaunchpad() {
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Choose a brand</h1>
        <p className="text-sm text-white/50 mt-0.5">
          Pick one of your assigned brands to start working in it.
        </p>
      </div>
      <BrandSwitcher variant="panel" />
    </div>
  );
}

export default function GifsyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Auth is an httpOnly cookie (AF-6); the NON-sensitive stored user carries the role.
  // Resolve it client-side (with a ready gate) so a GIFSY_STAFF never briefly mounts the
  // owner-only children before the launchpad swaps in.
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRole(getStoredUser()?.role ?? null);
    setReady(true);
  }, []);
  const isStaff = role === 'GIFSY_STAFF';

  // Staff get NONE of the owner-only console nav — their only action here is picking a
  // brand to assume. The owner (GIFSY_ADMIN) keeps the full nav unchanged.
  const nav = isStaff ? [] : NAV;

  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-white">
      <OperatorBanner />
      <div className="flex flex-1 min-h-0">

      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-white/10">
        {/* Logo */}
        <div className="px-5 py-5 flex items-center gap-2.5 border-b border-white/10">
          <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center font-bold text-sm">G</div>
          <div>
            <p className="text-sm font-bold leading-none">Gifsy</p>
            <p className="text-[10px] text-white/40 mt-0.5">{isStaff ? 'Staff Console' : 'Platform Admin'}</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === '/gifsy'
              ? pathname === '/gifsy'
              : pathname.startsWith(href);
            return (
              <Link key={href} href={href}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  active
                    ? 'bg-white/10 text-white font-medium'
                    : 'text-white/50 hover:text-white hover:bg-white/5'
                }`}>
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-white/10 space-y-2">
          {/* Operator-context switcher — "Work in brand ▾" (A2/#51). Owner only: a staff
              uses the launchpad panel in the main area, so the footer menu is redundant. */}
          {!isStaff && <BrandSwitcher />}
          {!isStaff && (
            <Link href="/" target="_blank"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/40 hover:text-white hover:bg-white/5 transition-colors">
              <Globe className="w-4 h-4" />
              Platform Home
            </Link>
          )}
          <button onClick={logout} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-950">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <RequireAuth allowedRoles={PORTAL_ROLES.gifsy}>
            {/* A GIFSY_STAFF only ever sees the brand-picker launchpad in /gifsy — never
                the owner-only console pages (which 403 for them anyway). Gate on `ready`
                so the owner children are not transiently mounted for a staff. */}
            {!ready ? null : isStaff ? <StaffLaunchpad /> : children}
          </RequireAuth>
        </div>
      </main>
      </div>
    </div>
  );
}
