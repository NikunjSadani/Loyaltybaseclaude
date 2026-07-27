import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Visibility (POSM) capture management is a GIFSY-only platform capability
 * (VISIBILITY-POSM-DESIGN.md D4/D12) — config, form authoring, and the approve/reject
 * queue are all GIFSY_ADMIN. Guarding the whole `/admin/visibility/**` subtree to
 * GIFSY_ADMIN bounces a CLIENT_ADMIN / MIS_USER who navigates here directly to their
 * own home (getRoleHome) instead of loading the management surface. Defense-in-depth:
 * pairs with the sidebar nav being gifsyOnly + the backend endpoints already narrowed
 * to GIFSY_ADMIN.
 *
 * Tenant admins keep their read-only coverage surface at /admin/visibility-reports
 * (NOT under this tree and intentionally NOT guarded here).
 */
export default function VisibilityLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
