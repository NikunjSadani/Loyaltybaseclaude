import { ScreenSkeleton } from '@/components/sales/screen-skeleton';

/** Instant shell for /sales/dashboard — see components/sales/screen-skeleton.tsx (request-volume work, audit fix 4). */
export default function Loading() {
  return <ScreenSkeleton variant="dashboard" label="dashboard" />;
}
