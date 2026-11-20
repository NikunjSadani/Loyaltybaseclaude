'use client';

import React, { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Search, X, MessageSquare,
  CheckCircle, Clock, AlertCircle, Building2,
  Loader2, SlidersHorizontal, UserPlus, Hourglass,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  type Ticket, type TicketMessage, type TicketStatus, type TicketPriority, type TicketCategory,
  CATEGORY_LABELS, STATUS_LABELS, PRIORITY_LABELS,
} from '@/lib/tickets';
import { api } from '@/lib/api-client';
import { useAdminSession } from '@/lib/admin-session';
import { usePermissions } from '@/lib/use-permissions';

/* ─── DB ↔ local category / status / priority mappings ─────────────────────── */

const CAT_FROM_DB: Record<string, TicketCategory> = {
  KYC: 'kyc', POINTS: 'points', REDEMPTION: 'redemption',
  PAYOUT: 'billing', SCHEME: 'other', TECHNICAL: 'technical',
  ACCOUNT: 'other', OTHER: 'other',
};
const STATUS_FROM_DB: Record<string, TicketStatus> = {
  OPEN: 'open', IN_PROGRESS: 'in_progress', PENDING_USER: 'waiting',
  WAITING: 'waiting', ESCALATED: 'in_progress', RESOLVED: 'resolved', CLOSED: 'closed',
  // Waiting on the client admin's remarks — still being worked; shown with its own badge
  // (see statusDisplay) wherever the raw status is known.
  WAITING_ON_CLIENT: 'in_progress',
};
const PRIO_FROM_DB: Record<string, TicketPriority> = {
  CRITICAL: 'high', HIGH: 'high', MEDIUM: 'medium', LOW: 'low',
};

/** The pending "remarks requested from a client admin" marker (Ticket.metadata.clientRemarks). */
interface ClientRemarksRequest {
  requestedFromId: string;
  requestedFromName: string;
  requestedById: string;
  requestedByName: string;
  note: string;
  requestedAt: string;
}

type AdminTicketMessage = TicketMessage & {
  senderRole?: string;
  senderName?: string;
  /** GIFSY_ONLY | SHARED_WITH_CLIENT; null = legacy note (client admins could always read it → "Shared"). */
  internalVisibility?: 'GIFSY_ONLY' | 'SHARED_WITH_CLIENT' | null;
  /** True only for a client admin's reply to a remarks request. */
  isClientRemarks?: boolean;
};

const PARTNER_ROLES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
/** Which side of the thread a message sits on: the outlet owner / a sales rep / the support desk. */
function messageSide(m: any): 'outlet' | 'sales' | 'admin' {
  const kind = m.senderKind as string | undefined;
  const role = String(m.sender?.role ?? '');
  if (kind === 'OUTLET_OWNER' || PARTNER_ROLES.includes(role)) return 'outlet';
  if (kind === 'SALES' || role.startsWith('SALES_')) return 'sales';
  return 'admin';
}

/** Who raised the ticket (server-derived, tickets/ticket-submitter.ts). */
interface RaisedBy { kind: 'OUTLET_OWNER' | 'SALES' | 'STAFF'; name: string; designation: string | null; label: string }
/** The ticket's outlet — stored on the ticket, or the raising owner's primary outlet; null = unknown (—). */
interface TicketOutlet { id: string; outletCode: string; name: string; source: 'TICKET' | 'OWNER_PRIMARY'; ownerOutletCount?: number }

/** The local Ticket plus the admin-only fields this console needs. */
type AdminTicket = Omit<Ticket, 'messages'> & {
  dbStatus: string;
  assignedToId: string | null;
  clientRemarks: ClientRemarksRequest | null;
  raisedBy: RaisedBy | null;
  outlet: TicketOutlet | null;
  messages: AdminTicketMessage[];
};

interface Assignee { id: string; name: string; role: string; kind: 'GIFSY' | 'CLIENT_ADMIN' }

/** Maps an enveloped backend ticket onto the local Ticket shape used by the UI. */
function mapDbTicket(t: any): AdminTicket {
  const remarks = t.metadata?.clientRemarks;
  return {
    id:              t.id,
    ticketNumber:    t.ticketNumber,
    title:           t.subject,
    description:     t.description,
    category:        CAT_FROM_DB[t.category]  ?? 'other',
    priority:        PRIO_FROM_DB[t.priority] ?? 'medium',
    status:          STATUS_FROM_DB[t.status] ?? 'open',
    dbStatus:        t.status ?? 'OPEN',
    source:          'outlet',
    outletId:        t.outlet?.id ?? '',
    outletName:      t.outlet?.name ?? '',
    raisedByName:    t.raisedBy?.label ?? t.createdBy?.name ?? '',
    raisedBy:        t.raisedBy ?? null,
    outlet:          t.outlet ?? null,
    assignedTo:      t.assignedTo?.name,
    assignedToId:    t.assignedTo?.id ?? t.assignedToId ?? null,
    clientRemarks:   t.status === 'WAITING_ON_CLIENT' && remarks && typeof remarks === 'object' ? (remarks as ClientRemarksRequest) : null,
    createdAt:       t.createdAt,
    updatedAt:       t.updatedAt,
    messages:        (t.messages ?? []).map((m: any) => ({
      id:         m.id,
      from:       messageSide(m),
      // Server-derived label: "Outlet owner — <name>", "<name> · <designation>", "<name> · Gifsy support"…
      fromName:   m.senderLabel ?? m.sender?.name ?? 'Unknown',
      senderName: m.sender?.name ?? '',
      text:       m.message,
      createdAt:  m.createdAt,
      isInternal: m.isInternal,
      senderRole: m.sender?.role,
      internalVisibility: m.internalVisibility ?? null,
      isClientRemarks: m.isClientRemarks === true,
    })),
  };
}

/* ─── Styles ─────────────────────────────────────────────────────────────────── */

const STATUS_STYLE: Record<TicketStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; dot: string; badge: string }> = {
  open:        { variant: 'warning',  dot: 'bg-amber-400',   badge: 'bg-amber-100 text-amber-700' },
  in_progress: { variant: 'info',     dot: 'bg-blue-400',    badge: 'bg-blue-100 text-blue-700' },
  waiting:     { variant: 'default',  dot: 'bg-gray-400',    badge: 'bg-gray-100 text-gray-600' },
  resolved:    { variant: 'success',  dot: 'bg-emerald-400', badge: 'bg-emerald-100 text-emerald-700' },
  closed:      { variant: 'default',  dot: 'bg-gray-300',    badge: 'bg-gray-50 text-gray-400' },
};
const AWAITING_STYLE = { variant: 'warning' as const, dot: 'bg-violet-400', badge: 'bg-violet-100 text-violet-700' };

const PRIORITY_STYLE: Record<TicketPriority, string> = {
  high:   'text-red-600 bg-red-50',
  medium: 'text-amber-600 bg-amber-50',
  low:    'text-gray-500 bg-gray-50',
};

/** Status label + style, with the "waiting on client" state called out for admins. */
function statusDisplay(t: AdminTicket, viewerId: string, viewerRole: string) {
  if (t.dbStatus === 'WAITING_ON_CLIENT') {
    const mine = viewerRole === 'CLIENT_ADMIN' && t.clientRemarks?.requestedFromId === viewerId;
    return { label: mine ? 'Awaiting your remarks' : 'Awaiting client', ...AWAITING_STYLE };
  }
  return { label: STATUS_LABELS[t.status], ...STATUS_STYLE[t.status] };
}

/** Tickets per page of the admin list ("Load more" fetches the next page). */
const TICKETS_PAGE_SIZE = 25;

const isGifsyRole = (role: string) => role === 'GIFSY_ADMIN' || role === 'GIFSY_STAFF';

/** "Raised by" line — always says whether it was the outlet owner or a sales person (+ designation). */
function raisedByText(t: AdminTicket): string {
  return t.raisedBy?.label ?? (t.raisedByName || '—');
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: '2-digit' });
}
function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}`;
}

/* ─── Ticket row ─────────────────────────────────────────────────────────────── */

function TicketRow({ ticket, viewerId, viewerRole, onClick }: { ticket: AdminTicket; viewerId: string; viewerRole: string; onClick: () => void }) {
  const st = statusDisplay(ticket, viewerId, viewerRole);
  return (
    <tr
      onClick={onClick}
      // Keyboard-openable; focus returns here when the ticket dialog closes.
      tabIndex={0}
      data-ticket-row={ticket.id}
      aria-label={`Open ticket ${ticket.ticketNumber}: ${ticket.title}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-primary)] cursor-pointer transition-colors border-b border-gray-50 last:border-0">
      <td className="py-3 pl-4 pr-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
          <div>
            <p className="text-xs font-mono text-gray-400">{ticket.ticketNumber}</p>
            <p className="text-sm font-medium text-gray-900 max-w-[200px] truncate">{ticket.title}</p>
          </div>
        </div>
      </td>
      <td className="py-3 px-2 hidden md:table-cell">
        {ticket.outlet ? (
          <>
            <p className="text-sm text-gray-700 truncate max-w-[180px]">{ticket.outlet.name}</p>
            <p className="text-[11px] font-mono text-gray-500">{ticket.outlet.outletCode}</p>
          </>
        ) : (
          <p className="text-sm text-gray-400" title="No outlet is recorded on this ticket">—</p>
        )}
        <p className="text-[10px] text-gray-400 truncate max-w-[200px]">Raised by: {raisedByText(ticket)}</p>
      </td>
      <td className="py-3 px-2 hidden lg:table-cell">
        <span className="text-xs text-gray-500">{CATEGORY_LABELS[ticket.category]}</span>
      </td>
      <td className="py-3 px-2">
        <span className={`inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${PRIORITY_STYLE[ticket.priority]}`}>
          {PRIORITY_LABELS[ticket.priority]}
        </span>
      </td>
      <td className="py-3 px-2">
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${st.badge}`}>
          {st.label}
        </span>
      </td>
      <td className="py-3 px-2 hidden sm:table-cell">
        <p className="text-xs text-gray-400">{ticket.assignedTo ?? '—'}</p>
      </td>
      <td className="py-3 pl-2 pr-4">
        <p className="text-xs text-gray-400">{formatDate(ticket.updatedAt)}</p>
      </td>
    </tr>
  );
}

/* ─── Escalate panel (Gifsy) ─────────────────────────────────────────────────── */

/**
 * Two ways to escalate, one control:
 *  - "Escalate to Gifsy support" → priority bump + ESCALATED + the picked Gifsy user is assigned;
 *  - "Ask client admin for remarks" → WAITING_ON_CLIENT + bell + email to the picked client admin.
 */
function EscalatePanel({ ticketId, assignees, assigneesError, onRetryAssignees, waitingOn, onDone, onCancel, onConflict }: {
  ticketId: string;
  assignees: Assignee[];
  /** The picker options failed to load — show the failure + Retry, never "no users". */
  assigneesError: string | null;
  onRetryAssignees: () => void;
  /** Name of the client admin a pending remarks request is waiting on (escalating cancels it). */
  waitingOn: string | null;
  onDone: (notice: string | null) => void;
  onCancel: () => void;
  /** A 409: the ticket changed meanwhile — the parent reloads it. Typed input is kept here. */
  onConflict: (serverMessage: string) => void;
}) {
  const gifsy = assignees.filter((a) => a.kind === 'GIFSY');
  const clientAdmins = assignees.filter((a) => a.kind === 'CLIENT_ADMIN');
  const [mode, setMode] = useState<'gifsy' | 'client'>('gifsy');
  const [target, setTarget] = useState('');
  const [priority, setPriority] = useState<'HIGH' | 'CRITICAL'>('HIGH');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escalating a ticket that waits on the client cancels that request — confirm first (never silent).
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { setTarget(''); setError(null); setConfirming(false); }, [mode]);

  const options = mode === 'gifsy' ? gifsy : clientAdmins;
  const canSubmit = !!target && !!text.trim() && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    if (mode === 'gifsy' && waitingOn && !confirming) { setConfirming(true); return; }
    setBusy(true); setError(null);
    if (mode === 'gifsy') {
      const res = await api.post<{ cancelledRemarksFrom?: string | null }>(
        `/api/tickets/${ticketId}/escalate`, { escalateTo: target, reason: text.trim(), priority },
      );
      setBusy(false); setConfirming(false);
      if (res.success) {
        onDone(res.data?.cancelledRemarksFrom
          ? `Escalated. The pending request to ${res.data.cancelledRemarksFrom} was cancelled and they were notified.`
          : null);
      } else if (res.status === 409) {
        onConflict(res.error);
      } else {
        setError(res.error);
      }
    } else {
      const res = await api.post<{
        emailSent?: boolean; emailError?: string; alreadyPending?: boolean; message?: string;
        emailRecipientKind?: 'INBOX' | 'ADMIN'; emailRecipient?: string | null;
        emailCc?: string[]; emailRejected?: string[];
      }>(
        `/api/tickets/${ticketId}/request-client-remarks`, { clientAdminId: target, note: text.trim() },
      );
      setBusy(false);
      if (!res.success) { if (res.status === 409) onConflict(res.error); else setError(res.error); return; }
      if (res.data?.alreadyPending) {
        onDone(`${res.data.message ?? 'A remarks request to this client admin is already pending'}. Nothing was re-sent.`);
      } else {
        // Word it from where the email actually went: the client's ticket remarks inbox, or the admin.
        const inbox = res.data?.emailRecipientKind === 'INBOX';
        const cc = res.data?.emailCc?.length ? `, cc ${res.data.emailCc.join(', ')}` : '';
        const where = inbox
          ? `the client's ticket remarks inbox${res.data?.emailRecipient ? ` ${res.data.emailRecipient}` : ''}${cc}`
          : `the client admin${res.data?.emailRecipient ? ` (${res.data.emailRecipient})` : ''}${cc}`;
        // Relay refused some addresses while accepting others — say so loudly, never as a plain success.
        const rejected = res.data?.emailRejected?.length
          ? ` ⚠ The mail relay REJECTED ${res.data.emailRejected.join(', ')} — they did NOT get the email.`
          : '';
        if (res.data?.emailSent === false) {
          onDone(`Remarks requested, but the email to ${where} was NOT sent (${res.data.emailError ?? 'unknown reason'}). The client admin was notified in-app only.`);
        } else if (inbox) {
          onDone(`Remarks requested. The client admin was notified in-app; email sent to ${where}.${rejected}`);
        } else {
          onDone(`Remarks requested. The client admin was notified in-app and by email${res.data?.emailRecipient ? ` (${res.data.emailRecipient}${cc})` : ''}.${rejected}`);
        }
      }
    }
  };

  return (
    <div role="group" aria-label="Escalate ticket" className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2.5">
      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name="esc-mode" checked={mode === 'gifsy'} onChange={() => setMode('gifsy')} />
          Escalate to Gifsy support
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name="esc-mode" checked={mode === 'client'} onChange={() => setMode('client')} />
          Ask client admin for remarks
        </label>
      </div>

      <select
        aria-label={mode === 'gifsy' ? 'Escalate to' : 'Client admin'}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
      >
        <option value="">{mode === 'gifsy' ? 'Choose a Gifsy support user…' : 'Choose a client admin…'}</option>
        {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {assigneesError ? (
        <p role="alert" className="text-[11px] text-red-600 flex items-center gap-2">
          Could not load the people you can pick: {assigneesError}
          <button type="button" className="underline font-semibold" onClick={onRetryAssignees}>Retry</button>
        </p>
      ) : options.length === 0 && (
        <p className="text-[11px] text-amber-700">
          {mode === 'gifsy' ? 'No active Gifsy support users can work on this programme.' : 'This programme has no active client admin.'}
        </p>
      )}

      {mode === 'gifsy' && (
        <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as 'HIGH' | 'CRITICAL')}
          className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
          <option value="HIGH">Priority: High</option>
          <option value="CRITICAL">Priority: Critical</option>
        </select>
      )}

      <textarea
        aria-label={mode === 'gifsy' ? 'Reason' : 'What do you need from the client admin?'}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={mode === 'gifsy' ? 'Why is this being escalated?' : 'What do you need from the client admin? They get this by email and in-app.'}
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none bg-white"
      />
      {mode === 'client' && (
        <p className="text-[11px] text-gray-500">The ticket moves to &quot;Awaiting client&quot;. Their reply is internal — never shown to the outlet or sales team.</p>
      )}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {confirming && waitingOn && (
        <p role="alert" className="text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800">
          This cancels the pending request to {waitingOn} — they&apos;ll be notified. Press &quot;Confirm escalate&quot; to continue.
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" loading={busy} disabled={!canSubmit} onClick={submit}>
          {mode === 'gifsy' ? (confirming ? 'Confirm escalate' : 'Escalate') : 'Send request'}
        </Button>
      </div>
    </div>
  );
}

/* ─── Ticket detail panel ────────────────────────────────────────────────────── */

function TicketDetailPanel({ ticket: initial, viewerRole, viewerId, onClose, onUpdate, onChanged }: {
  ticket: AdminTicket;
  viewerRole: string;
  viewerId: string;
  onClose: () => void;
  onUpdate: (t: AdminTicket) => void;
  /** Something changed that can move list counts (assign / escalate / remarks). */
  onChanged: () => void;
}) {
  const isGifsy = isGifsyRole(viewerRole);
  const isClientAdmin = viewerRole === 'CLIENT_ADMIN';
  const [ticket,        setTicket]        = useState(initial);
  const waiting = ticket.dbStatus === 'WAITING_ON_CLIENT' ? ticket.clientRemarks : null;
  const [reply,         setReply]         = useState('');
  const [isInt,         setIsInt]         = useState(false);
  // Gifsy internal notes: Gifsy-only by default; sharing with the client admin is an explicit choice.
  const [shareNote,     setShareNote]     = useState(false);
  const [cancelBusy,    setCancelBusy]    = useState(false);
  const [sending,       setSending]       = useState(false);
  const [statusBusy,    setStatusBusy]    = useState(false);
  const [assignees,     setAssignees]     = useState<Assignee[]>([]);
  const [assigneesErr,  setAssigneesErr]  = useState<string | null>(null);
  const [assignBusy,    setAssignBusy]    = useState(false);
  const [showEscalate,  setShowEscalate]  = useState(false);
  const [remarks,       setRemarks]       = useState('');
  const [remarksBusy,   setRemarksBusy]   = useState(false);
  const [actionError,   setActionError]   = useState<string | null>(null);
  const [notice,        setNotice]        = useState<string | null>(null);
  // A status change that would cancel a pending remarks request waits for an explicit confirm.
  const [confirmStatus, setConfirmStatus] = useState<'RESOLVED' | 'CLOSED' | null>(null);
  const perms = usePermissions();
  const canEscalate = !isGifsy || perms.has('support:escalate');
  const canWrite = !isGifsy || perms.has('support:write');

  // Keep the panel in sync when the parent loads the full thread via GET :id.
  useEffect(() => { setTicket(initial); }, [initial]);

  /** Refetches the full ticket thread and propagates it to the parent list. */
  const refresh = async () => {
    const res = await api.get<{ ticket: any }>(`/api/tickets/${ticket.id}`);
    if (res.success) {
      const upd = mapDbTicket(res.data.ticket);
      setTicket(upd); onUpdate(upd);
    }
  };

  const loadAssignees = useCallback(() => {
    setAssigneesErr(null);
    api.get<{ assignees: Assignee[] }>(`/api/tickets/${initial.id}/assignees`).then((res) => {
      if (res.success) { setAssignees(res.data.assignees ?? []); setAssigneesErr(null); }
      else setAssigneesErr(res.error);
    });
  }, [initial.id]);

  // Load the full thread when the panel opens; Gifsy also loads the assign/escalate options.
  useEffect(() => {
    void refresh();
    if (isGifsy) loadAssignees();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ticket.id, isGifsy]);

  /**
   * A 409 means someone changed the ticket meanwhile: reload it automatically and say what it is
   * now. Typed text (reply / remarks / escalate form) is never cleared on this path.
   */
  const handleConflict = async (serverMessage: string) => {
    const before = ticket;
    const res = await api.get<{ ticket: any }>(`/api/tickets/${ticket.id}`);
    if (!res.success) { setActionError(serverMessage); return; }
    const upd = mapDbTicket(res.data.ticket);
    setTicket(upd); onUpdate(upd); onChanged();
    const was = statusDisplay(before, viewerId, viewerRole).label;
    const now = statusDisplay(upd, viewerId, viewerRole).label;
    setActionError(
      `This ticket was changed by someone else while you were working${was !== now ? ` (status: ${was} → ${now})` : ''}. ` +
      'It has been reloaded — your text is kept; review it and try again.',
    );
  };
  /** Shared failure handling for every action: 409 → reload + explain; anything else → the error. */
  const failed = async (res: { success: false; error: string; status?: number }) => {
    if (res.status === 409) await handleConflict(res.error); else setActionError(res.error);
  };

  const handleSend = async () => {
    if (!reply.trim()) return;
    setSending(true); setActionError(null);
    const res = await api.post<{ message: any }>(`/api/tickets/${ticket.id}/messages`, {
      message: reply.trim(), isInternal: isInt,
      ...(isInt && isGifsy ? { visibility: shareNote ? 'SHARED_WITH_CLIENT' : 'GIFSY_ONLY' } : {}),
    });
    if (res.success) { setReply(''); await refresh(); } else await failed(res);
    setSending(false);
  };

  // Pick first, then an explicit "Assign" — arrowing through the list never fires a request.
  const [pendingAssignee, setPendingAssignee] = useState<string>(initial.assignedToId ?? '');
  useEffect(() => { setPendingAssignee(ticket.assignedToId ?? ''); }, [ticket.assignedToId]);
  const assignChanged = pendingAssignee !== (ticket.assignedToId ?? '');

  const handleAssign = async () => {
    if (!assignChanged) return;
    setAssignBusy(true); setActionError(null);
    const res = await api.post(`/api/tickets/${ticket.id}/assign`, { assigneeId: pendingAssignee || null });
    if (res.success) { await refresh(); onChanged(); } else await failed(res);
    setAssignBusy(false);
  };

  const handleSetStatus = async (status: 'RESOLVED' | 'CLOSED' | 'IN_PROGRESS', confirmed = false) => {
    // Resolving / closing a ticket that waits on the client cancels that request — confirm first.
    if (waiting && status !== 'IN_PROGRESS' && !confirmed) { setConfirmStatus(status); return; }
    setConfirmStatus(null);
    setStatusBusy(true); setActionError(null);
    const res = await api.post<{ cancelledRemarksFrom?: string | null }>(`/api/tickets/${ticket.id}/status`, { status });
    if (res.success) {
      if (res.data?.cancelledRemarksFrom) {
        setNotice(`The pending request to ${res.data.cancelledRemarksFrom} was cancelled and they were notified.`);
      }
      await refresh(); onChanged();
    } else {
      await failed(res);
    }
    setStatusBusy(false);
  };

  // Gifsy escape hatch: withdraw the remarks request and resume at the pre-request status.
  const handleCancelRequest = async () => {
    setCancelBusy(true); setActionError(null);
    const res = await api.post(`/api/tickets/${ticket.id}/cancel-client-remarks`, {});
    if (res.success) { setNotice('Request cancelled — the client admin was notified and the ticket resumed.'); await refresh(); onChanged(); }
    else await failed(res);
    setCancelBusy(false);
  };

  const handleSendRemarks = async () => {
    if (!remarks.trim()) return;
    setRemarksBusy(true); setActionError(null);
    const res = await api.post(`/api/tickets/${ticket.id}/client-remarks`, { message: remarks.trim() });
    if (res.success) { setRemarks(''); setNotice('Remarks sent to Gifsy support.'); await refresh(); onChanged(); }
    else await failed(res);
    setRemarksBusy(false);
  };

  const isDone = ticket.status === 'resolved' || ticket.status === 'closed';
  const isClosed = ticket.dbStatus === 'CLOSED';
  const st = statusDisplay(ticket, viewerId, viewerRole);
  const waitingOnMe = !!waiting && isClientAdmin && waiting.requestedFromId === viewerId;

  const gifsyOpts = assignees.filter((a) => a.kind === 'GIFSY');
  const clientOpts = assignees.filter((a) => a.kind === 'CLIENT_ADMIN');
  // Keep the current assignee selectable even if they are no longer in the eligible set.
  const currentMissing = !!ticket.assignedToId && !assignees.some((a) => a.id === ticket.assignedToId);

  const outlet = ticket.outlet;
  // Focus restore: Radix returns focus to a Dialog.Trigger, and this dialog is opened from a
  // table row (no Trigger) — so remember what had focus when it opened and return there.
  const [returnFocusTo] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  // Centred dialog (Radix): focus is trapped inside while open, Escape / the overlay / the close
  // button close it, and focus returns to the element that opened it (the ticket row).
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (returnFocusTo && returnFocusTo.isConnected) { returnFocusTo.focus(); return; }
            // The list may have re-rendered after an action — fall back to this ticket's row.
            document.querySelector<HTMLElement>(`[data-ticket-row="${CSS.escape(ticket.id)}"]`)?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[70] -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-w-3xl h-[85vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden focus:outline-none"
        >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-100 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-xs font-mono text-gray-400">{ticket.ticketNumber}</span>
              <Badge variant={st.variant}>{st.label}</Badge>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${PRIORITY_STYLE[ticket.priority]}`}>
                {PRIORITY_LABELS[ticket.priority]}
              </span>
            </div>
            <Dialog.Title className="text-base font-semibold text-gray-900 leading-snug">{ticket.title}</Dialog.Title>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
              <dt className="text-gray-400 flex items-center gap-1"><Building2 className="h-3 w-3" /> Outlet</dt>
              <dd className="text-gray-700" data-testid="ticket-outlet">
                {outlet ? (
                  <>
                    {outlet.name} · <span className="font-mono font-semibold text-gray-900">ID {outlet.outletCode}</span>
                    {outlet.source === 'OWNER_PRIMARY' && (outlet.ownerOutletCount ?? 1) > 1 && (
                      <span className="text-gray-400"> (owner&apos;s primary of {outlet.ownerOutletCount} outlets)</span>
                    )}
                  </>
                ) : (
                  <span className="text-gray-400" title="No outlet is recorded on this ticket">—</span>
                )}
              </dd>
              <dt className="text-gray-400">Raised by</dt>
              <dd className="text-gray-700" data-testid="ticket-raised-by">{raisedByText(ticket)}</dd>
            </dl>
          </div>
          <Dialog.Close aria-label="Close ticket" className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 shrink-0">
            <X className="h-4 w-4" />
          </Dialog.Close>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Awaiting client remarks */}
          {waiting && (
            <section aria-label="Awaiting client remarks" className="mx-5 mt-4 rounded-xl border border-violet-200 bg-violet-50 p-3 space-y-2">
              <p className="text-sm font-semibold text-violet-800 flex items-center gap-1.5">
                <Hourglass className="h-4 w-4" />
                {waitingOnMe
                  ? 'Awaiting your remarks'
                  : viewerRole === 'MIS_USER'
                    ? `Waiting for ${waiting.requestedFromName}'s remarks`
                    : `Awaiting remarks from ${waiting.requestedFromName}`}
              </p>
              <p className="text-xs text-violet-700">
                {waiting.requestedByName} (Gifsy support) asked{waiting.requestedAt ? ` on ${formatDateTime(waiting.requestedAt)}` : ''}:
              </p>
              <p className="text-sm text-violet-900 whitespace-pre-wrap bg-white/70 rounded-lg px-3 py-2 border border-violet-100">{waiting.note}</p>
              {isClientAdmin && (
                <div className="space-y-1.5">
                  <textarea
                    aria-label="Your remarks"
                    rows={3}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Write your remarks for Gifsy support…"
                    className="w-full text-sm border border-violet-200 rounded-lg px-3 py-2 resize-none bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"
                  />
                  <p className="text-[11px] text-violet-700">Visible to Gifsy support and your admin team only — never to the outlet or sales team.</p>
                  <div className="flex justify-end">
                    <Button size="sm" loading={remarksBusy} disabled={!remarks.trim() || remarksBusy} onClick={handleSendRemarks}>
                      Send remarks
                    </Button>
                  </div>
                </div>
              )}
              {isGifsy && canEscalate && (
                <div className="flex justify-end">
                  <Button size="sm" variant="secondary" loading={cancelBusy} onClick={handleCancelRequest}>
                    Cancel request &amp; resume
                  </Button>
                </div>
              )}
            </section>
          )}
          {notice && (
            <p role="status" className="mx-5 mt-3 text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800">{notice}</p>
          )}

          {/* Controls */}
          <div className="px-5 py-3 border-b border-gray-100 space-y-2.5">
            {/* Assigned-to: a picker for Gifsy operators, read-only for everyone else */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-16 shrink-0">Assigned</span>
              {isGifsy ? (
                <div className="flex-1 flex items-center gap-2">
                  <UserPlus className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                  <select
                    aria-label="Assign to"
                    value={pendingAssignee}
                    disabled={assignBusy || isClosed || !canWrite}
                    onChange={(e) => setPendingAssignee(e.target.value)}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white disabled:opacity-50"
                  >
                    <option value="">Unassigned</option>
                    {currentMissing && <option value={ticket.assignedToId!}>{ticket.assignedTo ?? 'Current assignee'}</option>}
                    {gifsyOpts.length > 0 && (
                      <optgroup label="Gifsy support">
                        {gifsyOpts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </optgroup>
                    )}
                    {clientOpts.length > 0 && (
                      <optgroup label="Client admins">
                        {clientOpts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <Button size="sm" variant="secondary" loading={assignBusy} disabled={!assignChanged || assignBusy || isClosed} onClick={handleAssign}>
                    {pendingAssignee ? 'Assign' : 'Unassign'}
                  </Button>
                </div>
              ) : (
                <span className="text-xs font-medium text-gray-700">{ticket.assignedTo ?? 'Unassigned'}</span>
              )}
            </div>
            {isGifsy && assigneesErr && (
              <p role="alert" className="text-[11px] text-red-600 flex items-center gap-2">
                Could not load assignees: {assigneesErr}
                <button type="button" className="underline font-semibold" onClick={loadAssignees}>Retry</button>
              </p>
            )}
            {isGifsy && !canWrite && perms.ready && (
              <p className="text-[11px] text-gray-500">Your Gifsy role does not include support:write — you can view this ticket but not assign it.</p>
            )}

            {/* Status actions — Resolve / Close, or Reopen once done. While Gifsy waits on the client
                desk's remarks, the desk replies first (the server refuses a status change). */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400 w-16 shrink-0">Status</span>
              {waiting && !isGifsy ? (
                <span className="text-xs text-gray-500">
                  {viewerRole === 'MIS_USER'
                    ? `Status changes are paused while Gifsy waits for ${waiting.requestedFromName}'s remarks.`
                    : 'Send your remarks first — status changes are paused while Gifsy waits for them.'}
                </span>
              ) : isDone ? (
                <Button variant="secondary" size="sm" loading={statusBusy} onClick={() => handleSetStatus('IN_PROGRESS')}>
                  <Clock className="h-3.5 w-3.5" /> Reopen
                </Button>
              ) : (
                <>
                  <Button variant="secondary" size="sm" loading={statusBusy} onClick={() => handleSetStatus('RESOLVED')}>
                    <CheckCircle className="h-3.5 w-3.5" /> Mark Resolved
                  </Button>
                  <Button variant="secondary" size="sm" loading={statusBusy} onClick={() => handleSetStatus('CLOSED')}>
                    <X className="h-3.5 w-3.5" /> Close
                  </Button>
                </>
              )}
            </div>
            {confirmStatus && waiting && (
              <div role="alertdialog" aria-label="Confirm cancelling the remarks request" className="rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2">
                <p>
                  {confirmStatus === 'RESOLVED' ? 'Marking this resolved' : 'Closing this ticket'} cancels the pending request to {waiting.requestedFromName} — they&apos;ll be notified.
                </p>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="secondary" onClick={() => setConfirmStatus(null)}>Keep waiting</Button>
                  <Button size="sm" loading={statusBusy} onClick={() => handleSetStatus(confirmStatus, true)}>
                    {confirmStatus === 'RESOLVED' ? 'Resolve & cancel request' : 'Close & cancel request'}
                  </Button>
                </div>
              </div>
            )}

            {/* Escalate — Gifsy operators; no longer needs a prior assignment */}
            {isGifsy && (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 w-16 shrink-0">Actions</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isClosed || showEscalate || !canEscalate}
                    title={!canEscalate ? 'Your Gifsy role does not include support:escalate' : undefined}
                    onClick={() => { setShowEscalate(true); setNotice(null); }}
                  >
                    <AlertCircle className="h-3.5 w-3.5" /> Escalate
                  </Button>
                  {!canEscalate && perms.ready && (
                    <span className="text-[11px] text-gray-500">Your Gifsy role does not include escalation (support:escalate).</span>
                  )}
                </div>
                {showEscalate && canEscalate && (
                  <EscalatePanel
                    ticketId={ticket.id}
                    assignees={assignees}
                    assigneesError={assigneesErr}
                    onRetryAssignees={loadAssignees}
                    waitingOn={waiting ? waiting.requestedFromName : null}
                    onCancel={() => setShowEscalate(false)}
                    onConflict={(m) => { void handleConflict(m); }}
                    onDone={async (n) => { setShowEscalate(false); setNotice(n); await refresh(); onChanged(); }}
                  />
                )}
              </div>
            )}
            {actionError && <p role="alert" className="text-xs text-red-600">{actionError}</p>}
          </div>

          {/* Messages */}
          <div className="px-5 py-4 space-y-4">
            <p className="text-[10px] text-gray-400 text-center">{CATEGORY_LABELS[ticket.category]} · Opened {formatDateTime(ticket.createdAt)}</p>
            {ticket.messages.map((msg) => {
              const isAdmin = msg.from === 'admin';
              const isInternal = msg.isInternal;
              // Only an actual reply to a remarks request — not any client-admin internal note.
              const isClientRemark = isInternal && msg.isClientRemarks === true;
              return (
                <div key={msg.id} className={`flex gap-2 ${isAdmin ? 'flex-row-reverse' : 'flex-row'}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isAdmin ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]' : msg.from === 'sales' ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-600'}`}>
                    {(msg.senderName || msg.fromName).split(' ').map((w) => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || (isAdmin ? 'A' : '?')}
                  </div>
                  <div className={`max-w-[75%] flex flex-col gap-0.5 ${isAdmin ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-1.5">
                      <p className="text-[10px] text-gray-400">{msg.fromName}</p>
                      {isClientRemark
                        ? <span className="text-[9px] bg-violet-100 text-violet-700 px-1 rounded font-semibold">Client remarks</span>
                        : isInternal && (msg.internalVisibility === 'GIFSY_ONLY'
                          ? <span className="text-[9px] bg-gray-800 text-white px-1 rounded font-semibold">Gifsy only</span>
                          : <span className="text-[9px] bg-amber-100 text-amber-700 px-1 rounded font-semibold">Shared with client</span>)}
                    </div>
                    <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      isClientRemark ? 'bg-violet-50 text-violet-900 border border-violet-100 rounded-tr-sm' :
                      isInternal ? 'bg-amber-50 text-amber-900 border border-amber-100 rounded-tr-sm' :
                      isAdmin ? 'bg-[var(--brand-primary)] text-white rounded-tr-sm' :
                      msg.from === 'sales' ? 'bg-orange-50 text-gray-800 rounded-tl-sm' :
                      'bg-gray-100 text-gray-800 rounded-tl-sm'
                    }`}>
                      {msg.text}
                    </div>
                    <p className="text-[9px] text-gray-300">{formatDateTime(msg.createdAt)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Reply — while a ticket waits on the client admin's remarks, their only composer is the
            remarks box (internal); the outlet reply is hidden so remarks can't reach the outlet. */}
        {isClientAdmin && waiting ? (
          <p className="px-5 py-3 border-t border-gray-100 shrink-0 text-xs text-gray-500">
            Use &quot;Send remarks&quot; above — replies to the outlet are paused while Gifsy waits for your remarks.
          </p>
        ) : (
        <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            {/* aria-pressed + a check mark: the selected mode is never conveyed by colour alone */}
            <button type="button" aria-pressed={!isInt} onClick={() => setIsInt(false)}
              className={`text-xs font-medium px-3 py-1 rounded-full border transition-all inline-flex items-center gap-1 ${!isInt ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)] underline underline-offset-2' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
              {!isInt && <CheckCircle aria-hidden className="h-3 w-3" />}Reply to Outlet
            </button>
            <button type="button" aria-pressed={isInt} onClick={() => setIsInt(true)}
              className={`text-xs font-medium px-3 py-1 rounded-full border transition-all inline-flex items-center gap-1 ${isInt ? 'bg-amber-500 text-white border-amber-500 underline underline-offset-2' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
              {isInt && <CheckCircle aria-hidden className="h-3 w-3" />}Internal Note
            </button>
          </div>
          {isInt && isGifsy && (
            <div role="radiogroup" aria-label="Who can read this note" className="flex gap-3 text-[11px] text-gray-600">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="note-vis" checked={!shareNote} onChange={() => setShareNote(false)} /> Gifsy only
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="note-vis" checked={shareNote} onChange={() => setShareNote(true)} /> Share with client admin
              </label>
            </div>
          )}
          {isInt && !isGifsy && (
            <p className="text-[11px] text-gray-500">Internal notes are shared with Gifsy support — never with the outlet or sales team.</p>
          )}
          <div className="flex gap-2">
            <textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
              aria-label="Reply"
              placeholder={isInt ? (isGifsy && !shareNote ? 'Add a Gifsy-only note…' : 'Add internal note (not visible to outlet)…') : 'Type reply to outlet…'}
              className={`flex-1 text-sm border rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 ${isInt ? 'border-amber-200 bg-amber-50 focus:ring-amber-200 focus:border-amber-400' : 'border-gray-200 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]'}`} />
            <button onClick={handleSend} disabled={!reply.trim() || sending}
              className="px-3 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 transition-colors flex items-center shrink-0">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
            </button>
          </div>
        </div>
        )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─── Deep link (?ticket=<id>, e.g. from the bell or the remarks email) ──────── */

function TicketDeepLink({ onOpen }: { onOpen: (id: string) => void }) {
  const params = useSearchParams();
  const id = params?.get('ticket') ?? null;
  useEffect(() => { if (id) onOpen(id); }, [id, onOpen]);
  return null;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

/** Server-side filters (DB values) — they cover EVERY ticket, not just the loaded pages. */
type FilterState = {
  search: string;
  status: string;   // TicketStatus (DB) | 'all'
  priority: 'all' | 'high' | 'medium' | 'low';
  category: string; // TicketCategory (DB) | 'all'
  source: 'all' | 'outlet' | 'sales';
};

const EMPTY_FILTERS: FilterState = { search: '', status: 'all', priority: 'all', category: 'all', source: 'all' };

const DB_STATUS_OPTIONS: [string, string][] = [
  ['OPEN', 'Open'], ['IN_PROGRESS', 'In Progress'], ['ESCALATED', 'Escalated'], ['WAITING_ON_CLIENT', 'Awaiting client'],
  ['PENDING_USER', 'Waiting on Outlet'], ['RESOLVED', 'Resolved'], ['CLOSED', 'Closed'],
];
const DB_CATEGORY_OPTIONS: [string, string][] = [
  ['KYC', 'KYC Help'], ['POINTS', 'Points Not Credited'], ['REDEMPTION', 'Redemption Issue'], ['PAYOUT', 'Billing / Payout'],
  ['SCHEME', 'Scheme'], ['TECHNICAL', 'Technical Problem'], ['ACCOUNT', 'Account'], ['OTHER', 'Other'],
];
const PRIORITY_TO_DB: Record<Exclude<FilterState['priority'], 'all'>, string> = {
  high: 'HIGH,CRITICAL', medium: 'MEDIUM', low: 'LOW',
};

type ListView = 'all' | 'awaitingClient' | 'awaitingMine';
interface Summary { total: number; open: number; inProgress: number; resolved: number; highPriority: number }

/** The list query for a view + filters + page (pure; exported for tests via the URL it builds). */
function listUrl(view: ListView, f: FilterState, page: number): string {
  const p = new URLSearchParams();
  if (view === 'awaitingClient') p.set('status', 'WAITING_ON_CLIENT');
  else if (view === 'awaitingMine') p.set('awaitingMine', 'true');
  else if (f.status !== 'all') p.set('status', f.status);
  if (f.priority !== 'all') p.set('priorities', PRIORITY_TO_DB[f.priority]);
  if (f.category !== 'all') p.set('category', f.category);
  if (f.source !== 'all') p.set('source', f.source);
  if (f.search.trim()) p.set('q', f.search.trim());
  p.set('page', String(page));
  p.set('limit', String(TICKETS_PAGE_SIZE));
  return `/api/tickets?${p.toString()}`;
}

export default function AdminTicketsPage() {
  const session = useAdminSession();
  const isGifsy = isGifsyRole(session.role);
  const isClientAdmin = session.role === 'CLIENT_ADMIN';
  const [tickets,  setTickets]  = useState<AdminTicket[]>([]);
  const [loading,  setLoading]  = useState(true);
  // After the first load, refreshes keep the table mounted (no spinner flash, focus restore works).
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminTicket | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<{ total: number; mine: number }>({ total: 0, mine: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // View + filters + pages loaded live in ONE state: changing the view or a filter resets to page 1
  // in the same update, so the fetch can never combine the new view with an old page count.
  const [query, setQuery] = useState<{ view: ListView; filters: FilterState }>({ view: 'all', filters: EMPTY_FILTERS });
  const { view, filters } = query;
  const awaitingOnly = view !== 'all';
  const [searchDraft, setSearchDraft] = useState('');
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // Request generation: every list (re)load bumps it; a response from an older generation (e.g. a
  // Load-more that was in flight when the search changed) is dropped, never appended.
  const genRef = useRef(0);
  // Pages currently shown — read by reloads (after an action) without being an effect dependency,
  // so "Load more" fetches ONLY the next page.
  const pagesRef = useRef(1);

  // A view / filter change always starts again at page 1 (pagesRef reset in the load effect).
  const setView = (v: ListView | ((cur: ListView) => ListView)) =>
    setQuery((q) => ({ ...q, view: typeof v === 'function' ? v(q.view) : v }));
  const setFilter = <K extends keyof FilterState>(key: K, val: FilterState[K]) =>
    setQuery((q) => ({ ...q, filters: { ...q.filters, [key]: val } }));

  // Debounced server search.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery((q) => (q.filters.search === searchDraft ? q : { ...q, filters: { ...q.filters, search: searchDraft } }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchDraft]);

  type ListRes = {
    tickets: any[]; pagination?: { total: number };
    awaitingClient?: { total: number; mine: number }; summary?: Summary;
  };

  // A view/filter change resets to page 1; a reload after an action (reloadKey) keeps the pages shown.
  const lastQueryRef = useRef(query);
  useEffect(() => {
    if (lastQueryRef.current !== query) { pagesRef.current = 1; lastQueryRef.current = query; }
    const gen = ++genRef.current;
    setLoading(true);
    const pageNums = Array.from({ length: pagesRef.current }, (_, i) => i + 1);
    Promise.all(pageNums.map((p) => api.get<ListRes>(listUrl(view, filters, p)))).then((results) => {
      if (gen !== genRef.current) return; // superseded by a newer load
      const failed = results.find((r) => !r.success);
      if (failed && !failed.success) { setError(failed.error); return; }
      const ok = results.filter((r): r is { success: true; data: ListRes } => r.success);
      const seen = new Set<string>();
      const rows = ok.flatMap((r) => r.data.tickets ?? []).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
      setTickets(rows.map(mapDbTicket));
      const first = ok[0]?.data;
      setTotal(first?.pagination?.total ?? rows.length);
      if (first?.awaitingClient) setAwaiting(first.awaitingClient);
      if (first?.summary) setSummary(first.summary);
      setError(null);
    }).finally(() => { if (gen === genRef.current) { setLoading(false); setLoadedOnce(true); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, reloadKey]);

  /** Fetches ONLY the next page; dropped if the view/filters changed while it was in flight. */
  const loadMore = async () => {
    const gen = genRef.current;
    const next = pagesRef.current + 1;
    setLoadingMore(true);
    const res = await api.get<ListRes>(listUrl(view, filters, next));
    if (gen !== genRef.current) { setLoadingMore(false); return; } // stale: a newer search/view won
    if (res.success) {
      setTickets((prev) => {
        const have = new Set(prev.map((t) => t.id));
        return [...prev, ...(res.data.tickets ?? []).filter((t) => !have.has(t.id)).map(mapDbTicket)];
      });
      if (res.data.pagination?.total != null) setTotal(res.data.pagination.total);
      pagesRef.current = next;
    } else {
      setError(res.error);
    }
    setLoadingMore(false);
  };

  const handleUpdate = (upd: AdminTicket) => {
    setTickets((prev) => prev.map((t) => (t.id === upd.id ? upd : t)));
    setSelected((cur) => (cur?.id === upd.id ? upd : cur));
  };

  const openById = useCallback(async (id: string) => {
    const res = await api.get<{ ticket: any }>(`/api/tickets/${id}`);
    if (res.success) { setDeepLinkError(null); setSelected(mapDbTicket(res.data.ticket)); }
    else setDeepLinkError(
      `Could not open the linked ticket (${res.error}). It may belong to another programme — Gifsy support must switch to the ticket's programme first.`,
    );
  }, []);

  // The dialog loads the full thread itself on open (one GET per open).
  const handleSelectTicket = (ticket: AdminTicket) => { setSelected(ticket); };

  const handleClose = () => {
    setSelected(null);
    // Drop a consumed ?ticket= deep link so the same bell item can open it again later.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ticket')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  };

  const activeFilters = Object.entries(filters).filter(([k, v]) => k !== 'search' && v !== 'all').length;

  // Tenant-wide counts from the server (never "of the loaded page").
  const statCards = [
    { label: 'Total',        value: summary?.total,        color: 'text-gray-700',    bg: 'bg-gray-50',    border: 'border-gray-200' },
    { label: 'Open',         value: summary?.open,         color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200' },
    { label: 'In Progress',  value: summary?.inProgress,   color: 'text-blue-600',    bg: 'bg-blue-50',    border: 'border-blue-200' },
    { label: 'Resolved',     value: summary?.resolved,     color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
    { label: 'High Priority',value: summary?.highPriority, color: 'text-red-600',     bg: 'bg-red-50',     border: 'border-red-200' },
  ];

  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <TicketDeepLink onOpen={openById} />
      </Suspense>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ticket Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">All support requests from outlets and sales team</p>
        </div>
      </div>

      {deepLinkError && (
        <p role="alert" className="text-xs rounded-lg px-3 py-2 bg-red-50 border border-red-200 text-red-700">{deepLinkError}</p>
      )}

      {/* Client admin: tickets waiting on THEIR remarks (shown only when there are some) */}
      {isClientAdmin && awaiting.mine > 0 && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
          <p className="text-sm text-violet-800 flex items-center gap-2">
            <Hourglass className="h-4 w-4" />
            {awaiting.mine} ticket{awaiting.mine !== 1 ? 's' : ''} awaiting your remarks
          </p>
          <Button size="sm" variant="secondary" onClick={() => setView('awaitingMine')}>Show</Button>
        </div>
      )}

      {loading && !loadedOnce && !error ? (
        <div className="flex items-center justify-center min-h-64"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Stats — tenant-wide, from the server */}
          <div className={`grid grid-cols-2 ${isGifsy ? 'md:grid-cols-6' : 'md:grid-cols-5'} gap-3`}>
            {statCards.map((s) => (
              <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} p-4`}>
                <p className={`text-2xl font-bold ${s.color}`} data-testid={`stat-${s.label}`}>{s.value ?? '—'}</p>
                <p className="text-xs text-gray-400 mt-0.5">{s.label}</p>
              </div>
            ))}
            {isGifsy && (
              <button
                type="button"
                aria-label={`Awaiting client: ${awaiting.total}`}
                onClick={() => setView((v) => (v === 'awaitingClient' ? 'all' : 'awaitingClient'))}
                className={`text-left rounded-xl border p-4 transition-colors ${view === 'awaitingClient' ? 'border-violet-400 bg-violet-100' : 'border-violet-200 bg-violet-50 hover:bg-violet-100'}`}
              >
                <p className="text-2xl font-bold text-violet-700">{awaiting.total}</p>
                <p className="text-xs text-gray-400 mt-0.5">Awaiting client</p>
              </button>
            )}
          </div>

          {/* Filters — all applied on the server */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input type="text" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)}
                aria-label="Search tickets"
                placeholder="Search by ticket number, title, raiser, outlet or outlet code…"
                className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]" />
            </div>

            <div className="flex gap-2 flex-wrap items-center">
              <SlidersHorizontal className="h-4 w-4 text-gray-400 shrink-0" />

              {isGifsy && (
                <button
                  type="button"
                  aria-pressed={view === 'awaitingClient'}
                  onClick={() => setView((v) => (v === 'awaitingClient' ? 'all' : 'awaitingClient'))}
                  className={`text-xs border rounded-lg px-2 py-1.5 transition-colors ${view === 'awaitingClient' ? 'bg-violet-600 text-white border-violet-600' : 'border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100'}`}
                >
                  Awaiting client ({awaiting.total})
                </button>
              )}
              {isClientAdmin && view === 'awaitingMine' && (
                <button
                  type="button"
                  aria-pressed
                  onClick={() => setView('all')}
                  className="text-xs border rounded-lg px-2 py-1.5 bg-violet-600 text-white border-violet-600"
                >
                  Awaiting your remarks ({awaiting.mine}) ✕
                </button>
              )}

              <select aria-label="Status" value={filters.status} disabled={awaitingOnly} onChange={(e) => setFilter('status', e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white disabled:opacity-50">
                <option value="all">All Statuses</option>
                {DB_STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>

              <select aria-label="Priority" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value as FilterState['priority'])}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Priorities</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>

              <select aria-label="Category" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Categories</option>
                {DB_CATEGORY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>

              <select aria-label="Source" value={filters.source} onChange={(e) => setFilter('source', e.target.value as FilterState['source'])}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Sources</option>
                <option value="outlet">Outlet owner</option>
                <option value="sales">Via Sales Team</option>
              </select>

              {(activeFilters > 0 || filters.search) && (
                <button onClick={() => { setSearchDraft(''); setQuery((q) => ({ ...q, filters: EMPTY_FILTERS })); }}
                  className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 border border-red-100 bg-red-50 px-2 py-1 rounded-lg transition-colors">
                  <X className="h-3 w-3" /> Clear ({activeFilters + (filters.search ? 1 : 0)})
                </button>
              )}

              <span className="ml-auto text-xs text-gray-400" data-testid="match-count">
                {total} matching ticket{total !== 1 ? 's' : ''}
                {total > tickets.length && <> · showing {tickets.length}</>}
              </span>
            </div>
          </div>

          {/* Ticket table — errors stay inline (filters remain usable; Retry or changing a filter recovers) */}
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden relative" aria-busy={loading}>
            {loading && loadedOnce && (
              <div role="status" className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500 border-b border-gray-100">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating tickets…
              </div>
            )}
            {error ? (
              <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
                <MessageSquare className="h-10 w-10 text-red-200" />
                <p className="text-sm font-medium text-red-500">Could not load tickets</p>
                <p className="text-xs text-gray-400">{error}</p>
                <Button size="sm" variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <MessageSquare className="h-10 w-10 text-gray-200" />
                <p className="text-sm text-gray-400">
                  {view === 'awaitingMine'
                    ? 'No tickets are waiting for your remarks.'
                    : awaitingOnly ? 'No tickets are waiting on the client.' : 'No tickets match the current filters.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="border-b border-gray-100">
                    <tr className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                      <th className="py-3 pl-4 pr-2">Ticket</th>
                      <th className="py-3 px-2 hidden md:table-cell">Outlet / raised by</th>
                      <th className="py-3 px-2 hidden lg:table-cell">Category</th>
                      <th className="py-3 px-2">Priority</th>
                      <th className="py-3 px-2">Status</th>
                      <th className="py-3 px-2 hidden sm:table-cell">Assigned</th>
                      <th className="py-3 pl-2 pr-4">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((t) => (
                      <TicketRow key={t.id} ticket={t} viewerId={session.userId} viewerRole={session.role} onClick={() => handleSelectTicket(t)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!error && total > tickets.length && (
              <div className="flex items-center justify-center gap-3 border-t border-gray-100 py-3">
                <span className="text-xs text-gray-400">Showing {tickets.length} of {total}</span>
                <Button size="sm" variant="secondary" loading={loadingMore} onClick={loadMore}>Load more</Button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Detail panel */}
      {selected && (
        <TicketDetailPanel
          ticket={selected}
          viewerRole={session.role}
          viewerId={session.userId}
          onClose={handleClose}
          onUpdate={handleUpdate}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
