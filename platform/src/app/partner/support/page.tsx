'use client';

import React, { useState, useEffect } from 'react';
import {
  Plus, X, ChevronRight, MessageSquare,
  CheckCircle, Loader2, Phone, User,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  type Ticket, type TicketCategory, type TicketStatus,
  CATEGORY_LABELS, STATUS_LABELS,
  getAllTickets, addTicket, getNextTicketNumber,
} from '@/lib/tickets';

/* ─── Config ────────────────────────────────────────────────────────────────── */

const MY_OUTLET_ID = 'k1';
const MY_NAME      = 'Rajesh Kumar';

/* ─── Sales team contacts (would come from outlet's assigned team in production) */

const SALES_TEAM = [
  { role: 'ISR',            name: 'Anil Sharma',   phone: '9876543210', initials: 'AS', color: 'var(--brand-primary)' },
  { role: 'Sales Officer',  name: 'Rajesh Kumar',  phone: '9765432109', initials: 'RK', color: '#1A1A2E' },
];

const STATUS_STYLE: Record<TicketStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; dot: string }> = {
  open:        { variant: 'warning',  dot: 'bg-amber-400' },
  in_progress: { variant: 'info',     dot: 'bg-blue-400' },
  waiting:     { variant: 'default',  dot: 'bg-gray-400' },
  resolved:    { variant: 'success',  dot: 'bg-emerald-400' },
  closed:      { variant: 'default',  dot: 'bg-gray-300' },
};

const CATEGORIES: { value: TicketCategory; label: string; emoji: string }[] = [
  { value: 'points',     label: 'Points Not Credited',  emoji: '🪙' },
  { value: 'billing',    label: 'Billing Issue',         emoji: '🧾' },
  { value: 'kyc',        label: 'KYC Help',              emoji: '📋' },
  { value: 'redemption', label: 'Redemption Issue',      emoji: '🎁' },
  { value: 'delivery',   label: 'Delivery / Fulfilment', emoji: '📦' },
  { value: 'technical',  label: 'Technical Problem',     emoji: '⚙️' },
  { value: 'other',      label: 'Other',                 emoji: '💬' },
];

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

/* ─── New ticket form ────────────────────────────────────────────────────────── */

interface NewTicketForm {
  category: TicketCategory | '';
  title: string;
  description: string;
}

/* ─── Ticket detail panel ────────────────────────────────────────────────────── */

function TicketDetail({ ticket, onClose, onReply }: {
  ticket: Ticket;
  onClose: () => void;
  onReply: (ticketId: string, text: string) => void;
}) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!reply.trim()) return;
    setSending(true);
    await new Promise((r) => setTimeout(r, 600));
    onReply(ticket.id, reply.trim());
    setReply('');
    setSending(false);
  };

  const { variant } = STATUS_STYLE[ticket.status];

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end lg:justify-center lg:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl lg:rounded-2xl w-full lg:max-w-lg max-h-[90vh] flex flex-col shadow-2xl">
        {/* Handle (mobile) */}
        <div className="flex justify-center pt-3 pb-1 shrink-0 lg:hidden">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono text-gray-400">{ticket.ticketNumber}</span>
              <Badge variant={variant}>{STATUS_LABELS[ticket.status]}</Badge>
            </div>
            <p className="text-sm font-semibold text-gray-900 mt-0.5 leading-snug">{ticket.title}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {ticket.messages.map((msg) => {
            const isMe = msg.from === 'outlet';
            return (
              <div key={msg.id} className={`flex gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isMe ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]' : 'bg-gray-100 text-gray-600'}`}>
                  {msg.fromName.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                </div>
                <div className={`max-w-[75%] ${isMe ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
                  <p className="text-[10px] text-gray-400">{msg.fromName}</p>
                  <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${isMe ? 'bg-[var(--brand-primary)] text-white rounded-tr-sm' : 'bg-gray-100 text-gray-800 rounded-tl-sm'}`}>
                    {msg.text}
                  </div>
                  <p className="text-[9px] text-gray-300">{formatTime(msg.createdAt)}</p>
                </div>
              </div>
            );
          })}
          {(ticket.status === 'resolved' || ticket.status === 'closed') && (
            <div className="flex items-center gap-2 justify-center py-2">
              <CheckCircle className="h-4 w-4 text-emerald-400" />
              <span className="text-xs text-gray-400">Ticket {STATUS_LABELS[ticket.status].toLowerCase()}</span>
            </div>
          )}
        </div>

        {/* Reply box */}
        {ticket.status !== 'closed' && (
          <div className="px-5 py-3 border-t border-gray-100 shrink-0">
            <div className="flex gap-2">
              <textarea
                rows={2}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Type your reply…"
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

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function PartnerSupportPage() {
  const [tickets,    setTickets]    = useState<Ticket[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [newOpen,    setNewOpen]    = useState(false);
  const [selected,   setSelected]   = useState<Ticket | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<NewTicketForm>({ category: '', title: '', description: '' });

  useEffect(() => {
    const t = setTimeout(() => {
      setTickets(getAllTickets().filter((t) => t.outletId === MY_OUTLET_ID));
      setLoading(false);
    }, 350);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = async () => {
    if (!form.category || !form.title.trim() || !form.description.trim()) return;
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 800));

    const now = new Date().toISOString();
    const ticket: Ticket = {
      id:           `t_${Date.now()}`,
      ticketNumber: getNextTicketNumber(),
      title:        form.title.trim(),
      description:  form.description.trim(),
      category:     form.category as TicketCategory,
      priority:     'medium',
      status:       'open',
      source:       'outlet',
      outletId:     MY_OUTLET_ID,
      outletName:   'Kumar General Store',
      raisedByName: MY_NAME,
      createdAt:    now,
      updatedAt:    now,
      messages: [{
        id: 'm1', from: 'outlet', fromName: MY_NAME,
        text: form.description.trim(), createdAt: now,
      }],
    };

    addTicket(ticket);
    setTickets((prev) => [ticket, ...prev]);
    setForm({ category: '', title: '', description: '' });
    setNewOpen(false);
    setSubmitting(false);
  };

  const handleReply = (ticketId: string, text: string) => {
    const now = new Date().toISOString();
    const updated = tickets.map((t) => {
      if (t.id !== ticketId) return t;
      const upd: Ticket = {
        ...t, updatedAt: now,
        messages: [...t.messages, { id: `m_${Date.now()}`, from: 'outlet', fromName: MY_NAME, text, createdAt: now }],
      };
      return upd;
    });
    setTickets(updated);
    if (selected?.id === ticketId) setSelected(updated.find((t) => t.id === ticketId) ?? null);
  };

  const open  = tickets.filter((t) => t.status === 'open' || t.status === 'in_progress' || t.status === 'waiting');
  const done  = tickets.filter((t) => t.status === 'resolved' || t.status === 'closed');

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Support</h1>
          <p className="text-sm text-gray-500">Raise and track your tickets</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" /> New Ticket
        </Button>
      </div>

      {/* ── Your Sales Team ── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-50 flex items-center gap-2">
          <User className="h-4 w-4 text-[var(--brand-primary)]" />
          <p className="text-sm font-bold text-gray-800">Your Sales Team</p>
        </div>
        <div className="divide-y divide-gray-50">
          {SALES_TEAM.map((member) => (
            <div key={member.phone} className="flex items-center gap-3 px-4 py-3.5">
              {/* Avatar */}
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white text-xs font-bold"
                style={{ backgroundColor: member.color }}
              >
                {member.initials}
              </div>

              {/* Info — name, role, and phone number all in the flexible column */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 leading-tight">{member.name}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">{member.role}</p>
                <p className="text-[11px] text-gray-500 font-mono mt-0.5">{member.phone}</p>
              </div>

              {/* Call button — icon only, no phone number text */}
              <a
                href={`tel:${member.phone}`}
                aria-label={`Call ${member.name}`}
                className="w-9 h-9 flex items-center justify-center bg-[var(--brand-primary)]/10 hover:bg-[var(--brand-primary)]/20 text-[var(--brand-primary)] rounded-xl transition-colors shrink-0"
              >
                <Phone className="h-4 w-4" />
              </a>
            </div>
          ))}
        </div>
        <div className="px-4 py-2.5 bg-amber-50/60 border-t border-amber-100">
          <p className="text-[10px] text-amber-700 leading-relaxed">
            💡 Reach out to your ISR or Sales Officer directly for billing queries, scheme clarifications, or any field support.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Open',     value: open.length,     color: 'text-amber-600', bg: 'bg-amber-50',   border: 'border-amber-100' },
              { label: 'Total',    value: tickets.length,  color: 'text-gray-700',  bg: 'bg-gray-50',    border: 'border-gray-100' },
              { label: 'Resolved', value: done.length,     color: 'text-emerald-600',bg: 'bg-emerald-50',border: 'border-emerald-100' },
            ].map((s) => (
              <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} p-3 text-center`}>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Active tickets */}
          {open.length > 0 && (
            <Card>
              <div className="px-4 pt-4 pb-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Active</p>
              </div>
              <CardContent className="pt-2">
                <div className="divide-y divide-gray-50">
                  {open.map((t) => {
                    const { variant, dot } = STATUS_STYLE[t.status];
                    return (
                      <button key={t.id} onClick={() => setSelected(t)} className="w-full text-left flex items-start gap-3 py-3.5 hover:bg-gray-50 rounded-xl transition-colors">
                        <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dot}`} />
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate flex-1 min-w-0">{t.title}</p>
                            <Badge variant={variant} className="shrink-0">{STATUS_LABELS[t.status]}</Badge>
                          </div>
                          <p className="text-[10px] text-gray-400 mt-0.5 truncate">
                            {t.ticketNumber} · {CATEGORY_LABELS[t.category]}
                          </p>
                          <p className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1 min-w-0">
                            <MessageSquare className="h-3 w-3 shrink-0" /> <span className="truncate">{t.messages.length} messages · {formatTime(t.updatedAt)}</span>
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0 mt-1" />
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Resolved tickets */}
          {done.length > 0 && (
            <Card>
              <div className="px-4 pt-4 pb-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Resolved / Closed</p>
              </div>
              <CardContent className="pt-2">
                <div className="divide-y divide-gray-50">
                  {done.map((t) => {
                    const { variant } = STATUS_STYLE[t.status];
                    return (
                      <button key={t.id} onClick={() => setSelected(t)} className="w-full text-left flex items-start gap-3 py-3 hover:bg-gray-50 rounded-xl transition-colors opacity-70">
                        <CheckCircle className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <p className="text-sm text-gray-700 truncate">{t.title}</p>
                          <p className="text-[10px] text-gray-400 truncate">{t.ticketNumber} · {formatTime(t.updatedAt)}</p>
                        </div>
                        <Badge variant={variant} className="shrink-0">{STATUS_LABELS[t.status]}</Badge>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {tickets.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <MessageSquare className="h-10 w-10 text-gray-200" />
              <p className="text-sm font-medium text-gray-400">No tickets yet</p>
              <p className="text-xs text-gray-300">Tap "New Ticket" to get help</p>
            </div>
          )}
        </>
      )}

      {/* ── New ticket slide-up ── */}
      {newOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNewOpen(false)} />
          <div className="relative bg-white rounded-t-2xl max-h-[90vh] flex flex-col">
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
              <h3 className="text-base font-semibold text-gray-900">New Support Ticket</h3>
              <button onClick={() => setNewOpen(false)} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {/* Category */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Issue Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => setForm((f) => ({ ...f, category: c.value }))}
                      className={`flex items-center gap-2 p-3 rounded-xl border text-left transition-all ${
                        form.category === c.value
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5 text-[var(--brand-primary)]'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <span className="text-base">{c.emoji}</span>
                      <span className="text-xs font-medium leading-tight">{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Subject</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Briefly describe your issue…"
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                />
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Details</label>
                <textarea
                  rows={4}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Provide more details — invoice numbers, dates, amounts…"
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                />
              </div>

              <Button
                variant="primary"
                className="w-full"
                loading={submitting}
                onClick={handleSubmit}
                disabled={!form.category || !form.title.trim() || !form.description.trim()}
              >
                Submit Ticket
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Ticket detail ── */}
      {selected && (
        <TicketDetail
          ticket={selected}
          onClose={() => setSelected(null)}
          onReply={handleReply}
        />
      )}
    </div>
  );
}
