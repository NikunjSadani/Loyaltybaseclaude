'use client';

/**
 * Count badge on the "Downloads" nav item (M6): files that are Ready and that this person has not yet
 * seen on the Downloads page or downloaded. Uses the existing list API (first page) — no new endpoint.
 *
 * Re-counts on mount, on every page change, whenever a report is queued / the Downloads page changes
 * something (DOWNLOADS_CHANGED_EVENT), and every 30 s while something is still being prepared (so a file
 * that finishes while the person works elsewhere lights the badge). A failed count just hides the badge —
 * the Downloads page itself is where errors are shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { fetchExportList } from '@/lib/exports/download';
import { countUnseenReady, DOWNLOADS_CHANGED_EVENT, readSeen } from '@/lib/exports/seen';
import { useDownloadsScope } from '@/components/exports/use-downloads-scope';

export const DOWNLOADS_BADGE_POLL_MS = 30_000;

export function useUnseenDownloadsCount(seenKey: string): number {
  const [count, setCount] = useState(0);
  const [hasActive, setHasActive] = useState(false);
  const itemsRef = useRef<Awaited<ReturnType<typeof fetchExportList>> | null>(null);
  const pathname = usePathname();

  const recount = useCallback(() => {
    const res = itemsRef.current;
    if (!res || !res.ok) { setCount(0); return; }
    setCount(countUnseenReady(res.data.items, readSeen(seenKey)));
  }, [seenKey]);

  const load = useCallback(async () => {
    // Every badge count is automatic (mount / page change / event / poll) → background: never counts as activity.
    const res = await fetchExportList(null, { background: true });
    itemsRef.current = res;
    setHasActive(res.ok && res.data.items.some((i) => i.status === 'QUEUED' || i.status === 'RUNNING'));
    recount();
  }, [recount]);

  useEffect(() => { void load(); }, [load, pathname]);

  useEffect(() => {
    const onChange = () => { void load(); };
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DOWNLOADS_CHANGED_EVENT, onChange);
  }, [load]);

  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load();
    }, DOWNLOADS_BADGE_POLL_MS);
    return () => clearInterval(id);
  }, [hasActive, load]);

  return count;
}

export function DownloadsNavBadge({ collapsed = false, tone = 'admin' }: { collapsed?: boolean; tone?: 'admin' | 'gifsy' }) {
  const { seenKey } = useDownloadsScope();
  const count = useUnseenDownloadsCount(seenKey);
  if (count <= 0) return null;
  const label = `${count} new ${count === 1 ? 'file' : 'files'} ready`;
  const pill = tone === 'gifsy' ? 'bg-emerald-500 text-white' : 'bg-emerald-500 text-white';
  if (collapsed) {
    return (
      <span
        data-testid="downloads-nav-badge"
        className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full ${pill}`}
        aria-label={label}
        role="status"
      />
    );
  }
  return (
    <span
      data-testid="downloads-nav-badge"
      className={`ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-[10px] font-bold ${pill}`}
      aria-label={label}
      title={label}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
