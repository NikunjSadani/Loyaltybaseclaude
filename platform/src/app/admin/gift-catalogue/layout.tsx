'use client';

/**
 * /admin/gift-catalogue — the platform Gift MASTER catalogue console (Gifsy-operator
 * only). Curate master items + the shared category taxonomy, publish + price masters
 * per tenant, and moderate vendor-submitted items (Wave-2).
 *
 * Gate: GIFSY_ADMIN only — matches the single gifsyAdminOnly nav entry in
 * admin/layout.tsx so nav visibility and this route guard agree (no shown-but-blocked
 * gap). Mirrors admin/whatsapp-broadcasts/layout.tsx. The backend is the real
 * enforcement; this is defence-in-depth + a clean authz bounce for the wrong role.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RequireAuth } from '@/components/auth/require-auth';

const TABS = [
  { href: '/admin/gift-catalogue', label: 'Gift Masters', exact: true },
  { href: '/admin/gift-catalogue/categories', label: 'Categories', exact: false },
  { href: '/admin/gift-catalogue/moderation', label: 'Moderation', exact: false },
];

export default function GiftCatalogueLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  return (
    <RequireAuth allowedRoles={['GIFSY_ADMIN']}>
      <div className="space-y-5">
        {/* Local tab bar — one nav line in the admin sidebar, sub-sections here. */}
        <nav className="flex items-center gap-1 border-b border-gray-200" aria-label="Gift catalogue sections">
          {TABS.map((t) => {
            const active = isActive(t.href, t.exact);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </RequireAuth>
  );
}
