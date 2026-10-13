'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  User,
  IdCard,
  MapPin,
  Map,
  Phone,
  LogOut,
  UserCircle,
  LifeBuoy,
  CheckCircle2,
  Send,
  Inbox,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api, authHeader } from '@/lib/api-client';
import { logout } from '@/lib/auth-client';
import { formatISTDate } from '@/lib/ist-date';
import {
  supportTopics,
  ticketStatusMeta,
  mapTicket,
  type EmployeeMe,
  type SupportCategory,
  type ApiSupportTicket,
  type SupportTicket,
} from '../_lib/employee';

const SUBJECT_MAX = 255;

/* ─── REP Profile ─────────────────────────────────────────────────────────────
   Name + Employee Code + region/zone (+ reporting manager) from GET /api/auth/me →
   user.salesUser. Read-only — the rep app does not edit identity. ─────────────── */

interface Profile {
  name: string;
  phone: string;
  employeeCode: string;
  region: string;
  zone: string;
  managerName?: string | null;
  managerDesignation?: string | null;
}

/* ─── Contact Support ───────────────────────────────────────────────────────────
   An employee raises a support query (topic + subject + message) that opens a REAL
   support ticket, and sees their own recent requests + status below. The form offers
   ONLY the backend-allowed topics (supportTopics); submit has an in-flight double-click
   guard; a 400/403 surfaces `result.error` inline; on success it shows the ticket ref
   and re-fetches the list so the new request appears. ──────────────────────────── */
function ContactSupport() {
  const [category, setCategory] = useState<SupportCategory>('POINTS');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [raised, setRaised] = useState<SupportTicket | null>(null);

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const loadTickets = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    const result = await api.get<{ tickets: ApiSupportTicket[] }>('/api/rewards/employee/support');
    setListLoading(false);
    if (!result.success) {
      setListError(result.error || 'Could not load your requests');
      return;
    }
    setTickets((result.data?.tickets ?? []).map(mapTicket));
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const trimmedSubject = subject.trim();
  const trimmedMessage = message.trim();
  const canSubmit =
    trimmedSubject.length > 0 && trimmedSubject.length <= SUBJECT_MAX && trimmedMessage.length > 0;

  const submit = useCallback(async () => {
    if (submitting) return; // double-click guard
    if (!canSubmit) {
      setSubmitError('Add a subject and a message before submitting.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const result = await api.post<{ ticket: ApiSupportTicket }>('/api/rewards/employee/support', {
      category,
      subject: trimmedSubject,
      description: trimmedMessage,
    });
    setSubmitting(false);
    if (!result.success || !result.data?.ticket) {
      setSubmitError(result.success ? 'Could not raise your request. Please try again.' : result.error);
      return;
    }
    setRaised(mapTicket(result.data.ticket));
    // Reset the form and refresh the list so the new ticket shows up.
    setSubject('');
    setMessage('');
    setCategory('POINTS');
    void loadTickets();
  }, [submitting, canSubmit, category, trimmedSubject, trimmedMessage, loadTickets]);

  const raiseAnother = () => {
    setRaised(null);
    setSubmitError(null);
  };

  const fieldClass =
    'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-5 w-5 text-[var(--brand-primary)]" />
        <h2 className="text-base font-bold text-gray-900">Contact Support</h2>
      </div>

      <Card>
        <CardContent className="px-4 py-4">
          {raised ? (
            <div className="flex flex-col items-center text-center py-2 gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900">
                  Request raised — ref {raised.ticketNumber}.
                </p>
                <p className="text-xs text-gray-500 mt-1">Our team will get back to you.</p>
              </div>
              <Button variant="outline" size="sm" onClick={raiseAnother}>
                Raise another request
              </Button>
            </div>
          ) : (
            <div className="space-y-3.5">
              <p className="text-xs text-gray-500 leading-relaxed">
                Have a question or a problem? Raise a request and our team will look into it.
              </p>

              <div>
                <label htmlFor="support-topic" className="block text-xs font-medium text-gray-600 mb-1.5">
                  Topic
                </label>
                <select
                  id="support-topic"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as SupportCategory)}
                  className={fieldClass}
                >
                  {supportTopics.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="support-subject" className="block text-xs font-medium text-gray-600">
                    Subject
                  </label>
                  <span
                    className={
                      'text-[10px] ' +
                      (trimmedSubject.length > SUBJECT_MAX ? 'text-red-500 font-semibold' : 'text-gray-400')
                    }
                  >
                    {trimmedSubject.length}/{SUBJECT_MAX}
                  </span>
                </div>
                <input
                  id="support-subject"
                  type="text"
                  value={subject}
                  maxLength={SUBJECT_MAX}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="A short summary"
                  className={fieldClass}
                />
              </div>

              <div>
                <label htmlFor="support-message" className="block text-xs font-medium text-gray-600 mb-1.5">
                  Message
                </label>
                <textarea
                  id="support-message"
                  value={message}
                  rows={4}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Tell us what happened"
                  className={fieldClass + ' resize-none'}
                />
              </div>

              {submitError && <p className="text-xs text-red-500">{submitError}</p>}

              <Button
                variant="primary"
                className="w-full"
                loading={submitting}
                disabled={!canSubmit || submitting}
                onClick={() => void submit()}
              >
                <Send className="h-4 w-4" /> Submit request
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Your recent requests */}
      <div className="space-y-2.5">
        <h3 className="text-sm font-bold text-gray-900">Your recent requests</h3>
        {listLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : listError ? (
          <div className="text-center py-6">
            <p className="text-sm text-red-500">{listError}</p>
            <button
              type="button"
              onClick={() => void loadTickets()}
              className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Retry
            </button>
          </div>
        ) : tickets.length === 0 ? (
          <Card>
            <CardContent className="px-4 py-8 flex flex-col items-center text-center gap-2">
              <Inbox className="h-7 w-7 text-gray-300" />
              <p className="text-sm text-gray-500">No support requests yet</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="px-0 py-0 divide-y divide-gray-50">
              {tickets.map((t) => {
                const meta = ticketStatusMeta(t.status);
                return (
                  <div key={t.id} className="flex items-start gap-3 px-4 py-3.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{t.subject}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {t.categoryLabel}
                        {t.ticketNumber ? ` · ${t.ticketNumber}` : ''}
                        {t.createdAt ? ` · ${formatISTDate(t.createdAt)}` : ''}
                      </p>
                    </div>
                    <Badge variant={meta.variant} className="shrink-0 mt-0.5">
                      {meta.label}
                    </Badge>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function RepProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: EmployeeMe }) => {
        if (cancelled || !json.success || !json.data) return;
        const u = json.data.user;
        const su = u?.salesUser;
        setProfile({
          name: u?.name ?? '—',
          phone: u?.phone ?? '—',
          employeeCode: su?.employeeCode ?? '—',
          region: su?.region ?? '—',
          zone: su?.zone ?? '—',
          managerName: su?.reportingTo?.name ?? null,
          managerDesignation: su?.reportingTo?.designation ?? null,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const rows = profile
    ? [
        { icon: IdCard, label: 'Employee Code', value: profile.employeeCode },
        { icon: Phone, label: 'Mobile', value: profile.phone },
        { icon: MapPin, label: 'Region', value: profile.region },
        { icon: Map, label: 'Zone', value: profile.zone },
      ]
    : [];

  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-lg font-bold text-gray-900">Profile</h1>

      {/* Identity header */}
      <Card>
        <CardContent className="px-4 py-5 flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
            <UserCircle className="h-8 w-8 text-[var(--brand-primary)]" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-gray-900 truncate">{profile?.name ?? '—'}</p>
            <p className="text-xs text-gray-500 truncate">
              {profile?.employeeCode && profile.employeeCode !== '—'
                ? `Employee · ${profile.employeeCode}`
                : 'Employee'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Detail rows */}
      <Card>
        <CardContent className="px-0 py-0 divide-y divide-gray-50">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                <row.icon className="h-4 w-4 text-gray-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide">{row.label}</p>
                <p className="text-sm font-medium text-gray-800 truncate">{row.value}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Reporting manager */}
      {profile?.managerName && (
        <Card>
          <CardContent className="px-4 py-3.5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
              <User className="h-4 w-4 text-gray-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-gray-400 uppercase tracking-wide">Reporting Manager</p>
              <p className="text-sm font-medium text-gray-800 truncate">
                {profile.managerName}
                {profile.managerDesignation ? ` · ${profile.managerDesignation}` : ''}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contact Support (WS2 Wave 7) */}
      <ContactSupport />

      <Button variant="outline" className="w-full" onClick={() => void logout()}>
        <LogOut className="h-4 w-4" /> Sign Out
      </Button>
    </div>
  );
}
