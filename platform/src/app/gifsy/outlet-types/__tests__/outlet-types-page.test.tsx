// TDD: /gifsy/outlet-types page
// Tests written BEFORE implementation.
// Run: npx vitest run src/app/gifsy/outlet-types/__tests__/outlet-types-page.test.tsx

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('A3: each outlet type shows its stable code', () => {
    render(<OutletTypesPage />);
    expect(screen.getByText('SSS')).toBeInTheDocument();
    expect(screen.getByText('WHOLESALER')).toBeInTheDocument();
    expect(screen.getByText('SUB_STOCKIST')).toBeInTheDocument();
    expect(screen.getByText('SSS_TOT')).toBeInTheDocument();
  });

  it('A4: all 4 outlet types show an "Active" status badge', () => {
    render(<OutletTypesPage />);
    const badges = screen.getAllByText(/active/i);
    // At least 4 active badges (one per type)
    expect(badges.length).toBeGreaterThanOrEqual(4);
  });

  it('A5: shows a note that the code is stable / name can change', () => {
    render(<OutletTypesPage />);
    // The info note contains "stable identifier" — unique text not on any button
    expect(screen.getByText(/stable identifier/i)).toBeInTheDocument();
  });
});

// ── B. Add outlet type button ─────────────────────────────────────────────────

describe('B – "Add Outlet Type" button', () => {
  it('B1: button is present on the page', () => {
    render(<OutletTypesPage />);
    expect(
      screen.getByRole('button', { name: /add outlet type/i })
    ).toBeInTheDocument();
  });

  it('B2: clicking "Add Outlet Type" opens an add form / modal', () => {
    render(<OutletTypesPage />);
    fireEvent.click(screen.getByRole('button', { name: /add outlet type/i }));
    // Form or modal with a code input appears
    expect(screen.getByLabelText(/code/i)).toBeInTheDocument();
  });
});

// ── C. Rename interaction ─────────────────────────────────────────────────────

describe('C – rename an outlet type', () => {
  it('C1: each row has a Rename button', () => {
    render(<OutletTypesPage />);
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    expect(renameButtons).toHaveLength(4);
  });

  it('C2: clicking Rename on Retailer shows an inline input pre-filled with current name', () => {
    render(<OutletTypesPage />);
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    fireEvent.click(renameButtons[0]);   // first = Retailer
    const input = screen.getByDisplayValue('SSS');
    expect(input).toBeInTheDocument();
  });

  it('C3: editing the name and saving updates the displayed name', () => {
    render(<OutletTypesPage />);
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    fireEvent.click(renameButtons[0]);
    const input = screen.getByDisplayValue('SSS');
    fireEvent.change(input, { target: { value: 'Dealer' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    // New name is displayed
    expect(screen.getByText('Dealer')).toBeInTheDocument();
    // The name cell (p.font-semibold) no longer reads 'SSS' — only the code chip does
    const nameEl = screen.getByText('Dealer');
    expect(nameEl.tagName.toLowerCase()).toBe('p');
    // Rename input is gone
    expect(screen.queryByDisplayValue('SSS')).not.toBeInTheDocument();
  });

  it('C4: code stays unchanged after rename', () => {
    render(<OutletTypesPage />);
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    fireEvent.click(renameButtons[0]);
    const input = screen.getByDisplayValue('SSS');
    fireEvent.change(input, { target: { value: 'Dealer' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    // Code is still shown
    expect(screen.getByText('SSS')).toBeInTheDocument();
  });

  it('C5: Cancel button dismisses the rename input without saving', () => {
    render(<OutletTypesPage />);
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    fireEvent.click(renameButtons[0]);
    const input = screen.getByDisplayValue('SSS');
    fireEvent.change(input, { target: { value: 'Dealer' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByText('SSS')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Dealer')).not.toBeInTheDocument();
  });
});

// ── D. Toggle active / inactive ───────────────────────────────────────────────

describe('D – toggle outlet type active state', () => {
  it('D1: each row has a Deactivate button (since all start active)', () => {
    render(<OutletTypesPage />);
    const deactivateButtons = screen.getAllByRole('button', { name: /deactivate/i });
    expect(deactivateButtons).toHaveLength(4);
  });

  it('D2: clicking Deactivate on Wholesaler changes its badge to "Inactive"', () => {
    render(<OutletTypesPage />);
    const deactivateButtons = screen.getAllByRole('button', { name: /deactivate/i });
    // Second row = Wholesaler
    fireEvent.click(deactivateButtons[1]);
    expect(screen.getByText(/inactive/i)).toBeInTheDocument();
  });

  it('D3: after deactivation, the button label changes to "Activate"', () => {
    render(<OutletTypesPage />);
    const deactivateButtons = screen.getAllByRole('button', { name: /deactivate/i });
    fireEvent.click(deactivateButtons[1]);
    expect(
      screen.getByRole('button', { name: /^activate$/i })
    ).toBeInTheDocument();
  });
});
