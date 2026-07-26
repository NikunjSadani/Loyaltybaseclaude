/**
 * TDD — partner-portal scheme LIST page (D27).
 *
 * Replaces the old single dashboard banner: a real list of eligible activations
 * split into "Available" (not yet enrolled) and "My schemes" (has an enrollment),
 * each surfaced from schemeApi.listEligible + getMyEnrollment.
 *
 * L1: an un-enrolled scheme appears under "Available" and links to its detail page
 * L2: an enrolled scheme appears under "My schemes" with an "Enrolled" badge
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({ activePartnerId: null, operableOutlets: [], loading: false }),
}));
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    listEligible: vi.fn(),
    getMyEnrollment: vi.fn(),
  },
}));
import { schemeApi } from '@/lib/schemes';

const scheme = (id: string, name: string) => ({
  id, clientId: 'c1', code: id, name, description: `${name} desc`,
  status: 'ACTIVE', startDate: '2026-07-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
});

import PartnerSchemesPage from '../page';

describe('partner schemes list', () => {
  beforeEach(() => {
    vi.mocked(schemeApi.listEligible).mockResolvedValue({
      success: true,
      data: { schemes: [scheme('scm-a', 'Alpha Drive'), scheme('scm-b', 'Beta Drive')] },
    } as never);
    vi.mocked(schemeApi.getMyEnrollment).mockImplementation((id: string) =>
      Promise.resolve(
        id === 'scm-b'
          ? ({ success: true, data: { schemeOutlet: { id: 'ro', outletName: 'O' }, enrollment: { id: 'e1', status: 'SUBMITTED' } } } as never)
          : ({ success: false, error: 'not found' } as never),
      ),
    );
  });

  afterEach(() => vi.clearAllMocks());

  it('L1: an un-enrolled scheme shows under Available and links to its detail page', async () => {
    render(<PartnerSchemesPage />);
    await waitFor(() => expect(screen.getByText('Alpha Drive')).toBeInTheDocument());
    const link = screen.getByText('Alpha Drive').closest('a');
    expect(link).toHaveAttribute('href', '/partner/schemes/scm-a');
    // The enrolled one is NOT in the default (Available) tab.
    expect(screen.queryByText('Beta Drive')).not.toBeInTheDocument();
  });

  it('L2: an enrolled scheme shows under My schemes with an Enrolled badge', async () => {
    const user = userEvent.setup();
    render(<PartnerSchemesPage />);
    await waitFor(() => expect(screen.getByText('Alpha Drive')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /My schemes/i }));

    await waitFor(() => expect(screen.getByText('Beta Drive')).toBeInTheDocument());
    expect(screen.getByText('Enrolled')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Drive')).not.toBeInTheDocument();
  });
});
