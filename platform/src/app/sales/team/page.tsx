'use client';

import { Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { TeamViewScreen } from '@/components/sales/team-view-screen';

/** Sales Team — redesigned filtered KPI-achievement view (root = the caller). */
export default function SalesTeamPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>}>
      <TeamViewScreen />
    </Suspense>
  );
}
