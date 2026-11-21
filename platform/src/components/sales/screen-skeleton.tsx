/**
 * Lightweight route skeletons for the sales app's loading.tsx files (request-volume work, audit fix 4).
 *
 * Every bottom-nav / menu route is DYNAMIC, so Next prefetches only "layout to first loading boundary"
 * (node_modules/next/dist/docs/01-app/02-guides/prefetching.md). With a loading.tsx per route, the once-per-session
 * nav prefetch caches THIS shell, so a tab tap paints the skeleton instantly (header + bottom nav stay put) and the
 * page replaces it when it arrives. Pure markup — no data, no client JS.
 */
export type ScreenSkeletonVariant = 'dashboard' | 'list' | 'cards' | 'form' | 'profile' | 'ledger';

function Bar({ className }: { className: string }) {
  return <div className={`rounded bg-gray-200 ${className}`} />;
}

function Row() {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="h-9 w-9 rounded-full bg-gray-200 shrink-0" />
      <div className="flex-1 space-y-2">
        <Bar className="h-3.5 w-2/3" />
        <Bar className="h-3 w-1/3 bg-gray-100" />
      </div>
      <Bar className="h-5 w-14 rounded-full" />
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">{children}</div>;
}

export function ScreenSkeleton({ variant, label }: { variant: ScreenSkeletonVariant; label: string }) {
  return (
    <div className="space-y-4 animate-pulse" role="status" aria-label={`Loading ${label}`} data-testid={`screen-skeleton-${variant}`}>
      <Bar className="h-5 w-1/3" />
      {variant === 'dashboard' && (
        <>
          <Card><Bar className="h-3 w-1/4" /><Bar className="h-2 w-full rounded-full bg-gray-100" /><Bar className="h-2 w-4/5 rounded-full bg-gray-100" /></Card>
          <div className="grid grid-cols-2 gap-3"><div className="h-20 rounded-xl bg-gray-100" /><div className="h-20 rounded-xl bg-gray-100" /></div>
          <Card><Bar className="h-3 w-1/3" /><div className="h-32 rounded-lg bg-gray-100" /></Card>
        </>
      )}
      {variant === 'list' && (
        <>
          <div className="h-10 rounded-xl bg-gray-100" />
          <div className="rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
            <Row /><Row /><Row /><Row /><Row />
          </div>
        </>
      )}
      {variant === 'cards' && (
        <>
          <Card><Bar className="h-3.5 w-1/2" /><Bar className="h-3 w-1/3 bg-gray-100" /></Card>
          <Card><Bar className="h-3.5 w-2/3" /><Bar className="h-3 w-1/4 bg-gray-100" /></Card>
          <Card><Bar className="h-3.5 w-1/2" /><Bar className="h-3 w-1/3 bg-gray-100" /></Card>
        </>
      )}
      {variant === 'form' && (
        <Card>
          <Bar className="h-3 w-1/4" /><div className="h-10 rounded-lg bg-gray-100" />
          <Bar className="h-3 w-1/3" /><div className="h-10 rounded-lg bg-gray-100" />
          <Bar className="h-3 w-1/4" /><div className="h-24 rounded-lg bg-gray-100" />
        </Card>
      )}
      {variant === 'profile' && (
        <>
          <div className="flex items-center gap-3"><div className="h-14 w-14 rounded-full bg-gray-200" /><div className="flex-1 space-y-2"><Bar className="h-4 w-1/2" /><Bar className="h-3 w-1/3 bg-gray-100" /></div></div>
          <div className="grid grid-cols-2 gap-3"><div className="h-16 rounded-xl bg-gray-100" /><div className="h-16 rounded-xl bg-gray-100" /></div>
          <Card><Bar className="h-3 w-1/3" /><Bar className="h-3 w-2/3 bg-gray-100" /><Bar className="h-3 w-1/2 bg-gray-100" /></Card>
        </>
      )}
      {variant === 'ledger' && (
        <>
          <div className="grid grid-cols-2 gap-3"><div className="h-20 rounded-xl bg-gray-100" /><div className="h-20 rounded-xl bg-gray-100" /></div>
          <div className="rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
            <Row /><Row /><Row /><Row />
          </div>
        </>
      )}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
