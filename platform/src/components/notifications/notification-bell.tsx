/* ─── NotificationBell — shared bell + feed panel (Phase 1) ────────────────────
   The bell icon + unread badge, plus the feed panel that opens on click:
     - desktop → an anchored dropdown,
     - mobile  → a bottom-sheet (reusing the partner shell's existing look).
   Both render the SAME feed body (skeleton / empty / error / list) so the two
   shells stay visually consistent. Clicking an item marks it read then navigates
   to item.url (falling back to `fallbackUrl` when the item carries no link).

   `tone` adapts only the trigger button to its header background:
     - 'light' → the white partner header (grey icon),
     - 'dark'  → the navy sales header (white icon).
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, X, Check } from 'lucide-react';
import { useNotifications, type NotificationItem } from '@/lib/notifications/use-notifications';
import { formatRelativeTime } from '@/lib/utils';

interface NotificationBellProps {
  /** Trigger styling for the header it sits in. */
  tone?: 'light' | 'dark';
  /** Where an item with no `url` navigates to. */
  fallbackUrl: string;
}

export function NotificationBell({ tone = 'light', fallbackUrl }: NotificationBellProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    unreadCount, items, loading, loadingMore, error, hasMore,
    openFeed, loadMore, retry, markRead, markAllRead,
  } = useNotifications();

  // Refresh the feed every time the panel opens (page 1 is re-fetched inside the
  // hook, so newly-arrived notifications always appear on re-open).
  useEffect(() => {
    if (open) openFeed();
  }, [open, openFeed]);

  // ── Focus management (a11y): move focus into the panel on open, restore it to
  // the bell on close. Two dialogs are always rendered (desktop + mobile) but
  // only one is visible; focus the visible one's close control (offsetParent is
  // null for a display:none element). ──
  const bellRef = useRef<HTMLButtonElement>(null);
  const desktopCloseRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const target = [desktopCloseRef.current, mobileCloseRef.current].find(
        (el) => el && el.offsetParent !== null,
      );
      target?.focus();
    } else if (!open && wasOpen.current) {
      bellRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const badge = unreadCount > 9 ? '9+' : String(unreadCount);
  const triggerLabel = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  // Same-portal guard: an item's server-supplied url must stay inside THIS bell's
  // portal (derived from fallbackUrl, e.g. /partner/… or /sales/…), else a
  // cross-portal push lands on a RequireAuth block. Fall back when it doesn't.
  const portalPrefix = `/${fallbackUrl.split('/').filter(Boolean)[0] ?? ''}`;
  const samePortal = (url: string) =>
    url === portalPrefix || url.startsWith(`${portalPrefix}/`);

  const handleItemClick = (n: NotificationItem) => {
    void markRead(n.id); // always mark read, even when we fall back
    setOpen(false);
    const target = n.url && n.url.trim() ? n.url : fallbackUrl;
    router.push(samePortal(target) ? target : fallbackUrl);
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const triggerClasses =
    tone === 'dark'
      ? 'p-2 rounded-full hover:bg-white/10 text-white transition-colors relative'
      : 'p-2 rounded-full hover:bg-gray-100 text-gray-500 transition-colors relative';

  /* ── shared feed body ──────────────────────────────────────────────────────*/
  const feedBody = (
    <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-50">
      {loading ? (
        <FeedSkeleton />
      ) : error ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-gray-500">Couldn&apos;t load notifications.</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 text-sm font-medium text-[var(--brand-primary)] hover:underline"
          >
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
            <Bell className="h-5 w-5 text-gray-400" />
          </div>
          <p className="mt-3 text-sm text-gray-500">No notifications yet</p>
        </div>
      ) : (
        <>
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => handleItemClick(n)}
              className={`w-full flex items-start gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors ${
                n.readAt ? '' : 'bg-[var(--brand-primary)]/5'
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                  n.readAt ? 'bg-transparent' : 'bg-[var(--brand-primary)]'
                }`}
              />
              {!n.readAt && <span className="sr-only">Unread. </span>}
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-gray-900 truncate">{n.subject}</span>
                {n.body && (
                  <span className="block text-xs text-gray-500 mt-0.5 leading-relaxed line-clamp-2">
                    {n.body}
                  </span>
                )}
                <span className="block text-xs text-gray-400 mt-1">{formatRelativeTime(n.createdAt)}</span>
              </span>
            </button>
          ))}
          {hasMore && (
            <div className="px-5 py-3">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full text-sm font-medium text-[var(--brand-primary)] hover:underline disabled:opacity-60"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderHeader = (closeRef: React.RefObject<HTMLButtonElement | null>) => (
    <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
      <h3 className="text-base font-semibold text-gray-900">Notifications</h3>
      <div className="flex items-center gap-1">
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-[var(--brand-primary)] hover:bg-gray-100"
          >
            <Check className="h-3.5 w-3.5" />
            Mark all read
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close notifications"
          className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={triggerClasses}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.05rem] h-[1.05rem] px-1 flex items-center justify-center rounded-full bg-[var(--brand-primary)] text-white text-[10px] font-bold leading-none">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Desktop — anchored dropdown */}
          <div className="hidden sm:block">
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Notifications"
              onKeyDown={onPanelKeyDown}
              className="absolute right-0 mt-2 w-80 max-h-[70vh] flex flex-col bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden"
            >
              {renderHeader(desktopCloseRef)}
              {feedBody}
            </div>
          </div>

          {/* Mobile — bottom-sheet (matches the partner shell's existing look) */}
          <div className="sm:hidden">
            <div className="fixed inset-0 z-50 flex flex-col justify-end">
              <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Notifications"
                onKeyDown={onPanelKeyDown}
                className="relative bg-white rounded-t-2xl max-h-[75vh] flex flex-col"
              >
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 bg-gray-200 rounded-full" />
                </div>
                {renderHeader(mobileCloseRef)}
                {feedBody}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="divide-y divide-gray-50" aria-hidden="true" data-testid="notif-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3 px-5 py-4">
          <div className="mt-1 w-2 h-2 rounded-full bg-gray-200" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/2 bg-gray-200 rounded" />
            <div className="h-2.5 w-3/4 bg-gray-100 rounded" />
            <div className="h-2.5 w-1/4 bg-gray-100 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
