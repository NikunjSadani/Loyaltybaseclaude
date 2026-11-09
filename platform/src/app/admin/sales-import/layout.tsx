import { RequireAuth } from '@/components/auth/require-auth';
import { SalesImportFeatureGate } from './_components/sales-import-feature-gate';
import { SalesImportTabs } from './_components/sales-import-tabs';

/**
 * Route guard for /admin/sales-import (SALES-IMPORT-PIPELINE-PLAN §11 F-2) — GIFSY_ADMIN (assumed into a tenant) +
 * CLIENT_ADMIN, AND the tenant feature `salesImport` (default OFF). Matches the nav gate in admin/layout.tsx so nav
 * visibility and direct-URL access agree. The backend independently enforces role, permission (targets:*), the
 * assumed-tenant rule and the flag (uncached on writes).
 */
export default function SalesImportLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN']}>
      <SalesImportFeatureGate>
        <SalesImportTabs />
        {children}
      </SalesImportFeatureGate>
    </RequireAuth>
  );
}
