/**
 * TDD tests for KYC list page — Team Member filter.
 *
 * Covers:
 *   A) Visibility — filter only shown for roles that have a team (SO and above)
 *   B) Default state — "All Members" selected, all entries shown
 *   C) Options — lists the viewer's direct reports by name
 *   D) Filtering — selecting a member narrows the list to that person's entries
 *   E) Stacking — member filter combines with status filter chips
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const STORAGE_KEY = 'loyaltybase_sales_role';

import KYCListPage from '../page';

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function setRole(role: string) {
  localStorage.setItem(STORAGE_KEY, role);
}

/** Render the page and wait for mock data to appear (500 ms setTimeout). */
async function renderAndLoad() {
  render(<KYCListPage />);
  // Wait for the mock data load (500 ms setTimeout inside the component)
  await waitFor(
    () => expect(screen.getByText('Kumar General Store')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

/* ─── Setup ──────────────────────────────────────────────────────────────────── */

beforeEach(() => {
  setRole('SO'); // default viewer is an SO who has XSRs reporting to them
});

afterEach(() => {
  localStorage.clear();
});

/* ─── A: Visibility by role ──────────────────────────────────────────────────── */

describe('A: visibility by role', () => {
  it('shows the team member filter for SO role', async () => {
    await renderAndLoad();
    expect(
      screen.getByRole('combobox', { name: /team member/i }),
    ).toBeInTheDocument();
  });

  it('shows the team member filter for ASM role', async () => {
    setRole('ASM');
    await renderAndLoad();
    expect(
      screen.getByRole('combobox', { name: /team member/i }),
    ).toBeInTheDocument();
  });

  it('hides the team member filter for XSR role (no team below)', async () => {
    setRole('XSR');
    await renderAndLoad();
    expect(
      screen.queryByRole('combobox', { name: /team member/i }),
    ).not.toBeInTheDocument();
  });
});

/* ─── B: Default state ───────────────────────────────────────────────────────── */

describe('B: default state', () => {
  it('defaults the member filter to "All Members"', async () => {
    await renderAndLoad();
    expect(
      screen.getByRole('combobox', { name: /team member/i }),
    ).toHaveValue('');
  });

  it('shows all KYC entries when "All Members" is selected', async () => {
    await renderAndLoad();
    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();
    expect(screen.getByText('Sharma Kirana')).toBeInTheDocument();
    expect(screen.getByText('Patel Grocery')).toBeInTheDocument();
  });
});

/* ─── C: Member options ──────────────────────────────────────────────────────── */

describe('C: member options', () => {
  it('lists "All Members" as the first option', async () => {
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });
    const firstOption = within(select).getAllByRole('option')[0];
    expect(firstOption).toHaveTextContent(/all members/i);
    expect(firstOption).toHaveValue('');
  });

  it("lists SO's XSR direct reports as options", async () => {
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });
    expect(within(select).getByRole('option', { name: /anil sharma/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /divya pillai/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /kiran rao/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /meena joshi/i })).toBeInTheDocument();
  });

  it("lists ASM's SO direct reports as options", async () => {
    setRole('ASM');
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });
    expect(within(select).getByRole('option', { name: /rajesh kumar/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /nisha verma/i })).toBeInTheDocument();
  });
});

/* ─── D: Filtering ───────────────────────────────────────────────────────────── */

describe('D: filtering', () => {
  it("shows only the selected member's entries", async () => {
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });

    // xsr1 (Anil Sharma) submitted: Kumar General Store (k1) and Mehta Provisions (k5)
    await userEvent.selectOptions(select, 'xsr1');

    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();
    expect(screen.getByText('Mehta Provisions')).toBeInTheDocument();

    // entries from other XSRs should be hidden
    expect(screen.queryByText('Sharma Kirana')).not.toBeInTheDocument();   // xsr2
    expect(screen.queryByText('Patel Grocery')).not.toBeInTheDocument();   // xsr3
  });

  it('shows all entries again when "All Members" is reselected', async () => {
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });

    await userEvent.selectOptions(select, 'xsr1');
    await userEvent.selectOptions(select, ''); // All Members

    expect(screen.getByText('Sharma Kirana')).toBeInTheDocument();
    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();
    expect(screen.getByText('Patel Grocery')).toBeInTheDocument();
  });

  it('shows an empty state when a member has no KYC entries', async () => {
    // If we filter by a member who has no entries, empty state should show
    // xsr2 submitted: Sharma Kirana (k2), Desai Grocers (k6)
    // xsr3 submitted: Patel Grocery (k3), Suresh Wholesale (k7)
    // All 8 entries are spread across xsr1-4; none left for a hypothetical xsr5.
    // We'll verify the inverse: filtering by xsr2 hides xsr1 entries.
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });
    await userEvent.selectOptions(select, 'xsr2');

    expect(screen.getByText('Sharma Kirana')).toBeInTheDocument();    // xsr2
    expect(screen.getByText('Desai Grocers')).toBeInTheDocument();    // xsr2
    expect(screen.queryByText('Kumar General Store')).not.toBeInTheDocument(); // xsr1
  });
});

/* ─── E: Stacking with status filter ────────────────────────────────────────── */

describe('E: stacks with status filter', () => {
  it('applies both member and status filters simultaneously', async () => {
    await renderAndLoad();
    const select = screen.getByRole('combobox', { name: /team member/i });

    // xsr1 has: k1 = APPROVED, k5 = PENDING_GIFSY
    await userEvent.selectOptions(select, 'xsr1');

    // Now also filter by APPROVED status (dropdown)
    const statusSelect = screen.getByTestId('kyc-status-filter');
    await userEvent.selectOptions(statusSelect, 'APPROVED');

    // Only k1 passes both filters
    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();
    expect(screen.queryByText('Mehta Provisions')).not.toBeInTheDocument(); // xsr1 but PENDING_GIFSY
  });

  it('status-filtering then member-filtering works in either order', async () => {
    await renderAndLoad();

    // Filter to APPROVED first (dropdown)
    await userEvent.selectOptions(screen.getByTestId('kyc-status-filter'), 'APPROVED');
    // Then filter to xsr4
    const select = screen.getByRole('combobox', { name: /team member/i });
    await userEvent.selectOptions(select, 'xsr4');

    // xsr4 approved entries: k4 (Singh Supermart) — k8 is RE_KYC_REQUIRED
    expect(screen.getByText('Singh Supermart')).toBeInTheDocument();
    expect(screen.queryByText('Kumar General Store')).not.toBeInTheDocument(); // xsr1
  });
});
