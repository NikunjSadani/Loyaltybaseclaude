/**
 * Gifsy console "Support tickets" card — the client's Ticket remarks email.
 * Run: npx vitest run src/components/operator/__tests__/ticket-remarks-email-card.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getMock = vi.fn();
const putMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (...a: any[]) => getMock(...a), put: (...a: any[]) => putMock(...a) },
}));

import { TicketRemarksEmailCard } from '../ticket-remarks-email-card';

const URL = '/api/gifsy/clients/bajaj/ticket-remarks-email';

beforeEach(() => {
  getMock.mockReset(); putMock.mockReset();
});

describe('TicketRemarksEmailCard', () => {
  it('loads the current address + "Last changed by" line, with the helper text', async () => {
    getMock.mockResolvedValue({ success: true, data: { email: 'tickets@bajaj.example', lastChange: { byName: 'Owner', at: new Date().toISOString() } } });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByLabelText('Ticket remarks email')).toHaveValue('tickets@bajaj.example');
    expect(getMock).toHaveBeenCalledWith(URL);
    expect(screen.getByText(/emails go only to this address \(the admin asked is named in the email\)/)).toBeInTheDocument();
    expect(screen.getByTestId('ticket-remarks-email-last-change')).toHaveTextContent(/^Last changed by Owner on /);
  });

  it('unset shows the honest default and Save is disabled until something changes', async () => {
    getMock.mockResolvedValue({ success: true, data: { email: null, lastChange: null } });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByText(/Never changed — remarks emails go to the chosen admin/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a valid address (PUT) and shows Saved + the new last-change line', async () => {
    getMock.mockResolvedValue({ success: true, data: { email: null, lastChange: null } });
    putMock.mockResolvedValue({ success: true, data: { email: 'tickets@bajaj.example', lastChange: { byName: 'Owner', at: new Date().toISOString() } } });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Ticket remarks email'), { target: { value: ' Tickets@Bajaj.Example ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(URL, { email: 'Tickets@Bajaj.Example' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-remarks-email-last-change')).toHaveTextContent(/Last changed by Owner/);
  });

  it('clearing sends null (back to emailing the chosen admin)', async () => {
    getMock.mockResolvedValue({ success: true, data: { email: 'tickets@bajaj.example', lastChange: null } });
    putMock.mockResolvedValue({ success: true, data: { email: null, lastChange: { byName: 'Owner', at: new Date().toISOString() } } });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Ticket remarks email'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(URL, { email: null }));
  });

  it.each(['not-an-email', 'a@b.com, c@d.com', 'a@b.com;c@d.com'])('rejects %j client-side (no PUT)', async (bad) => {
    getMock.mockResolvedValue({ success: true, data: { email: null, lastChange: null } });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Ticket remarks email'), { target: { value: bad } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter ONE valid email address');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('shows the server error (e.g. 403 for a non-owner) and load failures with Retry', async () => {
    getMock.mockResolvedValueOnce({ success: false, error: 'Only a Gifsy Admin can manage the ticket remarks email.' });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Gifsy Admin');
    getMock.mockResolvedValueOnce({ success: true, data: { email: null, lastChange: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Ticket remarks email')).toBeInTheDocument();
    putMock.mockResolvedValue({ success: false, error: 'not a valid email address' });
    fireEvent.change(screen.getByLabelText('Ticket remarks email'), { target: { value: 'ok@bajaj.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid email address');
  });

  it('clears the "Saved." timer on unmount (no late state update)', async () => {
    getMock.mockResolvedValue({ success: true, data: { email: null, lastChange: null } });
    putMock.mockResolvedValue({ success: true, data: { email: 'ok@bajaj.example', lastChange: null } });
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(<TicketRemarksEmailCard slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Ticket remarks email'), { target: { value: 'ok@bajaj.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const before = clearSpy.mock.calls.length;
    unmount();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
    clearSpy.mockRestore();
  });
});
