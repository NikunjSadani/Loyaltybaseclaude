export type TicketStatus   = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
export type TicketPriority = 'high' | 'medium' | 'low';
export type TicketCategory = 'billing' | 'points' | 'kyc' | 'redemption' | 'delivery' | 'technical' | 'other';
export type TicketSource   = 'outlet' | 'sales';

export interface TicketMessage {
  id: string;
  from: 'outlet' | 'sales' | 'admin';
  fromName: string;
  text: string;
  createdAt: string;
  isInternal?: boolean;
}

export interface Ticket {
  id: string;
  ticketNumber: string;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  source: TicketSource;
  outletId: string;
  outletName: string;
  raisedByName: string;
  salesPersonName?: string;   // set when source = 'sales'
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
  messages: TicketMessage[];
}

/* ─── Labels ────────────────────────────────────────────────────────────────── */

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  billing:     'Billing Issue',
  points:      'Points Not Credited',
  kyc:         'KYC Help',
  redemption:  'Redemption Issue',
  delivery:    'Delivery / Fulfilment',
  technical:   'Technical Problem',
  other:       'Other',
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open:        'Open',
  in_progress: 'In Progress',
  waiting:     'Waiting on Outlet',
  resolved:    'Resolved',
  closed:      'Closed',
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  high:   'High',
  medium: 'Medium',
  low:    'Low',
};

/* ─── Seed data ─────────────────────────────────────────────────────────────── */

const SEED: Ticket[] = [
  {
    id: 't1', ticketNumber: 'TKT-2026-0001', title: 'Points not credited for invoice #INV-0183',
    description: 'I purchased goods worth ₹42,000 on 10 May but the loyalty points have not appeared in my account yet. Please check.',
    category: 'points', priority: 'high', status: 'in_progress', source: 'outlet',
    outletId: 'k1', outletName: 'Kumar General Store', raisedByName: 'Rajesh Kumar',
    assignedTo: 'Priya (Admin)', createdAt: '2026-05-15T09:20:00', updatedAt: '2026-05-15T14:05:00',
    messages: [
      { id: 'm1', from: 'outlet', fromName: 'Rajesh Kumar', text: 'Points not credited for invoice #INV-0183. Amount was ₹42,000.', createdAt: '2026-05-15T09:20:00' },
      { id: 'm2', from: 'admin', fromName: 'Priya (Admin)', text: 'Hi Rajesh, we have raised this with our billing team. Points will be credited within 24–48 hours.', createdAt: '2026-05-15T14:05:00' },
    ],
  },
  {
    id: 't2', ticketNumber: 'TKT-2026-0002', title: 'KYC rejected — need guidance on re-upload',
    description: 'My KYC was rejected saying GST number mismatch. My GST certificate shows the correct number. Please help.',
    category: 'kyc', priority: 'medium', status: 'open', source: 'sales',
    outletId: 'k3', outletName: 'Patel Grocery', raisedByName: 'Suresh Patel',
    salesPersonName: 'Rajesh Kumar (SO)', createdAt: '2026-05-14T11:30:00', updatedAt: '2026-05-14T11:30:00',
    messages: [
      { id: 'm1', from: 'sales', fromName: 'Rajesh Kumar (SO)', text: 'Raising on behalf of Suresh Patel. KYC was rejected due to GST mismatch but the certificate appears correct. Please review.', createdAt: '2026-05-14T11:30:00' },
    ],
  },
  {
    id: 't3', ticketNumber: 'TKT-2026-0003', title: 'Bluetooth Speaker not delivered after redemption',
    description: 'I redeemed 2500 points for a Bluetooth Speaker on 1st May. It has been 2 weeks and no delivery update.',
    category: 'delivery', priority: 'high', status: 'waiting', source: 'outlet',
    outletId: 'k1', outletName: 'Kumar General Store', raisedByName: 'Rajesh Kumar',
    assignedTo: 'Amit (Ops)', createdAt: '2026-05-13T10:00:00', updatedAt: '2026-05-16T09:00:00',
    messages: [
      { id: 'm1', from: 'outlet', fromName: 'Rajesh Kumar', text: 'Redeemed Bluetooth Speaker on 1st May (RDM-0041). No delivery yet.', createdAt: '2026-05-13T10:00:00' },
      { id: 'm2', from: 'admin', fromName: 'Amit (Ops)', text: 'We have checked with the logistics team. Shipment is in transit, tracking: DL-93847623. Expected delivery in 2–3 business days.', createdAt: '2026-05-14T16:30:00' },
      { id: 'm3', from: 'outlet', fromName: 'Rajesh Kumar', text: 'Tracking number is not showing any updates on the courier website.', createdAt: '2026-05-16T09:00:00' },
    ],
  },
  {
    id: 't4', ticketNumber: 'TKT-2026-0004', title: 'Unable to log in to the app',
    description: 'Sharma Kirana cannot log in. OTP is not being received on the registered number.',
    category: 'technical', priority: 'medium', status: 'resolved', source: 'sales',
    outletId: 'k2', outletName: 'Sharma Kirana', raisedByName: 'Amit Sharma',
    salesPersonName: 'Divya Pillai (ISR)', assignedTo: 'Tech Team',
    createdAt: '2026-05-10T08:45:00', updatedAt: '2026-05-10T13:20:00',
    messages: [
      { id: 'm1', from: 'sales', fromName: 'Divya Pillai (ISR)', text: 'Outlet cannot receive OTP. Mobile number on file is 9765432109.', createdAt: '2026-05-10T08:45:00' },
      { id: 'm2', from: 'admin', fromName: 'Tech Team', text: 'Checked — the number was accidentally marked as DND. Cleared now. Please try again.', createdAt: '2026-05-10T13:20:00' },
      { id: 'm3', from: 'sales', fromName: 'Divya Pillai (ISR)', text: 'Confirmed — outlet is now able to log in. Thank you!', createdAt: '2026-05-10T14:00:00' },
    ],
  },
  {
    id: 't5', ticketNumber: 'TKT-2026-0005', title: 'Target achievement % showing wrong data',
    description: 'My target achievement shows 42% but I have invoices totalling more than 60% of the target for this month.',
    category: 'billing', priority: 'medium', status: 'open', source: 'outlet',
    outletId: 'k2', outletName: 'Sharma Kirana', raisedByName: 'Amit Sharma',
    createdAt: '2026-05-16T07:30:00', updatedAt: '2026-05-16T07:30:00',
    messages: [
      { id: 'm1', from: 'outlet', fromName: 'Amit Sharma', text: 'Dashboard shows 42% target but my invoices add up to more than 60%. Please check April + May billing.', createdAt: '2026-05-16T07:30:00' },
    ],
  },
  {
    id: 't6', ticketNumber: 'TKT-2026-0006', title: 'Scheme bonus points not credited — Platinum scheme',
    description: 'Enrolled in Platinum Volume Bonus scheme. Hit the target in April but 1500 bonus points not added.',
    category: 'points', priority: 'low', status: 'closed', source: 'outlet',
    outletId: 'k4', outletName: 'Singh Supermart', raisedByName: 'Gurpreet Singh',
    assignedTo: 'Priya (Admin)', createdAt: '2026-05-05T12:00:00', updatedAt: '2026-05-08T11:00:00',
    messages: [
      { id: 'm1', from: 'outlet', fromName: 'Gurpreet Singh', text: 'Platinum scheme bonus of 1500 pts not credited for April target.', createdAt: '2026-05-05T12:00:00' },
      { id: 'm2', from: 'admin', fromName: 'Priya (Admin)', text: 'Apologies for the delay. Scheme audit was in progress. Points have been credited — please check your wallet.', createdAt: '2026-05-08T11:00:00', isInternal: false },
      { id: 'm3', from: 'outlet', fromName: 'Gurpreet Singh', text: 'Received. Thank you!', createdAt: '2026-05-08T11:30:00' },
    ],
  },
];

/* ─── localStorage helpers ───────────────────────────────────────────────────── */

const KEY = 'loyaltybase_tickets';

export function getAllTickets(): Ticket[] {
  if (typeof window === 'undefined') return SEED;
  const raw = localStorage.getItem(KEY);
  if (!raw) {
    localStorage.setItem(KEY, JSON.stringify(SEED));
    return SEED;
  }
  try { return JSON.parse(raw) as Ticket[]; } catch { return SEED; }
}

export function saveAllTickets(tickets: Ticket[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(tickets));
}

export function addTicket(ticket: Ticket): void {
  const all = getAllTickets();
  saveAllTickets([ticket, ...all]);
}

export function updateTicket(updated: Ticket): void {
  const all = getAllTickets().map((t) => (t.id === updated.id ? updated : t));
  saveAllTickets(all);
}

export function getNextTicketNumber(): string {
  const all = getAllTickets();
  const max = all.reduce((n, t) => {
    const num = parseInt(t.ticketNumber.split('-')[2] ?? '0', 10);
    return Math.max(n, num);
  }, 0);
  return `TKT-2026-${String(max + 1).padStart(4, '0')}`;
}
