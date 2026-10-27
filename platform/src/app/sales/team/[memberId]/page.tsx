'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Spinner } from '@/components/ui/spinner';
import { TeamViewScreen } from '@/components/sales/team-view-screen';

/** Drill-down Team view — the SAME redesigned screen, for the given member's team. */
export default function MemberTeamPage() {
  const params = useParams<{ memberId: string }>();
  const memberId = Array.isArray(params.memberId) ? params.memberId[0] : params.memberId;
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>}>
      <TeamViewScreen memberId={memberId} />
    </Suspense>
  );
}
