'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid, Users, Settings, Building2,
  ChevronRight, LogOut, Globe, ShoppingBag,
} from 'lucide-react';

const NAV = [
  { href: '/gifsy',               label: 'Overview',       icon: LayoutGrid  },
  { href: '/gifsy/clients',       label: 'Clients',        icon: Building2   },
  { href: '/gifsy/outlet-types',  label: 'Outlet Types',   icon: ShoppingBag },
  { href: '/gifsy/users',         label: 'Platform Users', icon: Users       },
  { href: '/gifsy/settings',      label: 'Settings',       icon: Settings    },
];

export default function GifsyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen flex bg-gray-950 text-white">

      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-white/10">
        {/* Logo */}
        <div className="px-5 py-5 flex items-center gap-2.5 border-b border-white/10">
          <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center font-bold text-sm">G</div>
          <div>
            <p className="text-sm font-bold leading-none">Gifsy</p>
            <p className="text-[10px] text-white/40 mt-0.5">Platform Admin</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
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
        <div className="px-3 py-4 border-t border-white/10 space-y-0.5">
          <Link href="/" target="_blank"
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/40 hover:text-white hover:bg-white/5 transition-colors">
            <Globe className="w-4 h-4" />
            Platform Home
          </Link>
          <button className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-950">
        <div className="max-w-6xl mx-auto px-6 py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
