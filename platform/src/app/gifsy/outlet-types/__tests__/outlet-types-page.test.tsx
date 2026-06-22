// /gifsy/outlet-types page — READ-ONLY catalog.
// Global Add/Rename/Toggle were removed (no global OutletType CRUD by design; the real,
// persisted control is per-client on the client-detail page). These tests assert the
// read-only render and that the previously-fake mutation controls are gone.
// Run: npx vitest run src/app/gifsy/outlet-types/__tests__/outlet-types-page.test.tsx

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import OutletTypesPage from '../page';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/gifsy/outlet-types',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// ── A. Rendering ──────────────────────────────────────────────────────────────

describe('A – page renders correctly', () => {
  it('A1: shows the page heading "Outlet Types"', () => {
    render(<OutletTypesPage />);
    expect(screen.getByRole('heading', { name: /outlet types/i })).toBeInTheDocument();
  });

  it('A2: renders all 4 outlet types', () => {
    render(<OutletTypesPage />);
    expect(screen.getByText('SSS')).toBeInTheDocument();
    expect(screen.getByText('Wholesaler')).toBeInTheDocument();
    expect(screen.getByText('Sub-Stockist')).toBeInTheDocument();
    expect(screen.getByText('SSS TOT')).toBeInTheDocument();
  });

  it('A3: each non-eponymous outlet type shows its stable code', () => {
    render(<OutletTypesPage />);
    expect(screen.getByText('WHOLESALER')).toBeInTheDocument();
    expect(screen.getByText('SUB_STOCKIST')).toBeInTheDocument();
    expect(screen.getByText('SSS_TOT')).toBeInTheDocument();
  });

  it('A4: all 4 outlet types show an "Active" status badge', () => {
    render(<OutletTypesPage />);
    const badges = screen.getAllByText(/active/i);
    expect(badges.length).toBeGreaterThanOrEqual(4);
  });

  it('A5: shows the read-only note pointing to per-client config', () => {
    render(<OutletTypesPage />);
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});

// ── B. Read-only: the fake global-mutation controls are gone ───────────────────

describe('B – read-only (no global Add / Rename / Toggle)', () => {
  it('B1: there is NO "Add Outlet Type" button (global type creation has no backend)', () => {
    render(<OutletTypesPage />);
    expect(screen.queryByRole('button', { name: /add outlet type/i })).not.toBeInTheDocument();
  });

  it('B2: there are NO Rename buttons', () => {
    render(<OutletTypesPage />);
    expect(screen.queryAllByRole('button', { name: /rename/i })).toHaveLength(0);
  });

  it('B3: there are NO Activate/Deactivate toggle buttons', () => {
    render(<OutletTypesPage />);
    expect(screen.queryAllByRole('button', { name: /deactivate|^activate$/i })).toHaveLength(0);
  });
});
