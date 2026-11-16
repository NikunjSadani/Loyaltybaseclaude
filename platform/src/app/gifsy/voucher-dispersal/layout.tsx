import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Voucher Dispersal is a GENERIC, PLATFORM-LEVEL Gifsy-owner tool (owner-approved 2026-11-16): it
 * buys Hubble vouchers and sends them on WhatsApp for any uploaded list. It is NOT a tenant feature,
 * so it lives in the /gifsy console (never under /admin, never dependent on an assumed tenant).
 * The backend is GIFSY_ADMIN-only; this guard matches it. The /gifsy shell already shows GIFSY_STAFF
 * only their brand launchpad, so this is defence-in-depth (mirrors admin/whatsapp-broadcasts/layout.tsx).
 */
export default function VoucherDispersalLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
