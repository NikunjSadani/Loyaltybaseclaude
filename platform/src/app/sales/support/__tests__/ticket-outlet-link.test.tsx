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

describe('Sales tickets — honest errors + masked states', () => {
  it('a refused outlet (server 400) is shown in the form, not swallowed', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const ok = (data: unknown) => Promise.resolve({ json: () => Promise.resolve({ success: true, data }) });
      if (url === '/api/sales/outlets') return ok({ outlets: [{ id: 'outlet-1', name: 'Gupta Stores', mobile: '9800000000' }] });
      if (url === '/api/tickets' && init?.method === 'POST') {
        return Promise.resolve({ json: () => Promise.resolve({ success: false, error: 'That outlet is not (or no longer) assigned to you or your team' }) });
      }
      if (url === '/api/tickets') return ok({ tickets: [] });
      return ok({});
    });
    await fillAndSubmit(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer) assigned to you');
  });

  it('an ESCALATED ticket shows as In Progress (never falls back to Open)', async () => {
    fetchMock.mockImplementation((url: string) => {
      const ok = (data: unknown) => Promise.resolve({ json: () => Promise.resolve({ success: true, data }) });
      if (url === '/api/tickets') {
        return ok({ tickets: [{ id: 't9', ticketNumber: 'TKT-9', subject: 'Escalated one', category: 'POINTS', status: 'ESCALATED', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }] });
      }
      return ok({ outlets: [] });
    });
    render(<SalesSupportPage />);
    expect(await screen.findByText('Escalated one')).toBeInTheDocument();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.queryByText('Open', { selector: 'span' })).not.toBeInTheDocument();
  });
});

describe('Sales tickets — no priority UI for field readers', () => {
  it('neither the list nor the new-ticket form shows a priority (the API never returns one to a rep)', async () => {
    fetchMock.mockImplementation((url: string) => {
      const ok = (data: unknown) => Promise.resolve({ json: () => Promise.resolve({ success: true, data }) });
      if (url === '/api/tickets') {
        return ok({ tickets: [{ id: 't9', ticketNumber: 'TKT-9', subject: 'Some issue', category: 'POINTS', status: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }] });
      }
      return ok({ outlets: [] });
    });
    render(<SalesSupportPage />);
    expect(await screen.findByText('Some issue')).toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New Ticket/ }));
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'High' })).not.toBeInTheDocument();
  });
});
