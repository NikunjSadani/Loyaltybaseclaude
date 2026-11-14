/**
 * M6 — Downloads nav badge: counts Ready files this person has not seen/downloaded yet (per user + brand,
 * browser storage only, no new API); re-counts when a report is queued / files are seen; renders without storage.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { ExportRequestDto } from '@/lib/exports/types';

const fetchExportList = vi.fn();
vi.mock('@/lib/exports/download', () => ({ fetchExportList: (...a: unknown[]) => fetchExportList(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/users/outlets' }));
vi.mock('@/components/exports/use-downloads-scope', () => ({
  useDownloadsScope: () => ({ brandName: 'Bajaj Consumer Care', seenKey: 'seen:u1:bajaj' }),
}));

import { DownloadsNavBadge } from '../downloads-nav-badge';
import { markSeen, seenStorageKey, countUnseenReady } from '@/lib/exports/seen';

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const row = (id: string, status: ExportRequestDto['status'], expiresAt: string | null = iso(86_400_000)) =>
  ({ id, status, expiresAt, label: id, kind: 'k', paramsSummary: '', fileName: null, sizeBytes: null, rowCount: null, error: null, createdAt: iso(-1000), startedAt: null, finishedAt: null }) as ExportRequestDto;
const ok = (items: ExportRequestDto[]) => Promise.resolve({ ok: true, data: { items, nextCursor: null } });

beforeEach(() => {
  fetchExportList.mockReset();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

describe('DownloadsNavBadge', () => {
  it('shows the number of Ready files not yet seen (expired / preparing / failed are not counted)', async () => {
    window.localStorage.setItem('seen:u1:bajaj', JSON.stringify(['a']));
    fetchExportList.mockImplementation(() => ok([
      row('a', 'READY'), row('b', 'READY'), row('c', 'READY'),
      row('old', 'READY', iso(-1000)), row('p', 'RUNNING', null), row('f', 'FAILED', null),
    ]));
    render(<DownloadsNavBadge />);
    const badge = await screen.findByTestId('downloads-nav-badge');
    expect(badge).toHaveTextContent('2');
    expect(badge).toHaveAttribute('aria-label', '2 new files ready');
  });

  it('clears when the files are seen (Downloads page marks them) — no badge at 0', async () => {
    fetchExportList.mockImplementation(() => ok([row('a', 'READY')]));
    render(<DownloadsNavBadge />);
    expect(await screen.findByTestId('downloads-nav-badge')).toHaveTextContent('1');
    act(() => { markSeen('seen:u1:bajaj', ['a']); });
    await waitFor(() => expect(screen.queryByTestId('downloads-nav-badge')).not.toBeInTheDocument());
  });

  it('renders (and still counts) when browser storage is blocked', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    fetchExportList.mockImplementation(() => ok([row('a', 'READY')]));
    render(<DownloadsNavBadge />);
    expect(await screen.findByTestId('downloads-nav-badge')).toHaveTextContent('1');
    spy.mockRestore();
  });

  it('a failed list request hides the badge (no error noise in the nav)', async () => {
    fetchExportList.mockImplementation(() => Promise.resolve({ ok: false, message: 'x' }));
    const { container } = render(<DownloadsNavBadge />);
    await waitFor(() => expect(fetchExportList).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('seen storage', () => {
  it('keys per user + brand', () => {
    expect(seenStorageKey('u1', 'bajaj')).not.toBe(seenStorageKey('u1', 'deoleo'));
    expect(seenStorageKey('u1', 'bajaj')).not.toBe(seenStorageKey('u2', 'bajaj'));
    expect(seenStorageKey(null, null)).toMatch(/anon:platform$/);
  });
  it('countUnseenReady', () => {
    expect(countUnseenReady([row('a', 'READY'), row('b', 'READY')], new Set(['a']))).toBe(1);
  });
});
