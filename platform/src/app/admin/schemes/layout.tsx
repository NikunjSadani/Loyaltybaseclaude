import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Scheme management is a GIFSY-only platform capability (admin-session
 * `canManageSchemes` → GIFSY_ADMIN). Guarding the whole `/admin/schemes/**` subtree to
 * GIFSY_ADMIN means a CLIENT_ADMIN / MIS_USER who navigates here directly is bounced to
 * their own home (getRoleHome → /admin/dashboard) instead of loading the management +
 * broadcast + enrollment surfaces. Defense-in-depth: pairs with the sidebar nav being
 * hidden (gifsyOnly) and the backend scheme-management / enrollment / report / export
 * endpoints already being narrowed to GIFSY_ADMIN.
 *
 * Tenant admins keep their read-only coverage surface at /admin/scheme-reports (which is
 * NOT under this tree and intentionally NOT guarded here).
 */
export default function SchemesLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
