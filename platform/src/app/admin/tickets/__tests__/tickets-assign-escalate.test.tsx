/**
 * Admin Tickets — assign picker, escalate dialog (Gifsy escalation + ask-client-for-remarks),
 * the client admin's "Awaiting your remarks" view + reply, and the Gifsy "Awaiting client"
 * filter/count. See platform/docs/plans/SUPPORT-TICKETS.md.
 *
 * Run: npx vitest run src/app/admin/tickets/__tests__/tickets-assign-escalate.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (...a: any[]) => getMock(...a), post: (...a: any[]) => postMock(...a) },
}));
vi.mock('@/lib/auth-client', () => ({ getAssumedBrand: () => null }));

let session = { role: 'GIFSY_ADMIN', name: 'Owner', userId: 'admin1', canManageSchemes: true };
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => session }));

let searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));

import AdminTicketsPage from '../page';

const now = () => new Date().toISOString();

const baseTicket = (over: Record<string, unknown> = {}) => ({
  id: 't1', ticketNumber: 'TKT-1', subject: 'Points missing', description: 'd', category: 'POINTS',
  priority: 'MEDIUM', status: 'IN_PROGRESS', createdById: 'u1', createdBy: { id: 'u1', name: 'Kumar Store' },
  assignedTo: null, metadata: null, createdAt: now(), updatedAt: now(), messages: [],
  raisedBy: { kind: 'OUTLET_OWNER', name: 'Ramesh Gupta', designation: null, label: 'Outlet owner — Ramesh Gupta' },
  outlet: { id: 'o1', outletCode: 'DEO-0042', name: 'Gupta Stores', source: 'OWNER_PRIMARY', ownerOutletCount: 1 },
  ...over,
});

const waitingTicket = (requestedFromId = 'cadmin1') => baseTicket({
  status: 'WAITING_ON_CLIENT',
  metadata: {
    clientRemarks: {
      requestedFromId, requestedFromName: 'Deoleo Admin', requestedById: 'admin1', requestedByName: 'Owner',
      note: 'Please confirm the invoice amount', requestedAt: now(),
    },
  },
});

const ASSIGNEES = [
  { id: 'admin1', name: 'Owner', role: 'GIFSY_ADMIN', kind: 'GIFSY' },
  { id: 'staff1', name: 'Staff One', role: 'GIFSY_STAFF', kind: 'GIFSY' },
  { id: 'cadmin1', name: 'Deoleo Admin', role: 'CLIENT_ADMIN', kind: 'CLIENT_ADMIN' },
];

function routeGet(opts: {
  list: any[]; detail?: any; awaiting?: { total: number; mine: number }; waitingList?: any[]; mineList?: any[];
  page2?: any[]; total?: number;
}) {
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/assignees')) return Promise.resolve({ success: true, data: { assignees: ASSIGNEES } });
    if (url.startsWith('/api/tickets?')) {
      const q = new URLSearchParams(url.split('?')[1]);
      const page = Number(q.get('page') ?? '1');
      const rows = q.get('status') === 'WAITING_ON_CLIENT' ? (opts.waitingList ?? [])
        : q.get('awaitingMine') === 'true' ? (opts.mineList ?? [])
        : page === 2 ? (opts.page2 ?? []) : opts.list;
      const total = q.get('status') || q.get('awaitingMine') ? rows.length : (opts.total ?? opts.list.length);
      return Promise.resolve({ success: true, data: { tickets: rows, pagination: { total }, awaitingClient: opts.awaiting } });
    }
    if (url.startsWith('/api/tickets/')) return Promise.resolve({ success: true, data: { ticket: opts.detail ?? opts.list[0] } });
    return Promise.resolve({ success: true, data: {} });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  session = { role: 'GIFSY_ADMIN', name: 'Owner', userId: 'admin1', canManageSchemes: true };
  searchParams = new URLSearchParams();
  postMock.mockResolvedValue({ success: true, data: {} });
});

async function openFirstTicket() {
  fireEvent.click(await screen.findByText('Points missing'));
}

describe('Gifsy: assign picker', () => {
  it('lists Gifsy staff + client admins and POSTs the pick to /assign', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await openFirstTicket();

    const picker = await screen.findByLabelText('Assign to');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Deoleo Admin' })).toBeInTheDocument());
    expect(within(picker).getByRole('group', { name: 'Gifsy support' })).toBeInTheDocument();
    expect(within(picker).getByRole('group', { name: 'Client admins' })).toBeInTheDocument();

    // Picking alone never fires a request (keyboard arrowing is safe) — the explicit button does.
    expect(screen.getByRole('button', { name: 'Unassign' })).toBeDisabled();
    fireEvent.change(picker, { target: { value: 'staff1' } });
    fireEvent.change(picker, { target: { value: 'cadmin1' } });
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/assign', { assigneeId: 'cadmin1' }));
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('"Unassigned" sends assigneeId null', async () => {
    routeGet({ list: [baseTicket({ assignedTo: { id: 'staff1', name: 'Staff One' } })] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const picker = await screen.findByLabelText('Assign to');
    await waitFor(() => expect((picker as HTMLSelectElement).value).toBe('staff1'));
    fireEvent.change(picker, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/assign', { assigneeId: null }));
  });

  it('a client admin sees the assignee read-only (no picker, no escalate)', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
    routeGet({ list: [baseTicket({ assignedTo: { id: 'staff1', name: 'Staff One' } })] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    // row + read-only panel field
    await waitFor(() => expect(screen.getAllByText('Staff One')).toHaveLength(2));
    expect(screen.queryByLabelText('Assign to')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Escalate/ })).not.toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalledWith('/api/tickets/t1/assignees');
  });
});

describe('Gifsy: escalate dialog', () => {
  it('Escalate is enabled on an UNASSIGNED ticket and escalates to the picked Gifsy user', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await openFirstTicket();

    const btn = await screen.findByRole('button', { name: /Escalate/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);

    const dialog = await screen.findByRole('group', { name: 'Escalate ticket' });
    const target = within(dialog).getByLabelText('Escalate to');
    // Only Gifsy users are escalation targets
    expect(within(target).queryByRole('option', { name: 'Deoleo Admin' })).not.toBeInTheDocument();
    fireEvent.change(target, { target: { value: 'staff1' } });
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: 'CRITICAL' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Customer escalated twice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Escalate' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/escalate', {
      escalateTo: 'staff1', reason: 'Customer escalated twice', priority: 'CRITICAL',
    }));
  });

  it('asks a client admin for remarks and warns loudly when the email was not sent', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { emailStatus: 'NOT_SENT', emailError: 'the client admin has no email address on file' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    fireEvent.click(await screen.findByRole('button', { name: /Escalate/ }));

    const dialog = await screen.findByRole('group', { name: 'Escalate ticket' });
    fireEvent.click(within(dialog).getByLabelText('Ask client admin for remarks'));
    const target = within(dialog).getByLabelText('Client admin');
    expect(within(target).queryByRole('option', { name: 'Staff One' })).not.toBeInTheDocument();
    fireEvent.change(target, { target: { value: 'cadmin1' } });
    const send = within(dialog).getByRole('button', { name: 'Send request' });
    expect(send).toBeDisabled(); // note required
    fireEvent.change(within(dialog).getByLabelText('What do you need from the client admin?'), { target: { value: 'Confirm invoice' } });
    fireEvent.click(send);

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/request-client-remarks', {
      clientAdminId: 'cadmin1', note: 'Confirm invoice',
    }));
    expect(await screen.findByText(/email was NOT sent/)).toBeInTheDocument();
  });

  it('shows the server error inline', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: false, error: "User 'x' is not an active client admin" });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    fireEvent.click(await screen.findByRole('button', { name: /Escalate/ }));
    const dialog = await screen.findByRole('group', { name: 'Escalate ticket' });
    fireEvent.change(within(dialog).getByLabelText('Escalate to'), { target: { value: 'staff1' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Escalate' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not an active client admin');
  });
});

describe('Client admin: "Awaiting your remarks" + reply', () => {
  beforeEach(() => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
  });

  it('shows the banner count, the note, and posts the reply to /client-remarks', async () => {
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 1 } });
    render(<AdminTicketsPage />);

    expect(await screen.findByText('1 ticket awaiting your remarks')).toBeInTheDocument();
    // the row badge
    expect(await screen.findByText('Awaiting your remarks')).toBeInTheDocument();
    await openFirstTicket();

    const section = await screen.findByRole('region', { name: 'Awaiting client remarks' });
    expect(within(section).getByText('Awaiting your remarks')).toBeInTheDocument();
    expect(within(section).getByText('Please confirm the invoice amount')).toBeInTheDocument();
    expect(within(section).getByText(/never to the outlet or sales team/)).toBeInTheDocument();

    fireEvent.change(within(section).getByLabelText('Your remarks'), { target: { value: 'Amount is correct' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Send remarks' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/client-remarks', { message: 'Amount is correct' }));
  });

  it('a colleague sees who it is waiting on and can still answer', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Other Admin', userId: 'cadmin2', canManageSchemes: false };
    routeGet({ list: [waitingTicket('cadmin1')], awaiting: { total: 1, mine: 0 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const section = await screen.findByRole('region', { name: 'Awaiting client remarks' });
    expect(within(section).getByText('Awaiting remarks from Deoleo Admin')).toBeInTheDocument();
    expect(within(section).getByLabelText('Your remarks')).toBeInTheDocument();
    expect(screen.queryByText(/awaiting your remarks$/)).not.toBeInTheDocument();
  });

  it('no banner when nothing waits on this admin (unchanged page for everyone else)', async () => {
    routeGet({ list: [baseTicket()], awaiting: { total: 0, mine: 0 } });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('Points missing')).toBeInTheDocument();
    expect(screen.queryByText(/awaiting your remarks/)).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting client')).not.toBeInTheDocument();
  });

  it('labels a client admin internal reply as "Client remarks" in the thread', async () => {
    const t = baseTicket({
      messages: [{ id: 'm1', message: 'Amount is correct', isInternal: true, createdAt: now(), sender: { id: 'cadmin1', name: 'Deoleo Admin', role: 'CLIENT_ADMIN' } }],
    });
    routeGet({ list: [t] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    expect(await screen.findByText('Client remarks')).toBeInTheDocument();
  });
});

describe('Gifsy: "Awaiting client" filter + count', () => {
  it('shows the server count and fetches WAITING_ON_CLIENT server-side when toggled', async () => {
    routeGet({ list: [baseTicket()], awaiting: { total: 3, mine: 0 }, waitingList: [waitingTicket()] });
    render(<AdminTicketsPage />);

    expect(await screen.findByLabelText('Awaiting client: 3')).toBeInTheDocument();
    const chip = screen.getByRole('button', { name: 'Awaiting client (3)' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/tickets?status=WAITING_ON_CLIENT&page=1&limit=25'));
    expect(await screen.findByText('Awaiting client', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Awaiting client (3)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a client admin does NOT get the Gifsy count card', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'A', userId: 'cadmin9', canManageSchemes: false };
    routeGet({ list: [baseTicket()], awaiting: { total: 3, mine: 0 } });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('Points missing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Awaiting client: 3')).not.toBeInTheDocument();
  });
});

describe('deep link (?ticket= from the bell / email)', () => {
  it('opens the linked ticket', async () => {
    searchParams = new URLSearchParams('ticket=t1');
    routeGet({ list: [], detail: baseTicket({ subject: 'Linked ticket' }) });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('Linked ticket')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('/api/tickets/t1');
  });
});

describe('centred, keyboard-accessible ticket dialog', () => {
  it('opens as a modal dialog (not a side panel), closes on Escape and returns focus to the row', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    const row = await screen.findByRole('row', { name: /Open ticket TKT-1/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Points missing' })).toBeInTheDocument();
    expect(dialog.className).toContain('-translate-x-1/2'); // centred, not ml-auto side drawer
    // focus moved inside the dialog
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('row', { name: /Open ticket TKT-1/ })));
  });

  it('the close button closes it too', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close ticket' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('client admin view uses the same centred dialog', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 1 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('region', { name: 'Awaiting client remarks' })).toBeInTheDocument();
  });
});

describe('outlet ID + unambiguous "Raised by"', () => {
  it('outlet-owner ticket: outlet name + ID at the top, "Raised by: Outlet owner — <name>"', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    // list shows the code and raiser
    expect(await screen.findByText('DEO-0042')).toBeInTheDocument();
    expect(screen.getByText('Raised by: Outlet owner — Ramesh Gupta')).toBeInTheDocument();
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('ticket-outlet')).toHaveTextContent('Gupta Stores · ID DEO-0042');
    expect(within(dialog).getByTestId('ticket-raised-by')).toHaveTextContent('Outlet owner — Ramesh Gupta');
  });

  it('sales ticket: "<name> · <designation>" and the stored outlet', async () => {
    const t = baseTicket({
      raisedBy: { kind: 'SALES', name: 'Meera Iyer', designation: 'ISR', label: 'Meera Iyer · ISR' },
      outlet: { id: 'o9', outletCode: 'DEO-0900', name: 'Ref Outlet', source: 'TICKET' },
    });
    routeGet({ list: [t] });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('Raised by: Meera Iyer · ISR')).toBeInTheDocument();
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('ticket-raised-by')).toHaveTextContent('Meera Iyer · ISR');
    expect(within(dialog).getByTestId('ticket-outlet')).toHaveTextContent('Ref Outlet · ID DEO-0900');
  });

  it('sales "own issue" ticket with no stored outlet shows — honestly', async () => {
    const t = baseTicket({
      raisedBy: { kind: 'SALES', name: 'Meera Iyer', designation: 'ISR', label: 'Meera Iyer · ISR' },
      outlet: null,
    });
    routeGet({ list: [t] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('ticket-outlet')).toHaveTextContent('—');
  });

  it('flags an inferred primary outlet for a multi-outlet owner', async () => {
    routeGet({ list: [baseTicket({ outlet: { id: 'o1', outletCode: 'DEO-0042', name: 'Gupta Stores', source: 'OWNER_PRIMARY', ownerOutletCount: 3 } })] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('ticket-outlet')).toHaveTextContent("owner's primary of 3 outlets");
  });

  it('search matches the outlet code', async () => {
    routeGet({ list: [baseTicket(), baseTicket({ id: 't2', ticketNumber: 'TKT-2', subject: 'Unrelated issue', outlet: null })] });
    render(<AdminTicketsPage />);
    await screen.findByText('Unrelated issue');
    fireEvent.change(screen.getByPlaceholderText(/outlet code/), { target: { value: 'deo-0042' } });
    await waitFor(() => expect(screen.queryByText('Unrelated issue')).not.toBeInTheDocument());
    expect(screen.getByText('Points missing')).toBeInTheDocument();
  });
});

describe('audit regressions', () => {
  it('client admin cannot post remarks to the outlet by mistake: outlet reply hidden while waiting', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 1 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Your remarks');
    expect(within(dialog).queryByRole('button', { name: 'Reply to Outlet' })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Reply')).not.toBeInTheDocument();
  });

  it('Gifsy still has the outlet reply on a waiting ticket', async () => {
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('button', { name: 'Reply to Outlet' })).toBeInTheDocument();
  });

  it('focus returns to the row even after an action reloaded the list', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    const row = await screen.findByRole('row', { name: /Open ticket TKT-1/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog');
    const picker = await within(dialog).findByLabelText('Assign to');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Staff One' })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: 'staff1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/assign', { assigneeId: 'staff1' }));
    // list reloaded (reloadKey) — table stays mounted, no spinner flash
    await waitFor(() => expect(getMock.mock.calls.filter(([u]) => String(u).startsWith('/api/tickets?')).length).toBeGreaterThanOrEqual(2));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement?.getAttribute('data-ticket-row')).toBe('t1'));
  });

  it('opening a row fetches the thread once', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await screen.findByRole('dialog');
    await waitFor(() => expect(getMock.mock.calls.filter(([u]) => u === '/api/tickets/t1').length).toBe(1));
  });

  it('paging: "Load more" fetches the next page and shows the total', async () => {
    routeGet({ list: [baseTicket()], page2: [baseTicket({ id: 't2', ticketNumber: 'TKT-2', subject: 'Second page ticket' })], total: 2 });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('Showing 1 of 2')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('/api/tickets?page=1&limit=25');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second page ticket')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('/api/tickets?page=2&limit=25');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
  });

  it('client admin "Show" lists ONLY the tickets awaiting this admin (count and list agree)', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
    routeGet({ list: [baseTicket(), waitingTicket('cadmin2')], awaiting: { total: 2, mine: 1 }, mineList: [waitingTicket('cadmin1')] });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('1 ticket awaiting your remarks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/tickets?awaitingMine=true&page=1&limit=25'));
    expect(await screen.findByRole('button', { name: /Awaiting your remarks \(1\)/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('row', { name: /Open ticket/ })).toHaveLength(1));
  });

  it('the client desk cannot change status while Gifsy waits on its remarks', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 1 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/status changes are paused/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Mark Resolved/ })).not.toBeInTheDocument();
  });

  it('remarks request: alreadyPending and email SENDING are both reported honestly', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { alreadyPending: true, message: 'A remarks request to Deoleo Admin is already pending' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const ask = async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Escalate/ }));
      const dialog = await screen.findByRole('group', { name: 'Escalate ticket' });
      fireEvent.click(within(dialog).getByLabelText('Ask client admin for remarks'));
      const sel = within(dialog).getByLabelText('Client admin');
      await waitFor(() => expect(within(sel).getByRole('option', { name: 'Deoleo Admin' })).toBeInTheDocument());
      fireEvent.change(sel, { target: { value: 'cadmin1' } });
      fireEvent.change(within(dialog).getByLabelText('What do you need from the client admin?'), { target: { value: 'x' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    };
    await ask();
    expect(await screen.findByText(/Nothing was re-sent/)).toBeInTheDocument();
    postMock.mockResolvedValue({ success: true, data: { emailStatus: 'SENDING' } });
    await ask();
    expect(await screen.findByText(/email is being sent/)).toBeInTheDocument();
  });

  it('labels thread messages: outlet owner, sales rep · designation, Gifsy, client admin', async () => {
    const t = baseTicket({
      messages: [
        { id: 'a', message: 'm1', isInternal: false, createdAt: now(), senderLabel: 'Outlet owner — Ramesh Gupta', senderKind: 'OUTLET_OWNER', sender: { id: 'u1', name: 'Ramesh', role: 'WHOLESALER' } },
        { id: 'b', message: 'm2', isInternal: false, createdAt: now(), senderLabel: 'Meera Iyer · ISR', senderKind: 'SALES', sender: { id: 'u2', name: 'Meera Iyer', role: 'SALES_ISR' } },
        { id: 'c', message: 'm3', isInternal: false, createdAt: now(), senderLabel: 'Owner · Gifsy support', senderKind: 'STAFF', sender: { id: 'admin1', name: 'Owner', role: 'GIFSY_ADMIN' } },
        { id: 'd', message: 'm4', isInternal: false, createdAt: now(), senderLabel: 'Anita · Client admin', senderKind: 'STAFF', sender: { id: 'ca', name: 'Anita', role: 'CLIENT_ADMIN' } },
      ],
    });
    routeGet({ list: [t] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    for (const label of ['Outlet owner — Ramesh Gupta', 'Meera Iyer · ISR', 'Owner · Gifsy support', 'Anita · Client admin']) {
      expect(await within(dialog).findByText(label, { selector: 'p' })).toBeInTheDocument();
    }
  });
});
