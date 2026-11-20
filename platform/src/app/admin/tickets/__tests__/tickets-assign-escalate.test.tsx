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

// Staff permission layer: everyone has everything unless a test narrows it.
let grantedPerms: string[] | null = null; // null = not gated
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    role: null, permissions: grantedPerms ?? [], ready: true, error: false, retry: () => {},
    has: (perm: string) => grantedPerms === null || grantedPerms.includes(perm),
  }),
}));

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
  grantedPerms = null;
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
    postMock.mockResolvedValue({ success: true, data: { emailSent: false, emailError: 'the client admin has no email address on file' } });
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
    expect(await screen.findByText(/email to the client admin was NOT sent \(the client admin has no email address on file\)/)).toBeInTheDocument();
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
    expect(screen.queryByText('Awaiting client', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('labels a client admin internal reply as "Client remarks" in the thread', async () => {
    const t = baseTicket({
      messages: [
        { id: 'm1', message: 'Amount is correct', isInternal: true, isClientRemarks: true, createdAt: now(), sender: { id: 'cadmin1', name: 'Deoleo Admin', role: 'CLIENT_ADMIN' } },
        { id: 'm2', message: 'Just an internal note', isInternal: true, isClientRemarks: false, internalVisibility: 'SHARED_WITH_CLIENT', createdAt: now(), sender: { id: 'cadmin1', name: 'Deoleo Admin', role: 'CLIENT_ADMIN' } },
      ],
    });
    routeGet({ list: [t] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    // only the actual REPLY is badged "Client remarks"; the ordinary internal note is "Shared with client"
    expect(await screen.findAllByText('Client remarks')).toHaveLength(1);
    expect(screen.getAllByText('Shared with client', { selector: 'span' })).toHaveLength(1);
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

  it('search is sent to the SERVER (covers every ticket, not just loaded pages) and resets to page 1', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await screen.findByText('Points missing');
    fireEvent.change(screen.getByLabelText('Search tickets'), { target: { value: 'DEO-0042' } });
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/tickets?q=DEO-0042&page=1&limit=25'));
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
    postMock.mockResolvedValue({ success: true, data: { emailSent: true } });
    await ask();
    expect(await screen.findByText(/notified in-app and by email/)).toBeInTheDocument();
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

describe('round 2', () => {
  it('switching view always shows page 1 of the new view (never the old page count)', async () => {
    routeGet({ list: [baseTicket()], page2: [baseTicket({ id: 't2', ticketNumber: 'TKT-2', subject: 'Second page ticket' })], total: 2, awaiting: { total: 1, mine: 0 }, waitingList: [waitingTicket()] });
    render(<AdminTicketsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second page ticket')).toBeInTheDocument();
    getMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Awaiting client (1)' }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/tickets?status=WAITING_ON_CLIENT&page=1&limit=25'));
    const listCalls = getMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/tickets?'));
    expect(listCalls.every((u) => u.includes('page=1&'))).toBe(true);
    expect(listCalls.some((u) => u.includes('page=2'))).toBe(false);
    await waitFor(() => expect(screen.queryByText('Second page ticket')).not.toBeInTheDocument());
  });

  it('filters are server-side: status / priority / category / source become query params', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await screen.findByText('Points missing');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ESCALATED' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'KYC' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'sales' } });
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(
      '/api/tickets?status=ESCALATED&priorities=HIGH%2CCRITICAL&category=KYC&source=sales&page=1&limit=25',
    ));
  });

  it('stat cards show the SERVER summary (tenant-wide), not counts of the loaded page', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve({ success: true, data: {
          tickets: [baseTicket()], pagination: { total: 1 }, awaitingClient: { total: 0, mine: 0 },
          summary: { total: 412, open: 37, inProgress: 55, resolved: 300, highPriority: 9 },
        } });
      }
      return Promise.resolve({ success: true, data: { ticket: baseTicket(), assignees: ASSIGNEES } });
    });
    render(<AdminTicketsPage />);
    expect(await screen.findByTestId('stat-Total')).toHaveTextContent('412');
    expect(screen.getByTestId('stat-Open')).toHaveTextContent('37');
    expect(screen.getByTestId('stat-High Priority')).toHaveTextContent('9');
  });

  it('Gifsy internal note: "Gifsy only" by default, "Share with client admin" on request', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { message: {} } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Internal Note' }));
    const group = within(dialog).getByRole('radiogroup', { name: 'Who can read this note' });
    expect(within(group).getByLabelText('Gifsy only')).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Reply'), { target: { value: 'private' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/messages', { message: 'private', isInternal: true, visibility: 'GIFSY_ONLY' }));
    fireEvent.click(within(group).getByLabelText('Share with client admin'));
    fireEvent.change(within(dialog).getByLabelText('Reply'), { target: { value: 'shared' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/messages', { message: 'shared', isInternal: true, visibility: 'SHARED_WITH_CLIENT' }));
  });

  it('client admin internal notes carry no visibility choice (always shared)', async () => {
    session = { role: 'CLIENT_ADMIN', name: 'Deoleo Admin', userId: 'cadmin1', canManageSchemes: false };
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Internal Note' }));
    expect(within(dialog).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/shared with Gifsy support/)).toBeInTheDocument();
  });

  it('thread badges: "Gifsy only" vs "Shared with client" (legacy NULL shown as shared)', async () => {
    const msg = (id: string, vis: string | null) => ({
      id, message: `note ${id}`, isInternal: true, internalVisibility: vis, createdAt: now(),
      senderLabel: 'Owner · Gifsy support', senderKind: 'STAFF', sender: { id: 'admin1', name: 'Owner', role: 'GIFSY_ADMIN' },
    });
    routeGet({ list: [baseTicket({ messages: [msg('a', 'GIFSY_ONLY'), msg('b', 'SHARED_WITH_CLIENT'), msg('c', null)] })] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('note a');
    expect(within(dialog).getAllByText('Gifsy only', { selector: 'span' })).toHaveLength(1);
    expect(within(dialog).getAllByText('Shared with client', { selector: 'span' })).toHaveLength(2);
  });

  it('Gifsy can "Cancel request & resume" a waiting ticket', async () => {
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const section = await screen.findByRole('region', { name: 'Awaiting client remarks' });
    fireEvent.click(within(section).getByRole('button', { name: 'Cancel request & resume' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/cancel-client-remarks', {}));
    expect(await screen.findByText(/Request cancelled/)).toBeInTheDocument();
  });

  it('MIS sees "Waiting for <client admin>\'s remarks" (it cannot reply)', async () => {
    session = { role: 'MIS_USER', name: 'MIS', userId: 'mis1', canManageSchemes: false };
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const section = await screen.findByRole('region', { name: 'Awaiting client remarks' });
    expect(within(section).getByText("Waiting for Deoleo Admin's remarks")).toBeInTheDocument();
    expect(within(section).queryByLabelText('Your remarks')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /Cancel request/ })).not.toBeInTheDocument();
  });
});

describe('round 3', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('a Load-more in flight when the search changes is DROPPED (no old-filter rows, total not overwritten)', async () => {
    routeGet({ list: [baseTicket()], total: 2 });
    const page2 = deferred<any>();
    const base = getMock.getMockImplementation()!;
    getMock.mockImplementation((url: string) => (url.includes('page=2') ? page2.promise : base(url)));
    render(<AdminTicketsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    fireEvent.change(screen.getByLabelText('Search tickets'), { target: { value: 'zzz' } });
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/tickets?q=zzz&page=1&limit=25'));
    page2.resolve({ success: true, data: { tickets: [baseTicket({ id: 'old', ticketNumber: 'TKT-OLD', subject: 'Stale old-filter row' })], pagination: { total: 99 } } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Stale old-filter row')).not.toBeInTheDocument();
    expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  });

  it('Load more fetches ONLY the next page (no refetch of page 1)', async () => {
    routeGet({ list: [baseTicket()], page2: [baseTicket({ id: 't2', ticketNumber: 'TKT-2', subject: 'Second' })], total: 2 });
    render(<AdminTicketsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Second');
    const listCalls = getMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/tickets?'));
    expect(listCalls).toEqual(['/api/tickets?page=1&limit=25', '/api/tickets?page=2&limit=25']);
  });

  it('a filter change shows a loading state while the server answers', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await screen.findByText('Points missing');
    const pending = deferred<any>();
    getMock.mockImplementation(() => pending.promise);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'OPEN' } });
    expect(await screen.findByText('Updating tickets…')).toBeInTheDocument();
    pending.resolve({ success: true, data: { tickets: [], pagination: { total: 0 } } });
    await waitFor(() => expect(screen.queryByText('Updating tickets…')).not.toBeInTheDocument());
  });

  it('a list error keeps the filters visible, shows Retry, and Retry / clearing recovers', async () => {
    let fail = true;
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(fail ? { success: false, error: 'Server exploded' } : { success: true, data: { tickets: [baseTicket()], pagination: { total: 1 } } });
      }
      return Promise.resolve({ success: true, data: {} });
    });
    render(<AdminTicketsPage />);
    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    expect(screen.getByLabelText('Search tickets')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Points missing')).toBeInTheDocument();
    expect(screen.queryByText('Server exploded')).not.toBeInTheDocument();
  });

  it('Mark Resolved on an Awaiting-client ticket asks to confirm, then says the request was cancelled', async () => {
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    postMock.mockResolvedValue({ success: true, data: { cancelledRemarksFrom: 'Deoleo Admin' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Mark Resolved/ }));
    const confirm = await within(dialog).findByRole('alertdialog', { name: 'Confirm cancelling the remarks request' });
    expect(confirm).toHaveTextContent("cancels the pending request to Deoleo Admin — they'll be notified");
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Resolve & cancel request' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/status', { status: 'RESOLVED' }));
    expect(await within(dialog).findByText(/pending request to Deoleo Admin was cancelled and they were notified/)).toBeInTheDocument();
  });

  it('"Keep waiting" backs out of the confirm without any request', async () => {
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Close$/ }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Keep waiting' }));
    expect(within(dialog).queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('Escalate on an Awaiting-client ticket requires "Confirm escalate" and reports the cancellation', async () => {
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    postMock.mockResolvedValue({ success: true, data: { cancelledRemarksFrom: 'Deoleo Admin' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    fireEvent.click(await screen.findByRole('button', { name: /Escalate/ }));
    const panel = await screen.findByRole('group', { name: 'Escalate ticket' });
    const sel = within(panel).getByLabelText('Escalate to');
    await waitFor(() => expect(within(sel).getByRole('option', { name: 'Staff One' })).toBeInTheDocument());
    fireEvent.change(sel, { target: { value: 'staff1' } });
    fireEvent.change(within(panel).getByLabelText('Reason'), { target: { value: 'urgent' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Escalate' }));
    expect(await within(panel).findByText(/cancels the pending request to Deoleo Admin/)).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm escalate' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/tickets/t1/escalate', { escalateTo: 'staff1', reason: 'urgent', priority: 'HIGH' }));
    expect(await screen.findByText(/pending request to Deoleo Admin was cancelled and they were notified/)).toBeInTheDocument();
  });

  it('409 → the ticket reloads automatically, the user is told what changed, typed text is kept', async () => {
    let detailStatus = 'IN_PROGRESS';
    routeGet({ list: [baseTicket()] });
    const base = getMock.getMockImplementation()!;
    getMock.mockImplementation((url: string) =>
      url === '/api/tickets/t1' ? Promise.resolve({ success: true, data: { ticket: baseTicket({ status: detailStatus }) } }) : base(url));
    postMock.mockResolvedValue({ success: false, error: 'The ticket changed meanwhile', status: 409 });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reply'), { target: { value: 'my long reply' } });
    detailStatus = 'CLOSED';
    const before = getMock.mock.calls.filter(([u]) => u === '/api/tickets/t1').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/changed by someone else.*In Progress → Closed.*your text is kept/)).toBeInTheDocument();
    expect(getMock.mock.calls.filter(([u]) => u === '/api/tickets/t1').length).toBeGreaterThan(before);
    expect(within(dialog).getByLabelText('Reply')).toHaveValue('my long reply');
  });

  it('assignee load failure shows the failure + Retry (not "no users")', async () => {
    let failAssignees = true;
    routeGet({ list: [baseTicket()] });
    const base = getMock.getMockImplementation()!;
    getMock.mockImplementation((url: string) =>
      url.endsWith('/assignees') && failAssignees ? Promise.resolve({ success: false, error: 'Gateway timeout' }) : base(url));
    render(<AdminTicketsPage />);
    await openFirstTicket();
    fireEvent.click(await screen.findByRole('button', { name: /Escalate/ }));
    const panel = await screen.findByRole('group', { name: 'Escalate ticket' });
    expect(await within(panel).findByText(/Could not load the people you can pick: Gateway timeout/)).toBeInTheDocument();
    expect(within(panel).queryByText(/No active Gifsy support users/)).not.toBeInTheDocument();
    failAssignees = false;
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(within(panel).getByLabelText('Escalate to')).getByRole('option', { name: 'Staff One' })).toBeInTheDocument());
  });

  it('staff without support:escalate: Escalate disabled with the reason (no 403 surprise)', async () => {
    session = { role: 'GIFSY_STAFF', name: 'Staff One', userId: 'staff1', canManageSchemes: true };
    grantedPerms = ['support:read', 'support:write'];
    routeGet({ list: [waitingTicket()], awaiting: { total: 1, mine: 0 } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Escalate/ })).toBeDisabled();
    expect(within(dialog).getByText(/does not include escalation \(support:escalate\)/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Cancel request/ })).not.toBeInTheDocument();
  });

  it('Reply / Internal toggles expose aria-pressed and a non-colour cue', async () => {
    routeGet({ list: [baseTicket()] });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    const dialog = await screen.findByRole('dialog');
    const reply = within(dialog).getByRole('button', { name: 'Reply to Outlet' });
    const internal = within(dialog).getByRole('button', { name: 'Internal Note' });
    expect(reply).toHaveAttribute('aria-pressed', 'true');
    expect(internal).toHaveAttribute('aria-pressed', 'false');
    expect(reply.querySelector('svg')).not.toBeNull();
    fireEvent.click(internal);
    expect(internal).toHaveAttribute('aria-pressed', 'true');
    expect(reply).toHaveAttribute('aria-pressed', 'false');
    expect(internal.querySelector('svg')).not.toBeNull();
  });
});

describe('remarks toast names where the email went (follow-up)', () => {
  const ask = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Escalate/ }));
    const panel = await screen.findByRole('group', { name: 'Escalate ticket' });
    fireEvent.click(within(panel).getByLabelText('Ask client admin for remarks'));
    const sel = within(panel).getByLabelText('Client admin');
    await waitFor(() => expect(within(sel).getByRole('option', { name: 'Deoleo Admin' })).toBeInTheDocument());
    fireEvent.change(sel, { target: { value: 'cadmin1' } });
    fireEvent.change(within(panel).getByLabelText('What do you need from the client admin?'), { target: { value: 'x' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send request' }));
  };

  it('INBOX → "notified in-app; email sent to the client\'s ticket remarks inbox <addr>"', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { emailSent: true, emailRecipientKind: 'INBOX', emailRecipient: 'tickets@deoleo.example' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText("Remarks requested. The client admin was notified in-app; email sent to the client's ticket remarks inbox tickets@deoleo.example.")).toBeInTheDocument();
  });

  it('INBOX failure → names the inbox', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { emailSent: false, emailError: 'relay down', emailRecipientKind: 'INBOX', emailRecipient: 'tickets@deoleo.example' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText(/email to the client's ticket remarks inbox tickets@deoleo\.example was NOT sent \(relay down\)/)).toBeInTheDocument();
  });

  it('ADMIN → "notified in-app and by email (<addr>)"', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { emailSent: true, emailRecipientKind: 'ADMIN', emailRecipient: 'ca@deoleo.example' } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText('Remarks requested. The client admin was notified in-app and by email (ca@deoleo.example).')).toBeInTheDocument();
  });

  it('INBOX with To list + CC + a relay-rejected address → names all and flags the rejection', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: {
      emailSent: true, emailRecipientKind: 'INBOX', emailRecipient: 'a@deoleo.example, b@deoleo.example',
      emailCc: ['c@deoleo.example'], emailRejected: ['b@deoleo.example'],
    } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText(
      "Remarks requested. The client admin was notified in-app; email sent to the client's ticket remarks inbox a@deoleo.example, b@deoleo.example, cc c@deoleo.example. ⚠ The mail relay REJECTED b@deoleo.example — they did NOT get the email.",
    )).toBeInTheDocument();
  });

  it('CC_ONLY → "email sent to the client\'s CC list <list> (the client admin has no email address on file)"', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { emailSent: true, emailRecipientKind: 'CC_ONLY', emailRecipient: 'ops@deoleo.example', emailCc: [] } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText(
      "Remarks requested. The client admin was notified in-app; email sent to the client's CC list ops@deoleo.example (the client admin has no email address on file).",
    )).toBeInTheDocument();
  });

  it('every To refused, CC accepted → "NOT delivered to anyone in To … copied to CC only" (no "in-app only")', async () => {
    routeGet({ list: [baseTicket()] });
    const reason = 'the mail relay REJECTED every To address (a@deoleo.example) — NOT delivered to anyone in To; copied to CC only (c@deoleo.example)';
    postMock.mockResolvedValue({ success: true, data: {
      emailSent: false, emailError: reason, emailCcOnlyDelivered: true, emailRecipientKind: 'INBOX',
      emailRecipient: 'a@deoleo.example', emailCc: ['c@deoleo.example'], emailRejected: ['a@deoleo.example'],
    } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText(
      `Remarks requested, but the email was NOT delivered to anyone in To — ${reason}. The client admin was notified in-app.`,
    )).toBeInTheDocument();
  });

  it('ADMIN + CC → "by email (<admin>, cc <list>)"', async () => {
    routeGet({ list: [baseTicket()] });
    postMock.mockResolvedValue({ success: true, data: { emailSent: true, emailRecipientKind: 'ADMIN', emailRecipient: 'ca@deoleo.example', emailCc: ['ops@deoleo.example'] } });
    render(<AdminTicketsPage />);
    await openFirstTicket();
    await ask();
    expect(await screen.findByText('Remarks requested. The client admin was notified in-app and by email (ca@deoleo.example, cc ops@deoleo.example).')).toBeInTheDocument();
  });
});
