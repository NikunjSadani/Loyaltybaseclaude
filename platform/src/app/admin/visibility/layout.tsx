import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Visibility (POSM) capture management is a GIFSY-OPERATOR capability
 * (VISIBILITY-POSM-DESIGN.md D4/D12) — config, form authoring, and the approve/reject
 * queue. Guarding the whole `/admin/visibility/**` subtree to GIFSY_ADMIN + GIFSY_STAFF
 * bounces a CLIENT_ADMIN / MIS_USER who navigates here directly to their own home
 * (getRoleHome) instead of loading the management surface, while an assumed GIFSY_STAFF is
 * admitted (was excluded → redirect LOOP). Defense-in-depth: the backend is
 * @Roles('GIFSY_ADMIN') + @RequirePermission('visibility:read'|'visibility:write'), so a
 * GIFSY_STAFF still needs the visibility permission to read/act.
 *
 * Tenant admins keep their read-only coverage surface at /admin/visibility-reports
 * (NOT under this tree and intentionally NOT guarded here).
 */
export default function VisibilityLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>;
}
