import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Scheme management is a GIFSY-OPERATOR capability (admin-session `canManageSchemes` →
 * GIFSY_ADMIN + GIFSY_STAFF). Guarding the whole `/admin/schemes/**` subtree to those two
 * roles means a CLIENT_ADMIN / MIS_USER who navigates here directly is bounced to their own
 * home (getRoleHome → /admin/dashboard) instead of loading the management + broadcast +
 * enrollment surfaces — while an assumed GIFSY_STAFF is admitted (was previously excluded,
 * causing a shown-but-blocked redirect LOOP: nav shows the link via canManageSchemes but the
 * page rejected staff → getRoleHome → /gifsy → back into /admin → …). Defense-in-depth: the
 * backend scheme endpoints are @Roles('GIFSY_ADMIN') + @RequirePermission('schemes:*'), so a
 * GIFSY_STAFF still needs the scheme permission on their assigned role to act.
 *
 * Tenant admins keep their read-only coverage surface at /admin/scheme-reports (which is
 * NOT under this tree and intentionally NOT guarded here).
 */
export default function SchemesLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>;
}
