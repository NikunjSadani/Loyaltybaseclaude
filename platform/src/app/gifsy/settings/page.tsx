'use client';

import { useState, useEffect } from 'react';
import {
  Globe, Shield, Bell, Database, Key, Save, CheckCircle, CreditCard,
  CalendarDays, Mail, Plus, Trash2, Lock,
} from 'lucide-react';
import { getGifsySettings, saveGifsySettings } from '@/lib/gifsy-settings';
import { getStoredUser } from '@/lib/auth-client';
import { fetchHolidays, saveHolidays, type Holiday } from '@/lib/holidays';
import {
  fetchReportRecipients, saveReportRecipients, emailDomain, DEFAULT_ALLOWED_DOMAINS,
  type RecipientsSource, type ReportRecipientsState,
} from '@/lib/report-recipients';

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';
// Read-only variant for the not-yet-wired sections (shows the value, can't edit, no fake Save).
const RO_CLS = INPUT_CLS + ' opacity-50 cursor-not-allowed';

export default function GifsySettingsPage() {
  const [saved,       setSaved]       = useState(false);
  // Redemption threshold state — loaded from persisted settings
  const [minBank,     setMinBank]     = useState(250);
  const [minVoucher,  setMinVoucher]  = useState(250);

  useEffect(() => {
    const s = getGifsySettings();
    setMinBank(s.minBankTransferAmount);
    setMinVoucher(s.minVoucherFreeAmount);
  }, []);

  const flashSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleRedemptionSave = () => {
    saveGifsySettings({ minBankTransferAmount: minBank, minVoucherFreeAmount: minVoucher });
    flashSaved();
  };

  // ── Owner-only gate (mirrors the sibling operator page /gifsy/tds-statutory and the
  // client-page notification-templates editor). The /gifsy shell already routes non-owners away, but the two
  // platform-global cards below WRITE GIFSY_ADMIN-only settings, so resolve the role client-side
  // with a ready gate and only load/edit them for a Gifsy Admin. ──
  const [role, setRole]   = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRole(getStoredUser()?.role ?? null);
    setReady(true);
  }, []);
  const isGifsyAdmin = ready && role === 'GIFSY_ADMIN';

  // ── National holiday calendar (PLATFORM-global; pauses the KYC business-hours SLA clock) ──
  // GET/PUT /api/admin/settings/holidays via fetchHolidays/saveHolidays. Client-side niceties mirror
  // the backend rules (real YYYY-MM-DD date + non-empty label per row, ≤ HOLIDAY_MAX rows) so a save
  // can't surprise the user with a 400. `holidaysLoaded` gates Save so we never PUT before the fetch.
  const HOLIDAY_MAX = 366;
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isValidYmd = (s: string): boolean => {
    if (!YMD_RE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    // Guard against JS date rollover (e.g. 2026-02-30 → Mar 2): round-trip must be identical.
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  const sortHolidays = (list: Holiday[]): Holiday[] =>
    [...list].sort((a, b) => a.date.localeCompare(b.date));

  const [holidays,       setHolidays]       = useState<Holiday[]>([]);
  const [holidaysLoaded, setHolidaysLoaded] = useState(false);
  const [holidaysSaved,  setHolidaysSaved]  = useState(false);
  const [holidaysError,  setHolidaysError]  = useState<string | null>(null);

  useEffect(() => {
    if (!isGifsyAdmin) return;
    fetchHolidays()
      .then((list) => setHolidays(sortHolidays(list)))
      .finally(() => setHolidaysLoaded(true));
  }, [isGifsyAdmin]);

  // Every row must have a valid date and a non-empty (trimmed) label; the list is capped.
  const holidaysValid =
    holidays.length <= HOLIDAY_MAX &&
    holidays.every((h) => isValidYmd(h.date.trim()) && h.label.trim() !== '');

  const updateHoliday = (index: number, field: keyof Holiday, value: string) =>
    setHolidays((prev) => prev.map((h, i) => (i === index ? { ...h, [field]: value } : h)));
  const addHolidayRow = () =>
    setHolidays((prev) => (prev.length >= HOLIDAY_MAX ? prev : [...prev, { date: '', label: '' }]));
  const removeHolidayRow = (index: number) =>
    setHolidays((prev) => prev.filter((_, i) => i !== index));

  const handleHolidaysSave = async () => {
    setHolidaysError(null);
    const cleaned = holidays.map((h) => ({ date: h.date.trim(), label: h.label.trim() }));
    if (cleaned.some((h) => !isValidYmd(h.date) || h.label === '')) {
      setHolidaysError('Every holiday needs a valid date and a non-empty label.');
      return;
    }
    if (cleaned.length > HOLIDAY_MAX) {
      setHolidaysError(`At most ${HOLIDAY_MAX} holidays can be saved.`);
      return;
    }
    const ok = await saveHolidays(cleaned);
    if (!ok) {
      setHolidaysError('Could not save the holiday calendar — please try again.');
      return;
    }
    // Reflect the server's normalisation locally: de-dupe by date (last wins) + sort by date.
    const deduped = Array.from(
      cleaned.reduce((m, h) => m.set(h.date, h), new Map<string, Holiday>()).values(),
    );
    setHolidays(sortHolidays(deduped));
    setHolidaysSaved(true);
    setTimeout(() => setHolidaysSaved(false), 3000);
  };

  // ── Report recipients (the ONE internal Daily Operations Digest list, Mon–Sat) ──
  // GET/PUT /api/admin/settings/report-recipients via fetch/saveReportRecipients. Both GET and PUT
  // are GIFSY_ADMIN-only, so we skip the fetch for anyone else. Save only renders after a SUCCESSFUL
  // load — a failed load shows a red error and no editable list, so we can never PUT an empty list
  // over a list we failed to read. Each row must be a valid email on an allowed (internal) domain —
  // mirrors the backend, which rejects anything else with a 400.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const [dailyDigest,      setDailyDigest]      = useState<string[]>([]);
  const [recipientsLoaded, setRecipientsLoaded] = useState(false);
  const [recipientsLoadError, setRecipientsLoadError] = useState<string | null>(null);
  const [recipientsSource, setRecipientsSource] = useState<RecipientsSource>('none');
  const [allowedDomains,   setAllowedDomains]   = useState<string[]>(DEFAULT_ALLOWED_DOMAINS);
  const [blockedRecipients, setBlockedRecipients] = useState<string[]>([]);
  // How many recipients the server last reported (load or save) — drives the empty-list copy.
  const [serverCount,      setServerCount]      = useState(0);
  const [recipientsSaved,  setRecipientsSaved]  = useState(false);
  const [recipientsError,  setRecipientsError]  = useState<string | null>(null);

  const applyRecipientsState = (s: ReportRecipientsState) => {
    setDailyDigest(s.dailyDigest);
    setRecipientsSource(s.source);
    setAllowedDomains(s.allowedDomains);
    setBlockedRecipients(s.blocked);
    setServerCount(s.dailyDigest.length);
  };

  useEffect(() => {
    if (!isGifsyAdmin) return;
    fetchReportRecipients()
      .then((res) => {
        if (res.ok) applyRecipientsState(res.data);
        else setRecipientsLoadError(res.error);
      })
      .catch((err: unknown) =>
        setRecipientsLoadError(err instanceof Error && err.message ? err.message : 'network error'),
      )
      .finally(() => setRecipientsLoaded(true));
  }, [isGifsyAdmin]);

  const domainRule = allowedDomains.map((d) => `@${d}`).join(', ');
  const blockedSet = new Set(blockedRecipients.map((e) => e.trim().toLowerCase()));
  // Inline per-row error (null = fine, or an empty row which just keeps Save disabled).
  const recipientRowError = (raw: string): string | null => {
    const e = raw.trim();
    if (e === '') return null;
    if (!EMAIL_RE.test(e)) return 'Not a valid email address';
    if (!allowedDomains.includes(emailDomain(e)) || blockedSet.has(e.toLowerCase())) {
      return `Not an internal address — only ${domainRule} is allowed`;
    }
    return null;
  };

  // Every row must be a non-empty, valid, internal email for a save to be allowed.
  const recipientsValid = dailyDigest.every((e) => e.trim() !== '' && recipientRowError(e) === null);

  const updateRecipient = (index: number, value: string) =>
    setDailyDigest(dailyDigest.map((e, i) => (i === index ? value : e)));
  const addRecipientRow = () => setDailyDigest([...dailyDigest, '']);
  const removeRecipientRow = (index: number) => setDailyDigest(dailyDigest.filter((_, i) => i !== index));

  const handleRecipientsSave = async () => {
    setRecipientsError(null);
    if (recipientsLoadError) return; // never overwrite a list we failed to load
    const clean = dailyDigest.map((e) => e.trim());
    if (clean.some((e) => e === '')) {
      setRecipientsError('Every recipient row needs an email address.');
      return;
    }
    const bad = clean.find((e) => recipientRowError(e) !== null);
    if (bad !== undefined) {
      setRecipientsError(`"${bad}": ${recipientRowError(bad)}.`);
      return;
    }
    const res = await saveReportRecipients({ dailyDigest: clean });
    if (!res.ok) {
      setRecipientsError(`Could not save the report recipients — ${res.error}`);
      return;
    }
    applyRecipientsState(res.data);
    setRecipientsSaved(true);
    setTimeout(() => setRecipientsSaved(false), 3000);
  };

  // Truthful empty-list copy: what actually happens to the digest in this state.
  const emptyRecipientsCopy =
    serverCount > 0
      ? 'Unsaved: saving an empty list means nobody gets the digest.'
      : recipientsSource === 'saved'
        ? 'The saved list is empty — nobody gets the digest.'
        : 'No recipients yet — nobody gets the digest until you add one and save.';

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Platform Settings</h1>
          <p className="text-sm text-white/50 mt-0.5">Global configuration for the Gifsy Loyalty Platform</p>
        </div>
        {saved && (
          <span className="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-1.5 rounded-lg">
            <CheckCircle className="w-3.5 h-3.5" />Saved
          </span>
        )}
      </div>

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300">
        <strong>Note:</strong> The minimum bank-transfer and voucher amounts below save to the
        server per tenant and are enforced at redemption. The other sections on this page are
        display-only placeholders and are not yet wired.
      </div>

      {/* Platform identity — read-only until wired (see POST-GO-LIVE-BACKLOG) */}
      <SettingSection icon={Globe} title="Platform Identity">
        <Field label="Platform name">
          <input defaultValue="Gifsy Loyalty Platform" disabled className={RO_CLS} />
        </Field>
        <Field label="Default domain">
          <input defaultValue="gifsy.in" disabled className={RO_CLS + ' font-mono'} />
        </Field>
        <Field label="Support email">
          <input defaultValue="support@gifsy.in" disabled className={RO_CLS} />
        </Field>
        <ReadOnlyNote />
      </SettingSection>

      {/* Security — read-only until wired */}
      <SettingSection icon={Shield} title="Security">
        <Field label="JWT expiry (days)">
          <input type="number" defaultValue={7} disabled className={RO_CLS} />
        </Field>
        <Field label="OTP expiry (minutes)">
          <input type="number" defaultValue={10} disabled className={RO_CLS} />
        </Field>
        <Field label="Max OTP attempts per session">
          <input type="number" defaultValue={3} disabled className={RO_CLS} />
        </Field>
        <ReadOnlyNote />
      </SettingSection>

      {/* Redemption Thresholds */}
      <SettingSection icon={CreditCard} title="Redemption Thresholds">
        <Field label="Minimum bank / DBT transfer amount (₹)">
          <input
            data-testid="settings-min-bank-transfer"
            type="number"
            min={1}
            value={minBank}
            onChange={(e) => setMinBank(Number(e.target.value))}
            className={INPUT_CLS}
          />
        </Field>
        <Field label="Minimum voucher redemption amount (₹)">
          <input
            data-testid="settings-min-voucher"
            type="number"
            min={1}
            value={minVoucher}
            onChange={(e) => setMinVoucher(Number(e.target.value))}
            className={INPUT_CLS}
          />
        </Field>
        <SaveButton data-testid="settings-redemption-save" onClick={handleRedemptionSave} />
      </SettingSection>

      {/* ── Report Recipients (platform-global; internal Gifsy ops distribution list) ── */}
      <SettingSection icon={Mail} title="Report Recipients">
        <div data-testid="report-recipients-card" className="space-y-4">
          <PlatformNote>
            One internal Gifsy distribution list for the Daily Operations Digest (Mon–Sat, 09:30 IST):
            an all-tenant summary plus one section per tenant. Internal Gifsy recipients only — not
            clients. Only a Gifsy Admin can change it.
          </PlatformNote>

          {!isGifsyAdmin ? (
            <GifsyAdminOnlyNote thing="report recipients" />
          ) : !recipientsLoaded ? (
            <p className="text-sm text-white/40">Loading recipients…</p>
          ) : recipientsLoadError ? (
            <p
              data-testid="recipients-load-error"
              role="alert"
              className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
            >
              Couldn&apos;t load the report recipients — {recipientsLoadError}. Reload to try again; saving
              is disabled so the current list isn&apos;t overwritten.
            </p>
          ) : (
            <>
              <div data-testid="recipients-group-dailyDigest">
                <p className="text-xs font-medium text-white/50 mb-1">Daily Operations Digest</p>
                <p data-testid="recipients-domain-rule" className="text-[11px] text-white/40 mb-2">
                  Internal Gifsy addresses only: {domainRule}
                </p>
                {recipientsSource === 'legacy' && (
                  <p
                    data-testid="recipients-inherited"
                    className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1.5 mb-2"
                  >
                    Inherited from the two old daily emails&apos; lists — not saved yet. Review and Save to
                    make this the digest list.
                  </p>
                )}
                {dailyDigest.length === 0 ? (
                  <p className="text-xs text-white/30 italic mb-2">{emptyRecipientsCopy}</p>
                ) : (
                  <div className="space-y-2 mb-2">
                    {dailyDigest.map((email, i) => {
                      const rowError = recipientRowError(email);
                      const errId = `recipient-error-dailyDigest-${i}`;
                      return (
                        <div key={i} data-testid="recipient-row-dailyDigest">
                          <div className="flex items-center gap-2">
                            <input
                              type="email"
                              data-testid="recipient-input-dailyDigest"
                              aria-label="Daily Operations Digest recipient email"
                              aria-invalid={rowError ? true : undefined}
                              aria-describedby={rowError ? errId : undefined}
                              value={email}
                              onChange={(e) => updateRecipient(i, e.target.value)}
                              placeholder="name@gifsy.in"
                              className={INPUT_CLS + (rowError ? ' border-red-500/60' : '')}
                            />
                            <button
                              type="button"
                              aria-label={`Remove ${email || 'recipient'}`}
                              onClick={() => removeRecipientRow(i)}
                              className="text-white/40 hover:text-red-400 transition-colors shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          {rowError && (
                            <p id={errId} data-testid="recipient-error-dailyDigest" className="text-[11px] text-red-400 mt-1">
                              {rowError}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <RowAddButton
                  data-testid="recipient-add-dailyDigest"
                  onClick={addRecipientRow}
                  label="Add recipient"
                />
              </div>
              {recipientsError && <p className="text-xs text-red-400">{recipientsError}</p>}
              <SaveRow
                data-testid="recipients-save"
                onClick={handleRecipientsSave}
                disabled={!recipientsLoaded || !recipientsValid}
                saved={recipientsSaved}
              />
            </>
          )}
        </div>
      </SettingSection>

      {/* ── National Holiday Calendar (platform-global; pauses the KYC-SLA clock) ── */}
      <SettingSection icon={CalendarDays} title="National Holiday Calendar">
        <div data-testid="holiday-calendar-card" className="space-y-4">
          <PlatformNote>
            Dates here pause the KYC review-SLA clock. Weekends (Sat/Sun) are always excluded
            automatically; this calendar adds national holidays on top. Applies to all tenants —
            only a Gifsy Admin can change it.
          </PlatformNote>

          {!isGifsyAdmin ? (
            <GifsyAdminOnlyNote thing="the holiday calendar" />
          ) : !holidaysLoaded ? (
            <p className="text-sm text-white/40">Loading holidays…</p>
          ) : (
            <>
              {holidays.length === 0 ? (
                <p className="text-xs text-white/30 italic mb-2">No holidays yet — add one below.</p>
              ) : (
                <div className="space-y-2 mb-2">
                  {holidays.map((h, i) => (
                    <div key={i} data-testid="holiday-row" className="flex items-center gap-2">
                      <input
                        type="date"
                        data-testid="holiday-date-input"
                        aria-label="Holiday date"
                        value={h.date}
                        onChange={(e) => updateHoliday(i, 'date', e.target.value)}
                        className={INPUT_CLS + ' w-auto [color-scheme:dark]'}
                      />
                      <input
                        type="text"
                        data-testid="holiday-label-input"
                        aria-label="Holiday name"
                        value={h.label}
                        onChange={(e) => updateHoliday(i, 'label', e.target.value)}
                        placeholder="Holiday name (e.g. Republic Day)"
                        className={INPUT_CLS + ' flex-1'}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${h.label || 'holiday'}`}
                        onClick={() => removeHolidayRow(i)}
                        className="text-white/40 hover:text-red-400 transition-colors shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <RowAddButton
                data-testid="holiday-add"
                onClick={addHolidayRow}
                disabled={holidays.length >= HOLIDAY_MAX}
                label="Add holiday"
              />
              {holidaysError && <p className="text-xs text-red-400">{holidaysError}</p>}
              <SaveRow
                data-testid="holiday-save"
                onClick={handleHolidaysSave}
                disabled={!holidaysLoaded || !holidaysValid}
                saved={holidaysSaved}
              />
            </>
          )}
        </div>
      </SettingSection>

      {/* Notifications — read-only until wired */}
      <SettingSection icon={Bell} title="Platform Notifications">
        <Field label="Platform alert email (for GIFSY_ADMIN)">
          <input defaultValue="alerts@gifsy.in" disabled className={RO_CLS} />
        </Field>
        <Field label="SLA breach alert threshold (hours)">
          <input type="number" defaultValue={48} disabled className={RO_CLS} />
        </Field>
        <ReadOnlyNote />
      </SettingSection>

      {/* DB — read-only until wired */}
      <SettingSection icon={Database} title="Data Retention">
        <Field label="Audit log retention (days)">
          <input type="number" defaultValue={365} disabled className={RO_CLS} />
        </Field>
        <Field label="Notification queue retention (days)">
          <input type="number" defaultValue={30} disabled className={RO_CLS} />
        </Field>
        <ReadOnlyNote />
      </SettingSection>

      {/* Environment info */}
      <SettingSection icon={Key} title="Environment">
        <div className="space-y-2">
          {[
            { key: 'NODE_ENV',              value: 'development' },
            { key: 'DATABASE_URL',           value: '•••••••••••••••• (set in env)' },
            { key: 'JWT_SECRET',             value: '•••••••••••••••• (set in env)' },
            { key: 'DEOLEO_MSG91_AUTH_KEY',  value: '•••••••••••••••• (set in env)' },
          ].map(({ key, value }) => (
            <div key={key} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 border border-white/5">
              <span className="text-xs font-mono text-white/60">{key}</span>
              <span className="text-xs font-mono text-white/30">{value}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-white/30 mt-2">Env vars are read-only. Update them in your deployment environment.</p>
      </SettingSection>
    </div>
  );
}

function SettingSection({
  icon: Icon, title, children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2.5">
        <Icon className="w-4 h-4 text-white/50" />
        <span className="text-sm font-semibold text-white">{title}</span>
      </div>
      <div className="px-5 py-5 space-y-4">
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-white/50 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function ReadOnlyNote() {
  return (
    <p className="text-[11px] text-white/30 pt-1">
      Display only — managed in deployment config. Not editable here yet.
    </p>
  );
}

function PlatformNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[11px] text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2">
      <Globe className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>
        <strong className="font-semibold">Platform-wide · applies to all tenants.</strong> {children}
      </span>
    </div>
  );
}

function GifsyAdminOnlyNote({ thing }: { thing: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-white/40">
      <Lock className="w-3.5 h-3.5" />
      Only a Gifsy Admin can view or change {thing}.
    </p>
  );
}

function RowAddButton({
  onClick, label, disabled, 'data-testid': testId,
}: { onClick: () => void; label: string; disabled?: boolean; 'data-testid'?: string }) {
  return (
    <button
      data-testid={testId}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <Plus className="w-3.5 h-3.5" />{label}
    </button>
  );
}

function SaveRow({
  onClick, disabled, saved, 'data-testid': testId,
}: { onClick: () => void; disabled?: boolean; saved?: boolean; 'data-testid'?: string }) {
  return (
    <div className="pt-1">
      <button
        data-testid={testId}
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-all ${
          saved
            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
            : 'bg-[var(--brand-primary)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed'
        }`}
      >
        {saved ? <><CheckCircle className="w-3.5 h-3.5" />Saved</> : <><Save className="w-3.5 h-3.5" />Save</>}
      </button>
    </div>
  );
}

function SaveButton({ onClick, 'data-testid': testId }: { onClick: () => void; 'data-testid'?: string }) {
  return (
    <div className="pt-1">
      <button
        data-testid={testId}
        onClick={onClick}
        className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity"
      >
        <Save className="w-3.5 h-3.5" />Save Section
      </button>
    </div>
  );
}
