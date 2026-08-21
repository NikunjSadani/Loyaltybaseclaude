import { RequireAuth } from '@/components/auth/require-auth';

/**
 * WhatsApp Broadcasts is a Gifsy-owner console (bulk WhatsApp campaigns run against
 * the assumed tenant's audience). The backend is owner-only (GIFSY_ADMIN), so the
 * route guard matches: any other role (CLIENT_ADMIN / MIS_USER / GIFSY_STAFF) who
 * navigates here directly is bounced to their own home rather than hitting a wall of
 * 403s. The nav entry is gated to GIFSY_ADMIN too (gifsyAdminOnly in admin/layout.tsx)
 * so nav visibility and this guard agree — no "nav shown but URL blocked" (or the
 * reverse) gap. Mirrors admin/guides/layout.tsx.
 */
export default function WhatsappBroadcastsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
