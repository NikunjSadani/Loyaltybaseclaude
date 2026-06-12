'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search, Filter, X, MessageSquare, ChevronDown,
  CheckCircle, Clock, AlertCircle, Building2,
  User, Loader2, Tag, Shield, SlidersHorizontal,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  type Ticket, type TicketStatus, type TicketPriority, type TicketCategory, type TicketSource,
  CATEGORY_LABELS, STATUS_LABELS, PRIORITY_LABELS,
  getAllTickets, updateTicket,
} from '@/lib/tickets';

/* ─── Styles ─────────────────────────────────────────────────────────────────── */

const STATUS_STYLE: Record<TicketStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; dot: string; badge: string }> = {
  open:        { variant: 'warning',  dot: 'bg-amber-400',   badge: 'bg-amber-100 text-amber-700' },
  in_progress: { variant: 'info',     dot: 'bg-blue-400',    badge: 'bg-blue-100 text-blue-700' },
  waiting:     { variant: 'default',  dot: 'bg-gray-400',    badge: 'bg-gray-100 text-gray-600' },
  resolved:    { variant: 'success',  dot: 'bg-emerald-400', badge: 'bg-emerald-100 text-emerald-700' },
  closed:      { variant: 'default',  dot: 'bg-gray-300',    badge: 'bg-gray-50 text-gray-400' },
};

const PRIORITY_STYLE: Record<TicketPriority, string> = {
  high:   'text-red-600 bg-red-50',
  medium: 'text-amber-600 bg-amber-50',
  low:    'text-gray-500 bg-gray-50',
};

const ALL_AGENTS = ['Priya (Admin)', 'Amit (Ops)', 'Tech Team', 'Rohan (Admin)', 'Unassigned'];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}
function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

/* ─── Ticket row ─────────────────────────────────────────────────────────────── */

function TicketRow({ ticket, onClick }: { ticket: Ticket; onClick: () => void }) {
  const { dot } = STATUS_STYLE[ticket.status];
  return (
    <tr onClick={onClick} className="hover:bg-gray-50 cursor-pointer transition-colors border-b border-gray-50 last:border-0">
      <td className="py-3 pl-4 pr-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <div>
            <p className="text-xs font-mono text-gray-400">{ticket.ticketNumber}</p>
            <p className="text-sm font-medium text-gray-900 max-w-[200px] truncate">{ticket.title}</p>
          </div>
        </div>
      </td>
      <td className="py-3 px-2 hidden md:table-cell">
        <p className="text-sm text-gray-700 truncate max-w-[140px]">{ticket.outletName}</p>
        {ticket.salesPersonName && (
          <p className="text-[10px] text-gray-400 truncate">via {ticket.salesPersonName}</p>
        )}
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
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[ticket.status].badge}`}>
          {STATUS_LABELS[ticket.status]}
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

/* ─── Ticket detail panel ────────────────────────────────────────────────────── */

function TicketDetailPanel({ ticket: initial, onClose, onUpdate }: {
  ticket: Ticket;
  onClose: () => void;
  onUpdate: (t: Ticket) => void;
}) {
  const [ticket,  setTicket]  = useState(initial);
  const [reply,   setReply]   = useState('');
  const [isInt,   setIsInt]   = useState(false);
  const [sending, setSending] = useState(false);

  const handleStatusChange = (status: TicketStatus) => {
    const upd = { ...ticket, status, updatedAt: new Date().toISOString() };
    setTicket(upd); updateTicket(upd); onUpdate(upd);
  };

  const handleAssign = (agent: string) => {
    const upd = { ...ticket, assignedTo: agent === 'Unassigned' ? undefined : agent, updatedAt: new Date().toISOString() };
    setTicket(upd); updateTicket(upd); onUpdate(upd);
  };

  const handlePriorityChange = (priority: TicketPriority) => {
    const upd = { ...ticket, priority, updatedAt: new Date().toISOString() };
    setTicket(upd); updateTicket(upd); onUpdate(upd);
  };

  const handleSend = async () => {
    if (!reply.trim()) return;
    setSending(true);
    await new Promise((r) => setTimeout(r, 600));
    const now = new Date().toISOString();
    const msg = { id: `m_${Date.now()}`, from: 'admin' as const, fromName: 'Admin', text: reply.trim(), createdAt: now, isInternal: isInt };
    const upd = { ...ticket, updatedAt: now, messages: [...ticket.messages, msg] };
    setTicket(upd); updateTicket(upd); onUpdate(upd);
    setReply(''); setSending(false);
  };

  const { variant } = STATUS_STYLE[ticket.status];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* Slide-in panel from right */}
      <div className="relative ml-auto bg-white w-full max-w-md h-full flex flex-col shadow-2xl border-l border-gray-100">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-100 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-xs font-mono text-gray-400">{ticket.ticketNumber}</span>
              <Badge variant={variant}>{STATUS_LABELS[ticket.status]}</Badge>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${PRIORITY_STYLE[ticket.priority]}`}>
                {PRIORITY_LABELS[ticket.priority]}
              </span>
            </div>
            <p className="text-sm font-semibold text-gray-900 leading-snug">{ticket.title}</p>
            <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {ticket.outletName}
              {ticket.salesPersonName && <span className="text-gray-300"> · {ticket.salesPersonName}</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3 border-b border-gray-100 shrink-0 space-y-2.5">
          {/* Status */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0">Status</span>
            <div className="flex gap-1.5 flex-wrap">
              {(['open','in_progress','waiting','resolved','closed'] as TicketStatus[]).map((s) => (
                <button key={s} onClick={() => handleStatusChange(s)}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-all ${ticket.status === s ? STATUS_STYLE[s].badge + ' border-current' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Priority */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0">Priority</span>
            <div className="flex gap-1.5">
              {(['high','medium','low'] as TicketPriority[]).map((p) => (
                <button key={p} onClick={() => handlePriorityChange(p)}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-all ${ticket.priority === p ? PRIORITY_STYLE[p] + ' border-current' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {/* Assign */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0">Assign to</span>
            <div className="flex gap-1.5 flex-wrap">
              {ALL_AGENTS.map((a) => {
                const active = (ticket.assignedTo ?? 'Unassigned') === a;
                return (
                  <button key={a} onClick={() => handleAssign(a)}
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full border transition-all ${active ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
                    {a}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <p className="text-[10px] text-gray-400 text-center">{CATEGORY_LABELS[ticket.category]} · Opened {formatDateTime(ticket.createdAt)}</p>
          {ticket.messages.map((msg) => {
            const isAdmin = msg.from === 'admin';
            const isInternal = msg.isInternal;
            return (
              <div key={msg.id} className={`flex gap-2 ${isAdmin ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isAdmin ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]' : msg.from === 'sales' ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-600'}`}>
                  {isAdmin ? 'A' : msg.fromName.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                </div>
                <div className={`max-w-[75%] flex flex-col gap-0.5 ${isAdmin ? 'items-end' : 'items-start'}`}>
                  <div className="flex items-center gap-1.5">
                    <p className="text-[10px] text-gray-400">{msg.fromName}</p>
                    {isInternal && <span className="text-[9px] bg-amber-100 text-amber-600 px-1 rounded font-semibold">Internal</span>}
                  </div>
                  <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${
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

        {/* Reply */}
        <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setIsInt(false)}
              className={`text-xs font-medium px-3 py-1 rounded-full border transition-all ${!isInt ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
              Reply to Outlet
            </button>
            <button onClick={() => setIsInt(true)}
              className={`text-xs font-medium px-3 py-1 rounded-full border transition-all ${isInt ? 'bg-amber-500 text-white border-amber-500' : 'border-gray-200 text-gray-400 hover:border-gray-300'}`}>
              Internal Note
            </button>
          </div>
          <div className="flex gap-2">
            <textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder={isInt ? 'Add internal note (not visible to outlet)…' : 'Type reply to outlet…'}
              className={`flex-1 text-sm border rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 ${isInt ? 'border-amber-200 bg-amber-50 focus:ring-amber-200 focus:border-amber-400' : 'border-gray-200 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]'}`} />
            <button onClick={handleSend} disabled={!reply.trim() || sending}
              className="px-3 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 transition-colors flex items-center shrink-0">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

type FilterState = {
  search: string;
  status: TicketStatus | 'all';
  priority: TicketPriority | 'all';
  category: TicketCategory | 'all';
  source: TicketSource | 'all';
};

export default function AdminTicketsPage() {
  const [tickets,  setTickets]  = useState<Ticket[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [filters,  setFilters]  = useState<FilterState>({
    search: '', status: 'all', priority: 'all', category: 'all', source: 'all',
  });

  useEffect(() => {
    const t = setTimeout(() => { setTickets(getAllTickets()); setLoading(false); }, 400);
    return () => clearTimeout(t);
  }, []);

  const filtered = useMemo(() => {
    return tickets.filter((t) => {
      if (filters.status   !== 'all' && t.status   !== filters.status)   return false;
      if (filters.priority !== 'all' && t.priority !== filters.priority) return false;
      if (filters.category !== 'all' && t.category !== filters.category) return false;
      if (filters.source   !== 'all' && t.source   !== filters.source)   return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        return t.title.toLowerCase().includes(q) || t.outletName.toLowerCase().includes(q) || t.ticketNumber.toLowerCase().includes(q);
      }
      return true;
    });
  }, [tickets, filters]);

  const stats = useMemo(() => ({
    total:       tickets.length,
    open:        tickets.filter((t) => t.status === 'open').length,
    inProgress:  tickets.filter((t) => t.status === 'in_progress').length,
    resolved:    tickets.filter((t) => t.status === 'resolved' || t.status === 'closed').length,
    highPriority:tickets.filter((t) => t.priority === 'high' && t.status !== 'closed' && t.status !== 'resolved').length,
  }), [tickets]);

  const handleUpdate = (upd: Ticket) => {
    setTickets((prev) => prev.map((t) => (t.id === upd.id ? upd : t)));
    if (selected?.id === upd.id) setSelected(upd);
  };

  const setFilter = <K extends keyof FilterState>(key: K, val: FilterState[K]) =>
    setFilters((f) => ({ ...f, [key]: val }));

  const activeFilters = Object.entries(filters).filter(([k, v]) => k !== 'search' && v !== 'all').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ticket Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">All support requests from outlets and sales team</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-64"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Total',        value: stats.total,        color: 'text-gray-700',    bg: 'bg-gray-50',    border: 'border-gray-200' },
              { label: 'Open',         value: stats.open,         color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200' },
              { label: 'In Progress',  value: stats.inProgress,   color: 'text-blue-600',    bg: 'bg-blue-50',    border: 'border-blue-200' },
              { label: 'Resolved',     value: stats.resolved,     color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
              { label: 'High Priority',value: stats.highPriority, color: 'text-red-600',     bg: 'bg-red-50',     border: 'border-red-200' },
            ].map((s) => (
              <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} p-4`}>
                <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-gray-400 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input type="text" value={filters.search} onChange={(e) => setFilter('search', e.target.value)}
                placeholder="Search by ticket number, title, or outlet…"
                className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]" />
            </div>

            {/* Filter chips row */}
            <div className="flex gap-2 flex-wrap items-center">
              <SlidersHorizontal className="h-4 w-4 text-gray-400 shrink-0" />

              {/* Status */}
              <select value={filters.status} onChange={(e) => setFilter('status', e.target.value as TicketStatus | 'all')}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Statuses</option>
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>

              {/* Priority */}
              <select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value as TicketPriority | 'all')}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Priorities</option>
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>

              {/* Category */}
              <select value={filters.category} onChange={(e) => setFilter('category', e.target.value as TicketCategory | 'all')}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Categories</option>
                {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>

              {/* Source */}
              <select value={filters.source} onChange={(e) => setFilter('source', e.target.value as TicketSource | 'all')}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] text-gray-600 bg-white">
                <option value="all">All Sources</option>
                <option value="outlet">Outlet</option>
                <option value="sales">Via Sales Team</option>
              </select>

              {activeFilters > 0 && (
                <button onClick={() => setFilters({ search: '', status: 'all', priority: 'all', category: 'all', source: 'all' })}
                  className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 border border-red-100 bg-red-50 px-2 py-1 rounded-lg transition-colors">
                  <X className="h-3 w-3" /> Clear ({activeFilters})
                </button>
              )}

              <span className="ml-auto text-xs text-gray-400">{filtered.length} ticket{filtered.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          {/* Ticket table */}
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <MessageSquare className="h-10 w-10 text-gray-200" />
                <p className="text-sm text-gray-400">No tickets match the current filters.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="border-b border-gray-100">
                    <tr className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                      <th className="py-3 pl-4 pr-2">Ticket</th>
                      <th className="py-3 px-2 hidden md:table-cell">Outlet</th>
                      <th className="py-3 px-2 hidden lg:table-cell">Category</th>
                      <th className="py-3 px-2">Priority</th>
                      <th className="py-3 px-2">Status</th>
                      <th className="py-3 px-2 hidden sm:table-cell">Assigned</th>
                      <th className="py-3 pl-2 pr-4">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => (
                      <TicketRow key={t.id} ticket={t} onClick={() => setSelected(t)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Detail panel */}
      {selected && (
        <TicketDetailPanel ticket={selected} onClose={() => setSelected(null)} onUpdate={handleUpdate} />
      )}
    </div>
  );
}
