/**
 * Gifsy console "Support tickets" card — the client's Ticket remarks email (To + CC chip lists).
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
const now = () => new Date().toISOString();
const view = (to: string[], cc: string[], lastChange: any = null) => ({ success: true, data: { to, cc, email: to[0] ?? null, lastChange } });

const toInput = () => screen.getByLabelText(/^To/);
const ccInput = () => screen.getByLabelText(/^CC/);
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });
const enter = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter' });

beforeEach(() => {
  getMock.mockReset(); putMock.mockReset();
});

describe('TicketRemarksEmailCard (To + CC)', () => {
  it('loads To + CC chips, the helper text and the "Last changed by" line', async () => {
    getMock.mockResolvedValue(view(['tickets@bajaj.example'], ['ops@bajaj.example'], { byName: 'Owner', at: now() }));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByText('tickets@bajaj.example')).toBeInTheDocument();
    expect(screen.getByText('ops@bajaj.example')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(URL);
    expect(screen.getByText(/leave it blank and the email\s+goes to the admin chosen on each ticket/)).toBeInTheDocument();
    expect(screen.getByTestId('ticket-remarks-email-summary')).toHaveTextContent('Currently: To tickets@bajaj.example; CC ops@bajaj.example.');
    expect(screen.getByTestId('ticket-remarks-email-last-change')).toHaveTextContent(/^Last changed by Owner on /);
  });

  it('old API shape ({ email } only) still shows as one To chip', async () => {
    getMock.mockResolvedValue({ success: true, data: { email: 'old@bajaj.example', lastChange: null } });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByText('old@bajaj.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove old@bajaj.example from To' })).toBeInTheDocument();
  });

  it('unset: honest default; Save disabled until something changes', async () => {
    getMock.mockResolvedValue(view([], []));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByText(/Never changed — remarks emails go to the chosen admin/)).toBeInTheDocument();
    expect(screen.getByTestId('ticket-remarks-email-summary')).toHaveTextContent('Currently: the admin chosen on each ticket only.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('adds chips (Enter, comma-split paste, lowercased, deduped) and PUTs { to, cc }', async () => {
    getMock.mockResolvedValue(view([], []));
    putMock.mockResolvedValue(view(['a@bajaj.example', 'b@bajaj.example'], ['c@bajaj.example'], { byName: 'Owner', at: now() }));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    await screen.findByText(/Never changed/);
    type(toInput(), ' A@Bajaj.Example'); enter(toInput());
    type(toInput(), 'b@bajaj.example, a@bajaj.example,');
    type(ccInput(), 'c@bajaj.example'); // half-typed — folded in on Save, never dropped
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(URL, { to: ['a@bajaj.example', 'b@bajaj.example'], cc: ['c@bajaj.example'] }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-remarks-email-last-change')).toHaveTextContent(/Last changed by Owner/);
  });

  it('CC only (To blank) saves to: [] and the summary says the chosen admin gets it', async () => {
    getMock.mockResolvedValue(view([], []));
    putMock.mockResolvedValue(view([], ['ops@bajaj.example']));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    await screen.findByText(/Never changed/);
    type(ccInput(), 'ops@bajaj.example'); enter(ccInput());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(URL, { to: [], cc: ['ops@bajaj.example'] }));
    expect(await screen.findByTestId('ticket-remarks-email-summary')).toHaveTextContent('Currently: To the admin chosen on each ticket; CC ops@bajaj.example.');
  });

  it('removing every chip clears both lists (back to the chosen admin)', async () => {
    getMock.mockResolvedValue(view(['a@bajaj.example'], ['c@bajaj.example']));
    putMock.mockResolvedValue(view([], []));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove a@bajaj.example from To' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove c@bajaj.example from CC' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(URL, { to: [], cc: [] }));
  });

  it('invalid address → inline error under that list, no chip, no PUT', async () => {
    getMock.mockResolvedValue(view([], []));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    await screen.findByText(/Never changed/);
    type(toInput(), 'not-an-email'); enter(toInput());
    expect(await screen.findByRole('alert')).toHaveTextContent('"not-an-email" is not a valid email address.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(putMock).not.toHaveBeenCalled();
  });

  it('an address already in To cannot be added to CC', async () => {
    getMock.mockResolvedValue(view(['a@bajaj.example'], []));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    await screen.findByText('a@bajaj.example');
    type(ccInput(), 'A@bajaj.example'); enter(ccInput());
    expect(await screen.findByRole('alert')).toHaveTextContent('a@bajaj.example is already in To — an address can be in only one list.');
  });

  it('caps To at 5 (input disabled at the limit, extra entries refused)', async () => {
    getMock.mockResolvedValue(view(['1@b.com', '2@b.com', '3@b.com', '4@b.com'], []));
    render(<TicketRemarksEmailCard slug="bajaj" />);
    await screen.findByText('1@b.com');
    type(toInput(), '5@b.com, 6@b.com,');
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 5 To addresses.');
    expect(screen.getByText('5@b.com')).toBeInTheDocument();
    expect(toInput()).toBeDisabled();
  });

  it('shows the server error on save, and load failures with Retry', async () => {
    getMock.mockResolvedValueOnce({ success: false, error: 'Only a Gifsy Admin can manage the ticket remarks email.' });
    render(<TicketRemarksEmailCard slug="bajaj" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Gifsy Admin');
    getMock.mockResolvedValueOnce(view([], []));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/Never changed/);
    putMock.mockResolvedValue({ success: false, error: 'At most 10 CC addresses are allowed (got 11).' });
    type(ccInput(), 'ok@bajaj.example'); enter(ccInput());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 10 CC addresses');
  });

  it('clears the "Saved." timer on unmount (no late state update)', async () => {
    getMock.mockResolvedValue(view([], []));
    putMock.mockResolvedValue(view(['ok@bajaj.example'], []));
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(<TicketRemarksEmailCard slug="bajaj" />);
    await screen.findByText(/Never changed/);
    type(toInput(), 'ok@bajaj.example'); enter(toInput());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const before = clearSpy.mock.calls.length;
    unmount();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
    clearSpy.mockRestore();
  });
});
