'use client';

import { use } from 'react';
import SchemeEnrollmentsView from '@/components/admin/SchemeEnrollmentsView';

// Tenant (CLIENT_ADMIN) read-only enrollments view — the SAME rich roster + detail
// drawer (captured values, media, geo, submission history, Excel export) as the GIFSY
// admin, but with every write affordance hidden. Lives under the general /admin layout
// (no restrictive layout); the backend hard-scopes the reads to this tenant.

export default function TenantEnrollmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);
  return <SchemeEnrollmentsView schemeId={schemeId} readOnly backHref="/admin/scheme-reports" />;
}
