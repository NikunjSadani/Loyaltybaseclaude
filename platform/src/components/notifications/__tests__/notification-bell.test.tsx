/// <reference types="vitest/globals" />
/**
 * NotificationBell — the bell trigger + feed panel.
 *
 * The hook is mocked so each test drives an exact UI state (count / items /
 * loading / error); the hook's own behaviour is covered in
 * lib/notifications/__tests__/use-notifications.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UseNotifications, NotificationItem } from '@/lib/notifications/use-notifications';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

// Mutable hook state, reset per test.
let hookState: UseNotifications;
vi.mock('@/lib/notifications/use-notifications', () => ({
  useNotifications: () => hookState,
}));

import { NotificationBell } from '@/components/notifications/notification-bell';

function makeHook(overrides: Partial<UseNotifications> = {}): UseNotifications {
  return {
    unreadCount: 0,
    items: [],
    loading: false,
    loadingMore: false,
    error: false,
    hasMore: false,
    openFeed: vi.fn(),
    loadMore: vi.fn(),
    retry: vi.fn(),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function item(id: string, over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id, subject: `Subject ${id}`, body: `Body ${id}`, url: `/target/${id}`,
    createdAt: new Date().toISOString(), readAt: null, ...over,
  };
}

beforeEach(() => {
  push.mockClear();
  hookState = makeHook();
});

describe('NotificationBell — badge', () => {
  it('renders no badge when the unread count is zero', () => {
    hookState = makeHook({ unreadCount: 0 });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders the unread count on the badge', () => {
    hookState = makeHook({ unreadCount: 3 });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('caps the badge at "9+" for counts above nine', () => {
    hookState = makeHook({ unreadCount: 42 });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    expect(screen.getByText('9+')).toBeTruthy();
  });
});

describe('NotificationBell — panel states', () => {
  function openPanel() {
    // Regex: the trigger's accessible name now includes the unread count.
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
  }

  it('calls openFeed when the panel is opened', () => {
    const openFeed = vi.fn();
    hookState = makeHook({ openFeed });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    expect(openFeed).toHaveBeenCalled();
  });

  it('shows the empty state when there are no notifications', () => {
    hookState = makeHook({ items: [] });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    expect(screen.getAllByText('No notifications yet').length).toBeGreaterThan(0);
  });

  it('shows a loading skeleton while the first page loads', () => {
    hookState = makeHook({ loading: true });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    expect(screen.getAllByTestId('notif-skeleton').length).toBeGreaterThan(0);
  });

  it('shows an error state with a Retry that calls retry()', () => {
    const retry = vi.fn();
    hookState = makeHook({ error: true, retry });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    const retryBtn = screen.getAllByRole('button', { name: 'Retry' })[0];
    fireEvent.click(retryBtn);
    expect(retry).toHaveBeenCalled();
  });

  it('lists items with subject and relative time', () => {
    hookState = makeHook({ items: [item('a'), item('b')] });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    expect(screen.getAllByText('Subject a').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Subject b').length).toBeGreaterThan(0);
    expect(screen.getAllByText('just now').length).toBeGreaterThan(0);
  });
});

describe('NotificationBell — interactions', () => {
  function openPanel() {
    // Regex: the trigger's accessible name now includes the unread count.
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
  }

  it('clicking a same-portal item marks it read then navigates to its url', () => {
    const markRead = vi.fn().mockResolvedValue(undefined);
    hookState = makeHook({ items: [item('a', { url: '/partner/kyc/a' })], markRead });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    // click the first rendered instance of the item
    fireEvent.click(screen.getAllByText('Subject a')[0]);
    expect(markRead).toHaveBeenCalledWith('a');
    expect(push).toHaveBeenCalledWith('/partner/kyc/a');
  });

  it('an item with no url navigates to the fallback route', () => {
    hookState = makeHook({ items: [item('a', { url: '' })] });
    render(<NotificationBell fallbackUrl="/sales/dashboard" />);
    openPanel();
    fireEvent.click(screen.getAllByText('Subject a')[0]);
    expect(push).toHaveBeenCalledWith('/sales/dashboard');
  });

  it('an item whose url is in ANOTHER portal falls back (still marks read)', () => {
    const markRead = vi.fn().mockResolvedValue(undefined);
    // A partner bell (fallbackUrl under /partner) receives an item pointing at a
    // /sales route → navigating there would hit RequireAuth, so it must fall back.
    hookState = makeHook({ items: [item('a', { url: '/sales/kyc/a' })], markRead });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    fireEvent.click(screen.getAllByText('Subject a')[0]);
    expect(markRead).toHaveBeenCalledWith('a'); // read still recorded
    expect(push).toHaveBeenCalledWith('/partner/dashboard'); // not /sales/kyc/a
  });

  it('"Mark all read" calls markAllRead when there are unread items', () => {
    const markAllRead = vi.fn().mockResolvedValue(undefined);
    hookState = makeHook({ unreadCount: 2, items: [item('a')], markAllRead });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    fireEvent.click(screen.getAllByRole('button', { name: /Mark all read/ })[0]);
    expect(markAllRead).toHaveBeenCalled();
  });

  it('load-more calls loadMore when more pages exist', () => {
    const loadMore = vi.fn();
    hookState = makeHook({ items: [item('a')], hasMore: true, loadMore });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Load more' })[0]);
    expect(loadMore).toHaveBeenCalled();
  });
});

describe('NotificationBell — accessibility', () => {
  function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
  }

  it('the trigger aria-label announces the unread count', () => {
    hookState = makeHook({ unreadCount: 5 });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    expect(screen.getByRole('button', { name: 'Notifications, 5 unread' })).toBeTruthy();
  });

  it('the trigger aria-label is just "Notifications" when nothing is unread', () => {
    hookState = makeHook({ unreadCount: 0 });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('Escape closes the open panel', () => {
    hookState = makeHook({ items: [item('a')] });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    expect(screen.getAllByRole('dialog').length).toBeGreaterThan(0);
    fireEvent.keyDown(screen.getAllByRole('dialog')[0], { key: 'Escape' });
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  });

  it('marks unread rows for assistive tech (not color-only)', () => {
    hookState = makeHook({ items: [item('a', { readAt: null }), item('b', { readAt: new Date().toISOString() })] });
    render(<NotificationBell fallbackUrl="/partner/dashboard" />);
    openPanel();
    // The unread row carries a text "Unread" marker; the read row does not.
    expect(screen.getAllByText(/Unread/).length).toBeGreaterThan(0);
  });
});
