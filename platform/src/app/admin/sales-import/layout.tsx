import { RequireAuth } from '@/components/auth/require-auth';
import { SalesImportFeatureGate } from './_components/sales-import-feature-gate';
import { SalesImportTabs } from './_components/sales-import-tabs';

/**
 * Route guard for /admin/sales-import (SALES-IMPORT-PIPELINE-PLAN §11 F-2) — GIFSY_ADMIN (assumed into a tenant),
 * GIFSY_STAFF (assumed into a granted tenant; targets:read to open, targets:upload to act) and CLIENT_ADMIN, AND the
 * tenant feature `salesImport` (default OFF). Matches the nav gate in admin/layout.tsx so nav visibility and
 * direct-URL access agree. The backend independently enforces role, permission (targets:*), the assumed-tenant rule
 * and the flag (uncached on writes). Month reopen stays GIFSY_ADMIN-only.
 */
export default function SalesImportLayout({ children }: { children: React.ReactNode }) {
  return (
    // GIFSY_STAFF (owner 2026-11-25 — e.g. Project Manager): admitted here; AdminRouteGuard checks its
    // targets:read via route-permissions, and the backend re-checks every action + the tenant grant.
    <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF', 'CLIENT_ADMIN']}>
      <SalesImportFeatureGate>
        <SalesImportTabs />
        {children}
      </SalesImportFeatureGate>
    </RequireAuth>
  );
}
