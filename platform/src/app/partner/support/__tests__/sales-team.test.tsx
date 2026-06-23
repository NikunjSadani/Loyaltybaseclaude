/**
 * Regression: the partner Support "Your Sales Team" card must show the REAL
 * reps mapped to the partner (GET /api/partner/sales-team), never the old
 * hardcoded demo personas (Anil Sharma / Rajesh Kumar).
 *
 * Run: npx vitest run src/app/partner/support/__tests__/sales-team.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (...a: any[]) => getMock(...a), post: vi.fn() },
}));

import PartnerSupportPage from '../page';

/** Route api.get by URL: sales-team → team payload, tickets → empty list. */
function routeGet(team: any[]) {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/partner/sales-team')) return Promise.resolve({ success: true, data: { team } });
    if (url.includes('/tickets')) return Promise.resolve({ success: true, data: { tickets: [] } });
    return Promise.resolve({ success: true, data: {} });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Partner Support — Your Sales Team is real, not hardcoded', () => {
  it('renders the assigned reps from the API and not the demo personas', async () => {
    routeGet([
      { name: 'Meera Iyer', role: 'ISR', phone: '9811111111', employeeCode: 'E-1', level: 5 },
      { name: 'Vikas Rao', role: 'Sales Officer', phone: '9822222222', employeeCode: 'E-2', level: 4 },
    ]);
    render(<PartnerSupportPage />);

    await waitFor(() => expect(screen.getByText('Meera Iyer')).toBeInTheDocument());
    expect(screen.getByText('Vikas Rao')).toBeInTheDocument();
    expect(screen.getByText('9811111111')).toBeInTheDocument();

    // The old fabricated personas must be gone.
    expect(screen.queryByText('Anil Sharma')).not.toBeInTheDocument();
    expect(screen.queryByText('Rajesh Kumar')).not.toBeInTheDocument();

    // Call link points at the real phone.
    expect(screen.getByLabelText('Call Meera Iyer')).toHaveAttribute('href', 'tel:9811111111');
  });

  it('shows an honest empty state when no rep is mapped (no fake fallback)', async () => {
    routeGet([]);
    render(<PartnerSupportPage />);

    await waitFor(() =>
      expect(screen.getByText(/No sales team is mapped/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('Anil Sharma')).not.toBeInTheDocument();
    expect(screen.queryByText('Rajesh Kumar')).not.toBeInTheDocument();
  });

  it('requests the real sales-team endpoint', async () => {
    routeGet([]);
    render(<PartnerSupportPage />);
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/api/partner/sales-team'),
    );
  });
});
