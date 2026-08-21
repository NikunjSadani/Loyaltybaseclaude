/* ─── In-app notification "bell feed" — shared client hook (Phase 1) ──────────
   One hook powers the bell in BOTH the partner and sales shells. It:
     - polls the unread COUNT every ~60s (cheap; drives the badge),
     - loads/refreshes the feed LIST page 1 on every panel open (so newly-arrived
       notifications always show), and pages further items via nextCursor,
     - marks one / all read with an OPTIMISTIC unread decrement (reverting on
       failure so the badge never lies), and
     - surfaces loading / error so the panel can show a skeleton / retry.

   Auth rides the httpOnly `token` cookie carried by the same-origin proxy, so we
   reuse the central `api` client (never hand-roll fetch/auth). Per the platform
   convention every backend response is the `{ success, data }` envelope, so the
   contract payloads below are the `data` field:
     GET  /api/notifications?cursor=&limit=25  → { items, nextCursor }
     GET  /api/notifications/unread-count       → { count }
     POST /api/notifications/:id/read           → { id, readAt }
     POST /api/notifications/read-all           → { updated }
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';

/** A single feed item, exactly as the backend returns it. */
export interface NotificationItem {
  id: string;
  subject: string;
  body: string;
  /** Deep-link target; may be empty — the bell falls back to a sensible route. */
  url: string;
  createdAt: string;
  /** ISO timestamp once read, else null. */
  readAt: string | null;
}

interface FeedPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

/** How often the unread badge re-polls, in ms. */
export const UNREAD_POLL_MS = 60_000;
/** Page size for the feed list. */
export const FEED_PAGE_SIZE = 25;

export interface UseNotifications {
  /** Unread count for the badge (poll-driven, optimistically adjusted). */
  unreadCount: number;
  /** Loaded feed items (grows as more pages load). */
  items: NotificationItem[];
  /** True while the FIRST feed page is loading (drives the skeleton). */
  loading: boolean;
  /** True while a load-more page is in flight. */
  loadingMore: boolean;
  /** True when the feed load FAILED and nothing is shown (drives the retry state). */
  error: boolean;
  /** True when a further page can be loaded. */
  hasMore: boolean;
  /** Load (or refresh) the first feed page. Called on every panel open so the
   *  list always reflects newly-arrived notifications; no-op while in-flight. */
  openFeed: () => void;
  /** Load the next page via nextCursor (no-op when none / already loading). */
  loadMore: () => void;
  /** Re-attempt the first feed page after an error. */
  retry: () => void;
  /** Mark ONE item read (optimistic; reverts on failure). */
  markRead: (id: string) => Promise<void>;
  /** Mark ALL read (optimistic; restores the prior list + count on failure). */
  markAllRead: () => Promise<void>;
}

export function useNotifications(): UseNotifications {
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Guards to keep effects/handlers honest across async gaps and unmount.
  const mounted = useRef(true);
  const inflightFeed = useRef(false);
  // Whether the feed has EVER loaded. A ref (not state) so `openFeed` keeps a
  // stable identity and the open-effect fires exactly once per open — while
  // still letting us skip the skeleton/error flash on a re-open refresh.
  const loadedOnceRef = useRef(false);
  // How many mark-read / mark-all POSTs are in flight. A 60s count poll must not
  // clobber an optimistic decrement mid-request, so it skips its write while > 0.
  const markInFlight = useRef(0);
  // Mirror of `items` for synchronous reads inside handlers — React may defer a
  // state updater, so we must NOT decide "was this unread?" from inside setItems.
  const itemsRef = useRef<NotificationItem[]>(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  // Mirror of `unreadCount` for a synchronous pre-optimistic snapshot.
  const unreadCountRef = useRef(unreadCount);
  useEffect(() => { unreadCountRef.current = unreadCount; }, [unreadCount]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /* ── unread-count polling ─────────────────────────────────────────────────
     Fetch immediately on mount, then every UNREAD_POLL_MS. A failed poll leaves
     the last known count untouched (a blip must never zero the badge). */
  const refreshCount = useCallback(async () => {
    const res = await api.get<{ count: number }>('/api/notifications/unread-count');
    // Skip the write if a mark-read/mark-all POST is in flight: its optimistic
    // decrement is authoritative until it resolves, and a stale poll value must
    // not transiently bump the badge back up.
    if (mounted.current && res.success && typeof res.data?.count === 'number' && markInFlight.current === 0) {
      setUnreadCount(Math.max(0, res.data.count));
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const id = setInterval(() => { void refreshCount(); }, UNREAD_POLL_MS);
    return () => clearInterval(id);
  }, [refreshCount]);

  /* ── feed loading (lazy + paged) ──────────────────────────────────────────*/
  const fetchPage = useCallback(async (cursor: string | null) => {
    const qs = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
    if (cursor) qs.set('cursor', cursor);
    return api.get<FeedPage>(`/api/notifications?${qs.toString()}`);
  }, []);

  // Load page 1. Used by BOTH the open handler and retry. On the first-ever load
  // we show the skeleton (and surface errors); on a subsequent refresh we keep
  // the existing list visible and swap it in when the fresh page arrives, so a
  // re-open never flashes a skeleton or drops the list on a transient failure.
  const loadFirstPage = useCallback(() => {
    if (inflightFeed.current) return;
    inflightFeed.current = true;
    const isRefresh = loadedOnceRef.current;
    if (!isRefresh) setLoading(true);
    setError(false);
    void fetchPage(null).then((res) => {
      inflightFeed.current = false;
      if (!mounted.current) return;
      setLoading(false);
      if (!res.success) {
        if (!isRefresh) setError(true); // keep the stale list on a refresh failure
        return;
      }
      setItems(res.data?.items ?? []);
      setNextCursor(res.data?.nextCursor ?? null); // reset paging to page 1
      loadedOnceRef.current = true;
    });
  }, [fetchPage]);

  // Refetch page 1 every time the panel opens so newly-arrived notifications
  // always appear (the badge is poll-driven, but the list is open-driven).
  const openFeed = loadFirstPage;
  const retry = loadFirstPage;

  const loadMore = useCallback(() => {
    if (!nextCursor || inflightFeed.current) return;
    inflightFeed.current = true;
    setLoadingMore(true);
    void fetchPage(nextCursor).then((res) => {
      inflightFeed.current = false;
      if (!mounted.current) return;
      setLoadingMore(false);
      if (!res.success) return; // keep what we have; the button stays available
      setItems((prev) => [...prev, ...(res.data?.items ?? [])]);
      setNextCursor(res.data?.nextCursor ?? null);
    });
  }, [nextCursor, fetchPage]);

  /* ── mark read (optimistic) ───────────────────────────────────────────────*/
  const markRead = useCallback(async (id: string) => {
    // Decide from the synchronous mirror, not from inside the (deferred) updater.
    const target = itemsRef.current.find((n) => n.id === id);
    const wasUnread = !!target && !target.readAt;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: now } : n)));
    if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));

    markInFlight.current += 1;
    try {
      const res = await api.post<{ id: string; readAt: string }>(`/api/notifications/${id}/read`, {});
      if (!res.success && wasUnread && mounted.current) {
        // Revert the optimistic change on failure so the UI never diverges.
        setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: null } : n)));
        setUnreadCount((c) => c + 1);
      }
    } finally {
      markInFlight.current -= 1;
    }
  }, []);

  const markAllRead = useCallback(async () => {
    // Snapshot BOTH the list and the count before the optimistic write so a
    // failure can restore the exact prior state (mirrors markRead's revert) —
    // never leave the list visually all-read while the badge reverts.
    const prevItems = itemsRef.current;
    const prevCount = unreadCountRef.current;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    setUnreadCount(0);

    markInFlight.current += 1;
    try {
      const res = await api.post<{ updated: number }>('/api/notifications/read-all', {});
      if (!res.success && mounted.current) {
        setItems(prevItems);
        setUnreadCount(prevCount);
      }
    } finally {
      markInFlight.current -= 1;
    }
  }, []);

  return {
    unreadCount,
    items,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    openFeed,
    loadMore,
    retry,
    markRead,
    markAllRead,
  };
}
