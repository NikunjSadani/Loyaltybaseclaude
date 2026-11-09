'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/admin/sales-import', label: 'Imports' },
  { href: '/admin/sales-import/months', label: 'Months' },
  { href: '/admin/sales-import/settings', label: 'Settings' },
];

/** Sub-navigation for Sales Import: Imports (upload + list + import detail), Months (close/reopen), Settings. */
export function SalesImportTabs() {
  const pathname = usePathname() ?? '';
  const active = (href: string) =>
    href === '/admin/sales-import'
      ? pathname === href || (pathname.startsWith(`${href}/`) && !TABS.slice(1).some((t) => pathname.startsWith(t.href)))
      : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav aria-label="Sales Import sections" className="flex gap-1 border-b border-gray-200 mb-5">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active(t.href) ? 'page' : undefined}
          className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
            active(t.href)
              ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
