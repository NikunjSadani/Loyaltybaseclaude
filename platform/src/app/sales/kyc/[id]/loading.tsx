import { OutletDetailSkeleton } from '@/components/sales/outlet-detail-skeleton';

/**
 * Instant loading state for the outlet (KYC) detail. Outlet links are no longer prefetched (request-volume work,
 * 2026-11-21), so this skeleton covers the tap → route-response → page-chunk gap; the page keeps the same skeleton
 * while its own data loads. See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md.
 */
export default function Loading() {
  return <OutletDetailSkeleton />;
}
