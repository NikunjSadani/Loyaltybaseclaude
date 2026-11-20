/**
 * Outlet (KYC) detail skeleton — shown by app/sales/kyc/[id]/loading.tsx while the route streams in after a tap
 * (outlet links are not prefetched — request-volume work, 2026-11-21), and by the page itself while its KYC record
 * loads, so the user sees ONE continuous skeleton from tap to content instead of a blank wait.
 */
export function OutletDetailSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" role="status" aria-label="Loading outlet" data-testid="outlet-detail-skeleton">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-gray-200" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 rounded bg-gray-200" />
          <div className="h-3 w-1/3 rounded bg-gray-100" />
        </div>
        <div className="h-6 w-20 rounded-full bg-gray-200" />
      </div>
      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="h-3 w-1/4 rounded bg-gray-200" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-10 rounded-lg bg-gray-100" />
          <div className="h-10 rounded-lg bg-gray-100" />
          <div className="h-10 rounded-lg bg-gray-100" />
          <div className="h-10 rounded-lg bg-gray-100" />
        </div>
      </div>
      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="h-3 w-1/3 rounded bg-gray-200" />
        <div className="h-2 w-full rounded-full bg-gray-100" />
        <div className="h-2 w-5/6 rounded-full bg-gray-100" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="h-14 rounded-xl bg-gray-100" />
        <div className="h-14 rounded-xl bg-gray-100" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
