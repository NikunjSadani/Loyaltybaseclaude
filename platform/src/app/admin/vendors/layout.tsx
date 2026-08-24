'use client';

/**
 * /admin/vendors — Gifsy vendor management (GIFSY_ADMIN only).
 *
 * Gate: GIFSY_ADMIN only — matches the single `gifsyAdminOnly` nav entry in
 * admin/layout.tsx so nav visibility and this route guard agree (no shown-but-blocked
 * gap), and hidden from GIFSY_STAFF too. Mirrors admin/whatsapp-broadcasts/layout.tsx
 * and admin/gift-catalogue/layout.tsx. The backend is the real enforcement; this is
 * defence-in-depth + a clean authz bounce for the wrong role (no flash-of-content:
 * RequireAuth renders null until the role check passes).
 */

import { RequireAuth } from '@/components/auth/require-auth';

export default function VendorsLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
