/// <reference types="vitest/globals" />
/**
 * ASID — Admin Scheme detail page API wiring
 *
 * ASID1: shows loading spinner on mount for existing scheme (not 'new')
 * ASID2: renders scheme name from API response
 * ASID3: shows error message when fetch fails
 * ASID4: shows "Scheme not found" when API returns 404
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock SchemeBuilder to avoid complex component setup in tests
vi.mock('@/components/admin/scheme-builder', () => ({
  SchemeBuilder: ({ initialData }: { initialData?: { name?: string } }) => (
    <div data-testid="scheme-builder">{initialData?.name ?? 'builder'}</div>
  ),
}));

// Mock react `use` hook for params — returns { id: 'SCH001' } for existing scheme tests
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('react');
  return {
    ...actual,
    use: vi.fn((val: unknown) => {
      if (val && typeof val === 'object' && 'then' in val) {
        return { id: 'SCH001' };
      }
      return actual.use(val as React.Context<unknown>);
    }),
  };
});

import SchemeDetailPage from '../page';

const MOCK_SCHEME = {
  id: 'SCH001',
  name: 'Summer Push Q1 2025',
  description: 'Slab-based sales incentive for Q1.',
  status: 'ACTIVE',
  startDate: '2025-04-01T00:00:00.000Z',
  endDate: '2025-06-30T00:00:00.000Z',
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('ASID — Admin Scheme detail API wiring', () => {
  it('ASID1: shows loading spinner on mount for existing scheme', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}), // never resolves
    }));
    render(<SchemeDetailPage params={Promise.resolve({ id: 'SCH001' })} />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('ASID2: renders scheme name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: { scheme: MOCK_SCHEME } }),
    }));
    render(<SchemeDetailPage params={Promise.resolve({ id: 'SCH001' })} />);
    // Name appears in both <h1> and SchemeBuilder initialData; use findAllByText
    const matches = await screen.findAllByText('Summer Push Q1 2025');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('ASID3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<SchemeDetailPage params={Promise.resolve({ id: 'SCH001' })} />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('ASID4: shows "Scheme not found" when API returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({ success: false, error: 'Scheme not found' }),
    }));
    render(<SchemeDetailPage params={Promise.resolve({ id: 'SCH001' })} />);
    expect(await screen.findByText(/scheme not found/i)).toBeInTheDocument();
  });
});
