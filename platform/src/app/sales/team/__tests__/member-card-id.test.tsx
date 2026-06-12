/**
 * TDD — MemberCard shows employee ID, not beat/territory name
 *
 * AB1: each member card shows the employee ID (e.g. "xsr1")
 * AB2: territory/beat names are NOT shown in the member card sub-line
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve(null),
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners:         () => Promise.resolve({ banners: [] }),
  getActiveSalesBanners: () => [],
  getBgStyle:           () => ({}),
}));

import TeamPage from '../page';

describe('AB — MemberCard sub-line shows employee ID', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AB1: each member card shows the employee ID below the name', async () => {
    render(<TeamPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    await waitFor(() => expect(screen.getByText('xsr1')).toBeInTheDocument());
    expect(screen.getByText('xsr2')).toBeInTheDocument();
    expect(screen.getByText('xsr3')).toBeInTheDocument();
    expect(screen.getByText('xsr4')).toBeInTheDocument();
  });

  it('AB2: territory/beat names are NOT shown in the member card sub-line', async () => {
    render(<TeamPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    await waitFor(() => expect(screen.getByText('xsr1')).toBeInTheDocument());
    expect(screen.queryByText('Andheri Beat')).not.toBeInTheDocument();
    expect(screen.queryByText('Juhu Beat')).not.toBeInTheDocument();
    expect(screen.queryByText('Versova Beat')).not.toBeInTheDocument();
    expect(screen.queryByText('DN Nagar Beat')).not.toBeInTheDocument();
  });
});
