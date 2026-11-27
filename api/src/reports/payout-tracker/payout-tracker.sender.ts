/**
 * PayoutTrackerSender — the scheduled (and manual) delivery of the payout-tracker email (xlsx attached).
 *
 * INERT unless a tenant has ProgramSetting(clientId, 'payoutTracker') with `enabled: true` (Deoleo: no row ⇒ never
 * read beyond the one findMany, never a run row, never an email).
 *
 * runDue(now) — called by the Cloud Scheduler endpoint every ~15 min. Per enabled tenant:
 *   due = today (IST) is a configured ISO weekday AND now (IST) ≥ sendTimeIst.
 *   Client inactive / missing → FAILED outcome + ONE ops alert a day (marker row 'payout-tracker-blocked').
 *   Environment guard off (no PAYOUT_TRACKER_EMAIL_LIVE / test recipient) → ONE ops alert a day, the day is NOT
 *   claimed — the report still goes on the first scheduler hit after the environment is fixed.
 *   Otherwise CLAIM the day by inserting TenantReportRun(clientId, 'payout-tracker', runDate) as PENDING — the unique
 *   key makes a second concurrent scheduler hit lose the claim, so the email can never go twice. Then:
 *     holiday + sendOnHolidays=false → SKIPPED ·
 *     month = current IST month, or the previous month when the current one has no applied sales yet →
 *     buildInput → generateTrackerPack → send (html + text + xlsx) → SENT → (data notes?) ops heads-up email.
 *   ANY failure → FAILED with the error + a loud alert email to the Gifsy ops (digest) recipients. A FAILED day is
 *   retried on the next scheduler hits up to MAX_ATTEMPTS in total (each failure alerts) — EXCEPT failures where the
 *   email may already have gone (SMTP lost after DATA, recording SENT failed, stale PENDING): those are never retried.
 *
 * sendNow(clientId, month, recipients?, now?) — manual / test send. The tenant must have a valid ENABLED config and an
 * active client. Explicit recipients must each be internal (REPORTS_RECIPIENT_DOMAINS), or — ONLY when
 * PAYOUT_TRACKER_EMAIL_LIVE=true — one of the tenant's configured recipients; anything else is a 400. Without explicit
 * recipients the SAME environment guard as the schedule applies (live → configured to/cc; test → the test recipient
 * with the real ones named in the subject; off / invalid test recipient → refused + ops alert). Every send writes a 'payout-tracker-manual' run row (runDate = IST timestamp)
 * so resends are traceable; it never touches the scheduled day. Throws on failure — the caller sees the error.
 */
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Msg91Service, type SendEmailResult } from '../../notifications/msg91.service';
import { loadHolidaySet } from '../../common/holiday-calendar';
import { allowedRecipientDomains, isAllowedRecipient, loadReportRecipients, splitRecipientsByDomain } from '../../common/report-recipients';
import { IST_OFFSET_MIN, istMonthKey } from '../../common/ist-date';
import { shiftMonthKey } from '../../sales-import/months/month-state';
import { esc } from '../scheduled/email-html';
import { generateTrackerPack, type TrackerPack } from './payout-tracker.generate';
import { noteList, type TrackerInput, type TrackerNote } from './payout-tracker.types';
import {
  PAYOUT_TRACKER_BLOCKED_REPORT_KEY,
  PAYOUT_TRACKER_MANUAL_REPORT_KEY,
  PAYOUT_TRACKER_REPORT_KEY,
  PAYOUT_TRACKER_SETTING_KEY,
  parsePayoutTrackerConfig,
  payoutTrackerEmailTarget,
  validateRecipientList,
  type PayoutTrackerConfig,
} from './payout-tracker.config';

/** DI token for the data loader (PayoutTrackerDataService.buildInput) — keeps this service testable in isolation. */
export const PAYOUT_TRACKER_INPUT_SOURCE = Symbol('PAYOUT_TRACKER_INPUT_SOURCE');
export interface TrackerInputSource {
  buildInput(clientId: string, month: string, now: Date): Promise<TrackerInput>;
}

export const MAX_ATTEMPTS = 3;
export const STALE_PENDING_MS = 30 * 60 * 1000;
/** Used only when the ops digest recipient list is empty — same legacy fallback as the credits notifications. */
export const OPS_ALERT_FALLBACK = 'ops@gifsy.in';
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type TenantRunStatus = 'sent' | 'failed' | 'skipped' | 'not-due' | 'already-done';
export interface TenantRunOutcome {
  clientId: string;
  status: TenantRunStatus;
  month?: string;
  error?: string;
  recipients?: string[];
  alertError?: string;
  /** Data-loader notes (outlets left off / not computed) — also printed in the workbook + email, and sent to ops. */
  notes?: string[];
}

export interface SendNowResult {
  month: string;
  to: string[];
  cc: string[];
  subject: string;
  fileName: string;
  rejected: string[];
  notes: string[];
  /** The manual run row id (traceability). */
  runId: string;
  /** Set when something AFTER the send went wrong (heads-up / run row) — the email itself went. */
  warning?: string;
}

/** ALL notes (client + ops) — the ops heads-up gets everything. */
function notesOf(input: TrackerInput): TrackerNote[] {
  return noteList((input as Partial<TrackerInput> | undefined)?.notes);
}
const texts = (notes: TrackerNote[]) => notes.map((n) => n.text);

/** IST wall-clock parts of an instant. */
export function istParts(now: Date): { date: string; isoWeekday: number; hhmm: string } {
  const s = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const dow = s.getUTCDay();
  return {
    date: `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`,
    isoWeekday: dow === 0 ? 7 : dow,
    hhmm: `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`,
  };
}

/** 'YYYY-MM-DD HH:mm:ss.SSS IST' — the runDate of a manual send-now row. */
export function istStamp(now: Date): string {
  const s = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const { date, hhmm } = istParts(now);
  return `${date} ${hhmm}:${String(s.getUTCSeconds()).padStart(2, '0')}.${String(s.getUTCMilliseconds()).padStart(3, '0')} IST`;
}

class RunFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly month?: string,
    readonly alertSubject?: string,
  ) {
    super(message);
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class PayoutTrackerSender {
  private readonly logger = new Logger(PayoutTrackerSender.name);
  /** Overridable in specs. */
  env: NodeJS.ProcessEnv = process.env;
  generate: (input: TrackerInput, at: Date) => Promise<TrackerPack> = generateTrackerPack;

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
    @Inject(PAYOUT_TRACKER_INPUT_SOURCE) private readonly source: TrackerInputSource,
  ) {}

  async runDue(now: Date): Promise<{ runDate: string; outcomes: TenantRunOutcome[] }> {
    const { date: runDate } = istParts(now);
    const settings = await this.prisma.programSetting.findMany({
      where: { settingKey: PAYOUT_TRACKER_SETTING_KEY },
      select: { clientId: true, settingValue: true },
    });
    const candidates = settings
      .map((s) => ({ clientId: s.clientId, parsed: parsePayoutTrackerConfig(s.settingValue) }))
      .filter((c) => c.parsed.kind !== 'off');
    if (candidates.length === 0) return { runDate, outcomes: [] };

    const clients = await this.prisma.client.findMany({
      where: { id: { in: candidates.map((c) => c.clientId) } },
      select: { id: true, status: true, internalName: true },
    });
    const byId = new Map(clients.map((c) => [c.id, c]));
    let holidays: Set<string> | null = null;
    const outcomes: TenantRunOutcome[] = [];

    for (const c of candidates) {
      const client = byId.get(c.clientId);
      const name = client?.internalName || c.clientId;
      const config = c.parsed.kind === 'on' ? c.parsed.config : null;
      try {
        if (!client || client.status === 'INACTIVE') {
          outcomes.push(await this.blockedClient(c.clientId, name, client ? 'INACTIVE' : 'missing', config, now, runDate));
          continue;
        }
        if (c.parsed.kind === 'invalid') {
          // Unknown schedule → evaluated on the default schedule so a broken config is reported once a day, loudly.
          outcomes.push(await this.runTenant(c.clientId, name, null, c.parsed.error, now, runDate, () => holidays));
        } else if (config) {
          if (!config.sendOnHolidays && holidays === null) holidays = await loadHolidaySet(this.prisma);
          outcomes.push(await this.runTenant(c.clientId, name, config, null, now, runDate, () => holidays));
        }
      } catch (e) {
        // Last-resort guard (e.g. the claim insert itself failed): never let one tenant stop the others, never silent.
        const error = (e as Error)?.message ?? String(e);
        this.logger.error(`payout-tracker: ${c.clientId} run crashed: ${error}`);
        const alertError = await this.alert(name, c.clientId, runDate, error);
        outcomes.push({ clientId: c.clientId, status: 'failed', error, ...(alertError ? { alertError } : {}) });
      }
    }
    return { runDate, outcomes };
  }

  private isDue(config: PayoutTrackerConfig | null, now: Date): boolean {
    const ist = istParts(now);
    const days = config?.days ?? [1, 2, 3, 4, 5, 6];
    const time = config?.sendTimeIst ?? '10:00';
    return days.includes(ist.isoWeekday) && ist.hhmm >= time;
  }

  /** Enabled config but the client is inactive / missing → FAILED every due hit, ops alerted once a day. */
  private async blockedClient(
    clientId: string,
    name: string,
    state: 'INACTIVE' | 'missing',
    config: PayoutTrackerConfig | null,
    now: Date,
    runDate: string,
  ): Promise<TenantRunOutcome> {
    if (!this.isDue(config, now)) return { clientId, status: 'not-due' };
    const error = `the client is ${state} but its payoutTracker config is still enabled — not sent (disable the config or reactivate the client)`;
    this.logger.error(`payout-tracker: ${clientId} ${error}`);
    const alertError = await this.alertOnce(clientId, name, runDate, error, `${name} payout tracker NOT sent: the client is ${state}`);
    return { clientId, status: 'failed', error, ...(alertError ? { alertError } : {}) };
  }

  /**
   * Alert ops at most once per (tenant, IST day) for a blocker that prevents even trying — via a marker run row under
   * its own reportKey, so the scheduled day itself stays unclaimed.
   */
  private async alertOnce(clientId: string, name: string, runDate: string, error: string, subject: string): Promise<string | undefined> {
    try {
      await this.prisma.tenantReportRun.create({
        data: { clientId, reportKey: PAYOUT_TRACKER_BLOCKED_REPORT_KEY, runDate, status: 'SKIPPED', error },
        select: { id: true },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return undefined; // already alerted today
      // Could not record the marker — alert anyway (a duplicate alert beats a silent one).
      this.logger.error(`payout-tracker: could not record the blocked marker for ${clientId}: ${(e as Error)?.message}`);
    }
    return this.alert(name, clientId, runDate, error, subject);
  }

  private async runTenant(
    clientId: string,
    name: string,
    config: PayoutTrackerConfig | null,
    configError: string | null,
    now: Date,
    runDate: string,
    holidays: () => Set<string> | null,
  ): Promise<TenantRunOutcome> {
    if (!this.isDue(config, now)) return { clientId, status: 'not-due' };

    // Environment guard off: alert ops (once a day) WITHOUT claiming the day — it sends after the env is fixed.
    if (config && payoutTrackerEmailTarget(this.env).mode === 'off' && !(!config.sendOnHolidays && holidays()?.has(runDate))) {
      const existing = await this.prisma.tenantReportRun.findUnique({
        where: { clientId_reportKey_runDate: { clientId, reportKey: PAYOUT_TRACKER_REPORT_KEY, runDate } },
        select: { id: true },
      });
      if (existing) return { clientId, status: 'already-done' };
      const error =
        'email delivery disabled in this environment (PAYOUT_TRACKER_EMAIL_LIVE / PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT unset) — the day is NOT consumed: it sends on the next scheduler run after the environment is fixed';
      this.logger.error(`payout-tracker: ${clientId} ${error}`);
      const alertError = await this.alertOnce(clientId, name, runDate, error, `payout tracker for ${name} NOT sent: email delivery disabled in this environment`);
      return { clientId, status: 'skipped', error, ...(alertError ? { alertError } : {}) };
    }

    const claim = await this.claim(clientId, runDate, now);
    if (claim.kind === 'taken') return { clientId, status: 'already-done' };
    if (claim.kind === 'stale') {
      const error = 'the previous attempt was interrupted (no result after 30 min) — the email MAY or may not have gone; check, then use send-now if needed';
      const alertError = await this.alert(name, clientId, runDate, error);
      return { clientId, status: 'failed', error, ...(alertError ? { alertError } : {}) };
    }
    const runId = claim.id;

    try {
      if (configError) throw new RunFailure(configError, false);
      const cfg = config as PayoutTrackerConfig;

      if (!cfg.sendOnHolidays && holidays()?.has(runDate)) {
        await this.finish(runId, { status: 'SKIPPED', error: 'national holiday (sendOnHolidays=false)' });
        return { clientId, status: 'skipped', error: 'national holiday' };
      }

      const target = payoutTrackerEmailTarget(this.env);
      if (target.mode === 'off') {
        // Only reachable on a race with the pre-claim check: fail retryable so a later hit can still send the day.
        throw new RunFailure('email delivery disabled in this environment (PAYOUT_TRACKER_EMAIL_LIVE / PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT unset)', true);
      }
      if (target.mode === 'invalid-test') {
        throw new RunFailure(`PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT "${target.value}" is not on an internal domain — refused`, false);
      }

      const month = await this.chooseMonth(clientId, now);
      let pack: TrackerPack;
      let input: TrackerInput;
      let notes: TrackerNote[] = [];
      try {
        input = await this.source.buildInput(clientId, month, now);
        notes = notesOf(input);
        if (notes.length) this.logger.warn(`payout-tracker: ${clientId} ${month} data notes: ${texts(notes).join(' | ')}`);
        pack = await this.generate(input, now);
      } catch (e) {
        throw new RunFailure(`could not build the ${month} report: ${(e as Error)?.message ?? String(e)}`, true, month);
      }

      const addressed =
        target.mode === 'live'
          ? { to: cfg.recipients, cc: cfg.cc, subject: pack.email.subject }
          : {
              to: [target.to],
              cc: [] as string[],
              subject: `[TEST — would go to ${cfg.recipients.join(', ')}${cfg.cc.length ? `; cc ${cfg.cc.join(', ')}` : ''}] ${pack.email.subject}`,
            };
      const res = await this.deliver(addressed, pack, month, name);
      const recipients = [...addressed.to, ...addressed.cc];
      const rejectedNote = res.rejected.length ? `relay REJECTED ${res.rejected.join(', ')}` : null;
      try {
        await this.finish(runId, { status: 'SENT', month, recipients, fileName: pack.fileName, error: rejectedNote });
      } catch (e) {
        // The email WENT — never let a retry send it again.
        throw new RunFailure(
          `the email WAS sent to ${recipients.join(', ')} but recording the run failed: ${(e as Error)?.message ?? String(e)}`,
          false,
          month,
          `${name} payout tracker: sent but the run was NOT recorded`,
        );
      }
      const alertErrors: string[] = [];
      if (rejectedNote) {
        // Sent to the others — but a recipient did not get it: say so loudly.
        const a = await this.alert(name, clientId, runDate, `sent, but ${rejectedNote}`, `${name} payout tracker: some recipients NOT reached`);
        if (a) alertErrors.push(a);
      }
      // Data notes → ops heads-up, strictly AFTER the client email (never blocks or un-sends it).
      const h = await this.notesHeadsUp(input.clientName || name, clientId, month, notes, recipients);
      if (h) alertErrors.push(h);
      return {
        clientId,
        status: 'sent',
        month,
        recipients,
        ...(rejectedNote ? { error: rejectedNote } : {}),
        ...(notes.length ? { notes: texts(notes) } : {}),
        ...(alertErrors.length ? { alertError: alertErrors.join('; ') } : {}),
      };
    } catch (e) {
      const failure = e instanceof RunFailure ? e : new RunFailure((e as Error)?.message ?? String(e), true);
      this.logger.error(`payout-tracker: ${clientId} ${runDate} FAILED: ${failure.message}`);
      await this.finish(runId, {
        status: 'FAILED',
        error: failure.message,
        month: failure.month ?? null,
        ...(failure.retryable ? {} : { attempts: MAX_ATTEMPTS }),
      }).catch((we) => this.logger.error(`payout-tracker: could not record the FAILED run for ${clientId}: ${(we as Error)?.message}`));
      const alertError = await this.alert(name, clientId, runDate, failure.message, failure.alertSubject);
      return { clientId, status: 'failed', error: failure.message, ...(failure.month ? { month: failure.month } : {}), ...(alertError ? { alertError } : {}) };
    }
  }

  /** Claim today's row. created/retry → we own the send; taken → someone else did/does it; stale → interrupted run. */
  private async claim(clientId: string, runDate: string, now: Date): Promise<{ kind: 'claimed'; id: string } | { kind: 'taken' } | { kind: 'stale' }> {
    const key = { clientId, reportKey: PAYOUT_TRACKER_REPORT_KEY, runDate };
    try {
      const row = await this.prisma.tenantReportRun.create({ data: { ...key, status: 'PENDING' }, select: { id: true } });
      return { kind: 'claimed', id: row.id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    const existing = await this.prisma.tenantReportRun.findUnique({
      where: { clientId_reportKey_runDate: key },
      select: { id: true, status: true, attempts: true, updatedAt: true },
    });
    if (!existing) return { kind: 'taken' };
    if (existing.status === 'FAILED' && existing.attempts < MAX_ATTEMPTS) {
      // Compare-and-set on (status, attempts): two concurrent retries can't both win.
      const won = await this.prisma.tenantReportRun.updateMany({
        where: { id: existing.id, status: 'FAILED', attempts: existing.attempts },
        data: { status: 'PENDING', attempts: { increment: 1 }, error: null },
      });
      return won.count === 1 ? { kind: 'claimed', id: existing.id } : { kind: 'taken' };
    }
    if (existing.status === 'PENDING' && now.getTime() - existing.updatedAt.getTime() > STALE_PENDING_MS) {
      const won = await this.prisma.tenantReportRun.updateMany({
        where: { id: existing.id, status: 'PENDING', updatedAt: existing.updatedAt },
        data: { status: 'FAILED', attempts: MAX_ATTEMPTS, error: 'interrupted — no result after 30 min (email may or may not have gone)' },
      });
      return won.count === 1 ? { kind: 'stale' } : { kind: 'taken' };
    }
    return { kind: 'taken' };
  }

  private async finish(
    id: string,
    data: { status: 'SENT' | 'FAILED' | 'SKIPPED'; error?: string | null; month?: string | null; recipients?: string[]; fileName?: string; attempts?: number },
  ): Promise<void> {
    await this.prisma.tenantReportRun.update({
      where: { id },
      data: {
        status: data.status,
        error: data.error ?? null,
        ...(data.month !== undefined ? { month: data.month } : {}),
        ...(data.recipients ? { recipients: data.recipients } : {}),
        ...(data.fileName ? { fileName: data.fileName } : {}),
        ...(data.attempts !== undefined ? { attempts: data.attempts } : {}),
      },
    });
  }

  /** Current IST month, unless it has no applied sales yet → the previous month. */
  async chooseMonth(clientId: string, now: Date): Promise<string> {
    const current = istMonthKey(now);
    const any = await this.prisma.outletSalesRecord.findFirst({ where: { clientId, month: current }, select: { id: true } });
    return any ? current : shiftMonthKey(current, -1);
  }

  private async deliver(addr: { to: string[]; cc: string[]; subject: string }, pack: TrackerPack, month: string, name: string): Promise<SendEmailResult> {
    let res: SendEmailResult;
    try {
      res = await this.msg91.sendEmail({
        to: addr.to,
        ...(addr.cc.length ? { cc: addr.cc } : {}),
        subject: addr.subject,
        html: pack.email.html,
        text: pack.email.text,
        attachments: [{ filename: pack.fileName, content: pack.workbook, contentType: XLSX_CONTENT_TYPE }],
        detectAmbiguousDelivery: true, // opt-in: a timeout after DATA must never be auto-resent
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if ((e as { deliveryAmbiguous?: unknown })?.deliveryAmbiguous === true) {
        // The relay MAY have queued it — an automatic resend could duplicate a client email.
        throw new RunFailure(
          `the email MAY have been delivered to ${[...addr.to, ...addr.cc].join(', ')} — the SMTP connection was lost after the message was handed to the relay (${msg}). NOT retried automatically: check with the recipients before resending (send-now).`,
          false,
          month,
          `${name} payout tracker: delivery UNCERTAIN — check before resending`,
        );
      }
      throw new RunFailure(`email send failed: ${msg}`, true, month);
    }
    if (res.skipped) throw new RunFailure('email not sent — SMTP is not configured in this environment (MSG91_SMTP_PASS unset)', false, month);
    return res;
  }

  /** Internal ops recipients (digest list ∩ internal domains, else the fallback address). */
  private async opsRecipients(): Promise<string[]> {
    const { dailyDigest } = await loadReportRecipients(this.prisma);
    const internal = splitRecipientsByDomain(dailyDigest, allowedRecipientDomains(this.env.REPORTS_RECIPIENT_DOMAINS)).allowed;
    return internal.length ? internal : [OPS_ALERT_FALLBACK];
  }

  /** Loud ops alert. Returns an error string when the alert itself could not be sent (never throws). */
  private async alert(name: string, clientId: string, runDate: string, error: string, subject?: string): Promise<string | undefined> {
    try {
      const to = await this.opsRecipients();
      const short = error.length > 140 ? `${error.slice(0, 139)}…` : error;
      const heading = subject ?? `${name} payout tracker was NOT sent as scheduled`;
      const html =
        `<p><strong>${esc(heading)}</strong> (${esc(clientId)}, ${esc(runDate)} IST).</p>` +
        `<p>Reason: ${esc(error)}</p>` +
        `<p>A failed day is retried automatically on the next scheduler runs (up to ${MAX_ATTEMPTS} attempts) unless the reason says otherwise. ` +
        `To resend by hand: POST /v1/internal/scheduled/payout-tracker/send-now.</p>`;
      const res = await this.msg91.sendEmail({ to, subject: subject ?? `${name} payout tracker NOT sent: ${short}`, html });
      if (res.skipped) {
        this.logger.error(`payout-tracker ALERT NOT SENT (SMTP unconfigured) for ${clientId}: ${error}`);
        return 'alert not sent: SMTP not configured';
      }
      return undefined;
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      this.logger.error(`payout-tracker ALERT FAILED for ${clientId} (${error}): ${m}`);
      return `alert not sent: ${m}`;
    }
  }

  /** Ops heads-up listing the data notes of a report that WAS sent. Never throws; returns an error string on failure. */
  private async notesHeadsUp(clientLabel: string, clientId: string, month: string, notes: TrackerNote[], sentTo: string[]): Promise<string | undefined> {
    if (!notes.length) return undefined;
    const label = (n: TrackerNote) => (n.audience === 'client' ? '[also shown to the client] ' : '[ops only] ');
    try {
      const to = await this.opsRecipients();
      const html =
        `<p><strong>The ${esc(clientLabel)} payout tracker for ${esc(month)} was sent</strong> (${esc(clientId)}; to ${esc(sentTo.join(', '))}) ` +
        `with ${notes.length} data note(s). Notes marked "also shown to the client" are printed in the client email and on the workbook's About sheet; "ops only" notes are NOT shown to the client.</p>` +
        `<ul>${notes.map((n) => `<li>${esc(label(n) + n.text)}</li>`).join('')}</ul>`;
      const res = await this.msg91.sendEmail({ to, subject: `Payout tracker ${clientLabel} ${month}: ${notes.length} data note(s)`, html });
      if (res.skipped) return 'data-notes heads-up not sent: SMTP not configured';
      return undefined;
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      this.logger.error(`payout-tracker data-notes heads-up FAILED for ${clientId} ${month}: ${m}`);
      return `data-notes heads-up not sent: ${m}`;
    }
  }

  /** Manual / test send (see header). Throws on any failure. */
  async sendNow(clientId: string, month: string, recipients?: string[], now: Date = new Date()): Promise<SendNowResult> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException(`month "${month}" must be YYYY-MM`);
    const row = await this.prisma.programSetting.findFirst({
      where: { clientId, settingKey: PAYOUT_TRACKER_SETTING_KEY },
      select: { settingValue: true },
    });
    const parsed = parsePayoutTrackerConfig(row?.settingValue);
    if (parsed.kind === 'off') throw new Error(`payout tracker is not enabled for ${clientId} — enable its payoutTracker config first`);
    if (parsed.kind === 'invalid') throw new Error(parsed.error);
    const cfg = parsed.config;
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, status: true, internalName: true } });
    if (!client) throw new Error(`client ${clientId} not found — not sent`);
    if (client.status === 'INACTIVE') throw new Error(`client ${clientId} is INACTIVE — not sent`);
    const name = client.internalName || clientId;

    const target = payoutTrackerEmailTarget(this.env);
    let addr: { to: string[]; cc: string[]; subject?: string };
    if (recipients !== undefined) {
      // Explicit list: internal addresses always; the tenant's own configured (external) recipients ONLY in a live
      // environment — a non-live environment can never email a client, even by hand. Anything else → 400.
      let list: string[];
      try {
        list = validateRecipientList(recipients);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      const domains = allowedRecipientDomains(this.env.REPORTS_RECIPIENT_DOMAINS);
      const configured = new Set([...cfg.recipients, ...cfg.cc]);
      const live = target.mode === 'live';
      const problems: string[] = [];
      for (const e of list) {
        if (isAllowedRecipient(e, domains)) continue;
        if (configured.has(e)) {
          if (!live) problems.push(`${e} is a configured recipient but not an internal address (${domains.join(', ')}) — external recipients need PAYOUT_TRACKER_EMAIL_LIVE=true`);
        } else {
          problems.push(`${e} is not an internal address (${domains.join(', ')}) and not one of ${clientId}'s configured recipients`);
        }
      }
      if (problems.length) throw new BadRequestException(`${problems.join('; ')} — refused`);
      addr = { to: list, cc: [] };
    } else {
      // Same environment guard as the schedule.
      if (target.mode === 'off' || target.mode === 'invalid-test') {
        const error =
          target.mode === 'off'
            ? 'email delivery disabled in this environment (PAYOUT_TRACKER_EMAIL_LIVE / PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT unset) — pass explicit internal recipients'
            : `PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT "${target.value}" is not on an internal domain — refused`;
        const alertError = await this.alert(name, clientId, istParts(now).date, `send-now ${month}: ${error}`, `${name} payout tracker send-now REFUSED: ${target.mode === 'off' ? 'email delivery disabled in this environment' : 'invalid test recipient'}`);
        throw new Error(`${error}${alertError ? ` (${alertError})` : ''}`);
      }
      addr =
        target.mode === 'live'
          ? { to: cfg.recipients, cc: cfg.cc }
          : { to: [target.to], cc: [], subject: `[TEST — would go to ${cfg.recipients.join(', ')}${cfg.cc.length ? `; cc ${cfg.cc.join(', ')}` : ''}]` };
    }

    const runId = await this.createManualRun(clientId, month, now);
    let result: SendNowResult;
    try {
      const input = await this.source.buildInput(clientId, month, now);
      const notes = notesOf(input);
      const pack = await this.generate(input, now);
      const subject = addr.subject ? `${addr.subject} ${pack.email.subject}` : pack.email.subject;
      const res = await this.deliver({ to: addr.to, cc: addr.cc, subject }, pack, month, name);
      const sentTo = [...addr.to, ...addr.cc];
      this.logger.log(`payout-tracker send-now ${clientId} ${month} → ${sentTo.join(', ')}`);
      const warnings: string[] = [];
      try {
        await this.finish(runId, {
          status: 'SENT',
          month,
          recipients: sentTo,
          fileName: pack.fileName,
          error: res.rejected.length ? `relay REJECTED ${res.rejected.join(', ')}` : null,
        });
      } catch (e) {
        // The email went — do not throw (the operator would resend); say so on the result + log.
        const w = `the email WAS sent but recording the manual run failed: ${(e as Error)?.message ?? String(e)}`;
        this.logger.error(`payout-tracker send-now ${clientId}: ${w}`);
        warnings.push(w);
      }
      const h = await this.notesHeadsUp(input.clientName || name, clientId, month, notes, sentTo);
      if (h) warnings.push(h);
      result = {
        month,
        to: addr.to,
        cc: addr.cc,
        subject,
        fileName: pack.fileName,
        rejected: res.rejected,
        notes: texts(notes),
        runId,
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
      };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      await this.finish(runId, { status: 'FAILED', error: message, month, attempts: MAX_ATTEMPTS }).catch((we) =>
        this.logger.error(`payout-tracker send-now: could not record the FAILED manual run for ${clientId}: ${(we as Error)?.message}`),
      );
      throw e;
    }
    return result;
  }

  /** One PENDING 'payout-tracker-manual' row per send (runDate = IST timestamp; suffixed on a same-ms collision). */
  private async createManualRun(clientId: string, month: string, now: Date): Promise<string> {
    const stamp = istStamp(now);
    for (let i = 1; i <= 10; i++) {
      const runDate = i === 1 ? stamp : `${stamp} #${i}`;
      try {
        const row = await this.prisma.tenantReportRun.create({
          data: { clientId, reportKey: PAYOUT_TRACKER_MANUAL_REPORT_KEY, runDate, status: 'PENDING', month },
          select: { id: true },
        });
        return row.id;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new Error('could not record the manual run (10 sends in the same millisecond?) — not sent');
  }
}
