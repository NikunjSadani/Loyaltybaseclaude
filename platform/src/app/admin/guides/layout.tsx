import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Help & Guides is a Gifsy-operator resource (internal operating docs). Guarding the pages to
 * GIFSY_ADMIN + GIFSY_STAFF means a tenant admin (CLIENT_ADMIN / MIS_USER) who navigates here
 * directly is bounced to their own home rather than seeing the operator guides. Pairs with the
 * nav being hidden (gifsyOnly) in admin/layout.tsx. Mirrors admin/outlet-wallet/layout.tsx,
 * widened to include GIFSY_STAFF (limited operators read the same guides).
 */
export default function GuidesLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>;
}
