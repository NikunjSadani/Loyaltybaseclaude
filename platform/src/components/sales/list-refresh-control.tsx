'use client';

import { RefreshCw } from 'lucide-react';

/**
 * Small "Updated 10:42 · ⟳" control for the sales lists (Outlets, Tasks). The roster is reused from a 60 s cache
 * (lib/cached-reads.ts); tapping this forces a fresh read so a rep never has to wonder whether the list is current.
 */
export function ListRefreshControl({
  updatedAt,
  refreshing,
  onRefresh,
}: {
  updatedAt: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const time = updatedAt
    ? updatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-label="Refresh list"
      data-testid="list-refresh"
      className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 disabled:opacity-60 shrink-0"
    >
      {time && <span aria-live="polite">{refreshing ? 'Updating…' : `Updated ${time}`}</span>}
      <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
    </button>
  );
}
