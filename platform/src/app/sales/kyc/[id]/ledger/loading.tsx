import { ScreenSkeleton } from '@/components/sales/screen-skeleton';

/** Instant shell for /sales/kyc/[id]/ledger — see components/sales/screen-skeleton.tsx (request-volume work, audit fix 4). */
export default function Loading() {
  return <ScreenSkeleton variant="ledger" label="outlet wallet" />;
}
