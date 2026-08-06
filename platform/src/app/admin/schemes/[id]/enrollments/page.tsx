'use client';

import { use } from 'react';
import SchemeEnrollmentsView from '@/components/admin/SchemeEnrollmentsView';

// Thin wrapper — the GIFSY admin enrollments page. Full read+write behavior lives in
// the shared SchemeEnrollmentsView (readOnly defaults false → identical to before:
// reject / edit / delete / restore / show-deleted, plus the GIFSY-only getReport fetch).
// Guarded GIFSY-only by admin/schemes/layout.tsx.

export default function EnrollmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);
  return <SchemeEnrollmentsView schemeId={schemeId} backHref={`/admin/schemes/${schemeId}`} />;
}
