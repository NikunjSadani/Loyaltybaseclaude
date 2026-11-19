/**
 * Sales "New Ticket": a ticket raised FOR AN OUTLET now carries the structured outletId (so the
 * support console can show its outlet code); an "own issue" ticket sends none (shown as —).
 * See platform/docs/plans/SUPPORT-TICKETS.md.
 *
 * Run: npx vitest run src/app/sales/support/__tests__/ticket-outlet-link.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/platform/client-config-context', () => ({ useClientConfig: () => ({ slug: 'deoleo' }) }));
vi.mock('@/lib/auth-client', () => ({ getStoredUser: () => ({ name: 'Meera Iyer', role: 'SALES_ISR' }) }));

import SalesSupportPage from '../page';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const json = (data: unknown) => Promise.resolve({ json: () => Promise.resolve({ success: true, data }) });
    if (url === '/api/sales/outlets') return json({ outlets: [{ id: 'outlet-1', name: 'Gupta Stores', mobile: '9800000000' }] });
    if (url === '/api/tickets' && init?.method === 'POST') {
      return json({ ticket: { id: 'n1', ticketNumber: 'TKT-N', subject: 's', category: 'POINTS', status: 'OPEN', priority: 'MEDIUM', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] } });
    }
    if (url === '/api/tickets') return json({ tickets: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

async function fillAndSubmit(forOutlet: boolean) {
  render(<SalesSupportPage />);
  fireEvent.click(await screen.findByRole('button', { name: /New Ticket/ }));
  if (forOutlet) {
    fireEvent.click(await screen.findByText('Gupta Stores'));
    fireEvent.click(screen.getByText('Points Not Credited'));
  } else {
    fireEvent.click(screen.getByText('My Own Issue'));
    // first self category
    const cats = screen.getAllByRole('button').filter((b) => /Issue|Problem|Help|Other|Account|Login|App/i.test(b.textContent ?? ''));
    fireEvent.click(cats[cats.length - 1]);
  }
  fireEvent.change(screen.getByPlaceholderText('Brief description of the issue…'), { target: { value: 'Points missing' } });
  fireEvent.change(screen.getByPlaceholderText(/Invoice numbers|Describe your issue/), { target: { value: 'details' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit Ticket' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/tickets' && i?.method === 'POST')).toBe(true));
  const [, init] = fetchMock.mock.calls.find(([u, i]) => u === '/api/tickets' && i?.method === 'POST')!;
  return JSON.parse(String(init.body));
}

describe('Sales new ticket — outlet link', () => {
  it('"For an Outlet" sends the picked outletId', async () => {
    const body = await fillAndSubmit(true);
    expect(body.outletId).toBe('outlet-1');
    expect(body.subject).toBe('[Gupta Stores] Points missing');
  });

  it('"My Own Issue" sends no outletId', async () => {
    const body = await fillAndSubmit(false);
    expect(body).not.toHaveProperty('outletId');
  });
});
