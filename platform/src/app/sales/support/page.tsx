'use client';

import React, { useState, useEffect } from 'react';
import {
  Plus, X, ChevronRight, MessageSquare,
  CheckCircle, Search, Building2, Loader2, User,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  type Ticket, type TicketCategory, type TicketPriority, type TicketStatus,
  CATEGORY_LABELS, STATUS_LABELS, PRIORITY_LABELS,
} from '@/lib/tickets';
import { ROLE_NAMES, ROLE_LABELS, getRole, type SalesRole } from '@/lib/sales-role';

/* ─── Outlets (from /api/sales/outlets) ─────────────────────────────────────── */

interface Outlet { id: string; name: string; mobile: string; }

/* ─── DB ↔ local category / status / priority mappings ─────────────────────── */

const CAT_TO_DB: Record<TicketCategory, string> = {
  billing: 'PAYOUT', points: 'POINTS', kyc: 'KYC',
  redemption: 'REDEMPTION', delivery: 'PAYOUT', technical: 'TECHNICAL', other: 'OTHER',
};
const CAT_FROM_DB: Record<string, TicketCategory> = {
  KYC: 'kyc', POINTS: 'points', REDEMPTION: 'redemption',
  PAYOUT: 'billing', SCHEME: 'other', TECHNICAL: 'technical',
  ACCOUNT: 'other', OTHER: 'other',
};
const STATUS_FROM_DB: Record<string, TicketStatus> = {
  OPEN: 'open', IN_PROGRESS: 'in_progress', WAITING: 'waiting',
  RESOLVED: 'resolved', CLOSED: 'closed',
};
const PRIO_FROM_DB: Record<string, TicketPriority> = {
  HIGH: 'high', MEDIUM: 'medium', LOW: 'low',
};

function mapDbTicket(t: any): Ticket {
  return {
    id:              t.id,
    ticketNumber:    t.ticketNumber,
    title:           t.subject,
    description:     t.description,
    category:        CAT_FROM_DB[t.category]  ?? 'other',
    priority:        PRIO_FROM_DB[t.priority] ?? 'medium',
    status:          STATUS_FROM_DB[t.status] ?? 'open',
    source:          'sales',
    outletId:        t.id,
    outletName:      t.createdBy?.name ?? '',
    raisedByName:    t.createdBy?.name ?? '',
    salesPersonName: t.createdBy?.name,
    createdAt:       t.createdAt,
    updatedAt:       t.updatedAt,
    messages:        (t.messages ?? []).map((m: any) => ({
      id:        m.id,
      from:      'sales' as const,
      fromName:  m.sender?.name ?? 'Unknown',
      text:      m.message,
      createdAt: m.createdAt,
    })),
  };
}

/* ─── Config ────────────────────────────────────────────────────────────────── */

const STATUS_STYLE: Record<TicketStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; dot: string }> = {
  open:        { variant: 'warning',  dot: 'bg-amber-400' },
  in_progress: { variant: 'info',     dot: 'bg-blue-400' },
  waiting:     { variant: 'default',  dot: 'bg-gray-400' },
  resolved:    { variant: 'success',  dot: 'bg-emerald-400' },
  closed:      { variant: 'default',  dot: 'bg-gray-300' },
};

const OUTLET_CATEGORIES: { value: TicketCategory; label: string; emoji: string }[] = [
  { value: 'points',     label: 'Points Not Credited',  emoji: '🪙' },
  { value: 'billing',    label: 'Billing Issue',         emoji: '🧾' },
  { value: 'kyc',        label: 'KYC Help',              emoji: '📋' },
  { value: 'redemption', label: 'Redemption Issue',      emoji: '🎁' },
  { value: 'delivery',   label: 'Delivery / Fulfilment', emoji: '📦' },
  { value: 'technical',  label: 'Technical Problem',     emoji: '⚙️' },
  { value: 'other',      label: 'Other',                 emoji: '💬' },
];

const SELF_CATEGORIES: { value: TicketCategory; label: string; emoji: string }[] = [
  { value: 'technical',  label: 'App / System Issue',      emoji: '📱' },
  { value: 'points',     label: 'Target / Scheme Dispute', emoji: '🎯' },
  { value: 'billing',    label: 'Incentive / Payout Query',emoji: '💰' },
  { value: 'delivery',   label: 'Field Tool Problem',       emoji: '🔧' },
  { value: 'kyc',        label: 'Training Request',         emoji: '📚' },
  { value: 'other',      label: 'Other',                    emoji: '💬' },
];

const PRIORITIES: { value: TicketPriority; label: string; color: string }[] = [
  { value: 'high',   label: 'High',   color: 'text-red-600 bg-red-50 border-red-200' },
  { value: 'medium', label: 'Medium', color: 'text-amber-600 bg-amber-50 border-amber-200' },
  { value: 'low',    label: 'Low',    color: 'text-gray-600 bg-gray-50 border-gray-200' },
];

function formatTime(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

/* ─── Ticket detail ──────────────────────────────────────────────────────────── */

function TicketDetail({ ticket, onClose, onReply, myName }: {
  ticket: Ticket;
  onClose: () => void;
  onReply: (id: string, text: string) => void;
  myName: string;
}) {
  const [reply, setReply]     = useState('');
  const [sending, setSending] = useState(false);
  const { variant } = STATUS_STYLE[ticket.status];

  const handleSend = async () => {
    if (!reply.trim()) return;
    setSending(true);
    await new Promise((r) => setTimeout(r, 600));
    onReply(ticket.id, reply.trim());
    setReply('');
    setSending(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-start justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono text-gray-400">{ticket.ticketNumber}</span>
              <Badge variant={variant}>{STATUS_LABELS[ticket.status]}</Badge>
            </div>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">{ticket.title}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {ticket.outletName}
              {ticket.salesPersonName && ` · via ${ticket.salesPersonName}`}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {ticket.messages.map((msg) => {
            const isMe = msg.from === 'sales';
            return (
              <div key={msg.id} className={`flex gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isMe ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]' : msg.from === 'admin' ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'}`}>
                  {msg.fromName.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                </div>
                <div className={`max-w-[75%] flex flex-col gap-0.5 ${isMe ? 'items-end' : 'items-start'}`}>
                  <p className="text-[10px] text-gray-400">{msg.fromName}</p>
                  <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${isMe ? 'bg-[var(--brand-primary)] text-white rounded-tr-sm' : msg.from === 'admin' ? 'bg-blue-50 text-gray-800 rounded-tl-sm' : 'bg-gray-100 text-gray-800 rounded-tl-sm'}`}>
                    {msg.text}
                  </div>
                  <p className="text-[9px] text-gray-300">{formatTime(msg.createdAt)}</p>
                </div>
              </div>
            );
          })}
        </div>

        {ticket.status !== 'closed' && (
          <div className="px-5 py-3 border-t border-gray-100 shrink-0">
            <div className="flex gap-2">
              <textarea
                rows={2}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Add a note or update…"
                className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              />
              <button
                onClick={handleSend}
                disabled={!reply.trim() || sending}
                className="px-3 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 transition-colors flex items-center"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── New ticket form state ─────────────────────────────────────────────────── */

interface NewForm {
  ticketFor: 'outlet' | 'self';
  outletSearch: string;
  outlet: Outlet | null;
  category: TicketCategory | '';
  priority: TicketPriority;
  title: string;
  description: string;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesSupportPage() {
  const [role,       setRoleState] = useState<SalesRole>('SO');
  const [tickets,    setTickets]   = useState<Ticket[]>([]);
  const [outlets,    setOutlets]   = useState<Outlet[]>([]);
  const [loading,    setLoading]   = useState(true);
  const [newOpen,    setNewOpen]   = useState(false);
  const [selected,   setSelected]  = useState<Ticket | null>(null);
  const [submitting, setSubmitting]= useState(false);
  const [form, setForm] = useState<NewForm>({
    ticketFor: 'outlet', outletSearch: '', outlet: null, category: '',
    priority: 'medium', title: '', description: '',
  });

  useEffect(() => {
    setRoleState(getRole());
    const onStorage = () => setRoleState(getRole());
    window.addEventListener('storage', onStorage);

    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/tickets', { headers }).then((r) => r.json()),
      fetch('/api/sales/outlets', { headers }).then((r) => r.json()),
    ]).then(([tBody, oBody]) => {
      if (tBody.success) setTickets((tBody.data.tickets ?? []).map(mapDbTicket));
      if (oBody.success) setOutlets((oBody.data.outlets ?? []).map((o: any) => ({ id: o.id, name: o.name, mobile: o.mobile ?? '' })));
    }).catch(() => {}).finally(() => setLoading(false));

    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const myName   = `${ROLE_NAMES[role]} (${ROLE_LABELS[role]})`;
  const filtered = outlets.filter((o) => o.name.toLowerCase().includes(form.outletSearch.toLowerCase()));

  const isSelf    = form.ticketFor === 'self';
  const canSubmit = !!form.category && !!form.title.trim() && !!form.description.trim() && (isSelf || !!form.outlet);
  const BLANK_FORM: NewForm = { ticketFor: 'outlet', outletSearch: '', outlet: null, category: '', priority: 'medium', title: '', description: '' };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    const outletPrefix = !isSelf && form.outlet ? `[${form.outlet.name}] ` : '';
    const outletDesc   = !isSelf && form.outlet ? `Outlet: ${form.outlet.name} (${form.outlet.mobile})\n\n` : '';
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          category:    CAT_TO_DB[form.category as TicketCategory],
          subject:     `${outletPrefix}${form.title.trim()}`,
          description: `${outletDesc}${form.description.trim()}`,
        }),
      });
      const body = await res.json();
      if (body.success) {
        setTickets((prev) => [mapDbTicket(body.data.ticket), ...prev]);
        setForm(BLANK_FORM);
        setNewOpen(false);
      }
    } catch {}
    setSubmitting(false);
  };

  const handleSelectTicket = async (ticket: Ticket) => {
    setSelected(ticket);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    const res = await fetch(`/api/tickets/${ticket.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (body.success) setSelected(mapDbTicket(body.data.ticket));
  };

  const handleReply = async (ticketId: string, text: string) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    try {
      await fetch(`/api/tickets/${ticketId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text }),
      });
      const res = await fetch(`/api/tickets/${ticketId}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (body.success) {
        const updated = mapDbTicket(body.data.ticket);
        setTickets((prev) => prev.map((t) => (t.id === ticketId ? updated : t)));
        if (selected?.id === ticketId) setSelected(updated);
      }
    } catch {}
  };

  const active = tickets.filter((t) => t.status !== 'resolved' && t.status !== 'closed');
  const done   = tickets.filter((t) => t.status === 'resolved' || t.status === 'closed');

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Support Tickets</h1>
          <p className="text-sm text-gray-500">Raise tickets for outlets or your own issues</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" /> New Ticket
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Active',   value: active.length, color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-100' },
              { label: 'Total',    value: tickets.length,color: 'text-gray-700',    bg: 'bg-gray-50',    border: 'border-gray-100' },
              { label: 'Resolved', value: done.length,   color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
            ].map((s) => (
              <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} p-3 text-center`}>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Active */}
          {active.length > 0 && (
            <Card>
              <div className="px-4 pt-4 pb-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Active Tickets</p>
              </div>
              <CardContent className="pt-2">
                <div className="divide-y divide-gray-50">
                  {active.map((t) => {
                    const { variant, dot } = STATUS_STYLE[t.status];
                    return (
                      <button key={t.id} onClick={() => handleSelectTicket(t)} className="w-full text-left flex items-start gap-3 py-3.5 hover:bg-gray-50 -mx-1 px-1 rounded-xl transition-colors">
                        <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-gray-900 truncate flex-1">{t.title}</p>
                            <Badge variant={variant}>{STATUS_LABELS[t.status]}</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                            {t.outletId === 'self'
                              ? <><User className="h-3 w-3 text-blue-400" /><span className="text-blue-500 font-medium">My Issue</span></>
                              : <><Building2 className="h-3 w-3" /> {t.outletName}</>}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-gray-400">{t.ticketNumber}</span>
                            <span className="text-[10px] text-gray-300">·</span>
                            <span className="text-[10px] text-gray-400">{CATEGORY_LABELS[t.category]}</span>
                            <span className="text-[10px] text-gray-300">·</span>
                            <span className={`text-[10px] font-semibold ${t.priority === 'high' ? 'text-red-500' : t.priority === 'medium' ? 'text-amber-500' : 'text-gray-400'}`}>
                              {PRIORITY_LABELS[t.priority]}
                            </span>
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0 mt-1" />
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Done */}
          {done.length > 0 && (
            <Card>
              <div className="px-4 pt-4 pb-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Resolved / Closed</p>
              </div>
              <CardContent className="pt-2">
                <div className="divide-y divide-gray-50">
                  {done.map((t) => (
                    <button key={t.id} onClick={() => handleSelectTicket(t)} className="w-full text-left flex items-start gap-3 py-3 hover:bg-gray-50 -mx-1 px-1 rounded-xl transition-colors opacity-60">
                      <CheckCircle className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-700 truncate">{t.title}</p>
                        <p className="text-[10px] text-gray-400">{t.outletName} · {t.ticketNumber}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {tickets.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <MessageSquare className="h-10 w-10 text-gray-200" />
              <p className="text-sm font-medium text-gray-400">No tickets raised yet</p>
            </div>
          )}
        </>
      )}

      {/* ── New ticket panel ── */}
      {newOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNewOpen(false)} />
          <div className="relative bg-white rounded-t-2xl max-h-[95vh] flex flex-col">
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
              <h3 className="text-base font-semibold text-gray-900">Raise a Ticket</h3>
              <button onClick={() => setNewOpen(false)} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

              {/* ── For Outlet / For Myself toggle ── */}
              <div className="flex gap-2 p-1 bg-gray-100 rounded-xl">
                {([
                  { val: 'outlet', icon: Building2, label: 'For an Outlet' },
                  { val: 'self',   icon: User,      label: 'My Own Issue'  },
                ] as const).map(({ val, icon: Icon, label }) => (
                  <button
                    key={val}
                    onClick={() => setForm((f) => ({ ...f, ticketFor: val, outlet: null, outletSearch: '', category: '' }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
                      form.ticketFor === val
                        ? 'bg-white text-[var(--brand-primary)] shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
              </div>

              {/* ── Outlet picker (outlet mode only) ── */}
              {form.ticketFor === 'outlet' && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Outlet</label>
                  {form.outlet ? (
                    <div className="flex items-center gap-3 p-3 bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20 rounded-xl">
                      <Building2 className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">{form.outlet.name}</p>
                        <p className="text-xs text-gray-400">{form.outlet.mobile}</p>
                      </div>
                      <button onClick={() => setForm((f) => ({ ...f, outlet: null, outletSearch: '' }))} className="text-gray-400 hover:text-gray-600">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="text"
                          value={form.outletSearch}
                          onChange={(e) => setForm((f) => ({ ...f, outletSearch: e.target.value }))}
                          placeholder="Search outlet name…"
                          className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                        />
                      </div>
                      <div className="space-y-1 max-h-36 overflow-y-auto">
                        {filtered.map((o) => (
                          <button key={o.id} onClick={() => setForm((f) => ({ ...f, outlet: o, outletSearch: '' }))}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 text-left transition-colors border border-transparent hover:border-gray-100">
                            <Building2 className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                            <span className="text-sm text-gray-700">{o.name}</span>
                            <span className="text-xs text-gray-400 ml-auto">{o.mobile}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Self mode info strip ── */}
              {form.ticketFor === 'self' && (
                <div className="flex items-center gap-2.5 p-3 bg-blue-50 border border-blue-100 rounded-xl">
                  <User className="h-4 w-4 text-blue-500 shrink-0" />
                  <p className="text-xs text-blue-700">
                    This ticket will be raised in your name — <strong>{myName}</strong>.
                  </p>
                </div>
              )}

              {/* ── Issue type ── */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Issue Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {(isSelf ? SELF_CATEGORIES : OUTLET_CATEGORIES).map((c) => (
                    <button key={c.value + c.label} onClick={() => setForm((f) => ({ ...f, category: c.value }))}
                      className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all ${form.category === c.value ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5 text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                      <span className="text-base">{c.emoji}</span>
                      <span className="text-xs font-medium leading-tight">{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Priority ── */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Priority</label>
                <div className="flex gap-2">
                  {PRIORITIES.map((p) => (
                    <button key={p.value} onClick={() => setForm((f) => ({ ...f, priority: p.value }))}
                      className={`flex-1 py-2 rounded-xl border text-xs font-semibold transition-all ${form.priority === p.value ? p.color + ' border-current' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Subject ── */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Subject</label>
                <input type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Brief description of the issue…"
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]" />
              </div>

              {/* ── Details ── */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Details</label>
                <textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder={isSelf ? 'Describe your issue, any error messages, dates…' : 'Invoice numbers, dates, what went wrong…'}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]" />
              </div>

              <Button variant="primary" className="w-full" loading={submitting} onClick={handleSubmit} disabled={!canSubmit}>
                Submit Ticket
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail panel ── */}
      {selected && (
        <TicketDetail ticket={selected} onClose={() => setSelected(null)} onReply={handleReply} myName={myName} />
      )}
    </div>
  );
}
