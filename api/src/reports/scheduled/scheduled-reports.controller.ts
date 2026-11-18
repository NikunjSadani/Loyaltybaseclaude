import { Controller, ForbiddenException, Headers, HttpCode, HttpException, HttpStatus, Logger, Post, Query } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import { Public } from '../../common/decorators/roles.decorator';
import { ReportOutcome, ScheduledReportsService } from './scheduled-reports.service';

/**
 * HTTP status per run outcome. Cloud Scheduler treats any non-2xx as a FAILED attempt (and alerts), so
 * only a complete send or an idempotent skip may answer 2xx:
 *   sent → 200 · skipped (today's digest already sent) → 200
 *   no-recipients → 409 · in-progress (another run holds the lease) → 409
 *   degraded (emailed, but something did not load — window NOT advanced) → 500 · error → 500
 */
export function httpStatusFor(o: ReportOutcome): number {
  switch (o.status) {
    case 'sent':
    case 'skipped':
      return HttpStatus.OK;
    case 'no-recipients':
    case 'in-progress':
      return HttpStatus.CONFLICT;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

/** Summary line kept under the global filter (which forwards only `message`). */
const MESSAGE_MAX = 900;

/**
 * One readable line for a non-2xx run: status, reason, what didn't load, dropped recipients, notices, and the
 * id of the structured log line holding the FULL outcome. The global AllExceptionsFilter keeps only an
 * exception's `message`, so this line is all a scheduler / curl caller sees in the body.
 */
export function outcomeMessage(o: ReportOutcome, runId: string): string {
  const parts: string[] = [`Daily operations digest: ${o.status}`];
  if (o.error) parts.push(`reason: ${o.error}`);
  if (o.status === 'degraded') parts.push('the email WAS sent, but incomplete — its window will be repeated in the next digest');
  if (o.failedSections?.length) parts.push(`not loaded: ${o.failedSections.join('; ')}`);
  if (o.droppedRecipients?.length) parts.push(`not sent to (non-internal): ${o.droppedRecipients.join(', ')}`);
  if (o.notices?.length) parts.push(`notices: ${o.notices.join(' | ')}`);
  if (o.window) parts.push(`window: ${o.window.label}`);
  const tail = ` — full outcome in the API log line "daily-digest-run ${runId}"`;
  const head = parts.join(' — ');
  return (head.length + tail.length > MESSAGE_MAX ? head.slice(0, MESSAGE_MAX - tail.length - 1) + '…' : head) + tail;
}

/**
 * POST /v1/reports/run — the daily internal-report trigger. Called by Cloud Scheduler
 * (Mon–Sat), NOT by a logged-in user, so it is @Public (no JWT) and gated ONLY by a shared
 * secret header, mirroring the push-drain endpoint.
 *
 * Fail-closed: if REPORTS_RUN_SECRET is unset the endpoint always 403s (never an open trigger).
 * Constant-time compare so the secret can't be probed by timing.
 *
 * `?force=true` (same secret): re-send even though today's digest already went out — it re-covers today's
 * window up to now. Without it a second trigger the same IST day answers 200 `{ skipped:'already-sent' }`.
 *
 * Provisioning (go-live, imperative — NOT terraform, like push-drain; see the runbook):
 *   gcloud scheduler jobs create http reports-run-prod --schedule="30 9 * * 1-6" \
 *     --uri="$API/v1/reports/run" --http-method=POST --time-zone="Asia/Kolkata" \
 *     --headers="x-reports-run-secret=$REPORTS_RUN_SECRET" --message-body=" " \
 *     --attempt-deadline=300s --max-retry-attempts=0   (Cloud Run request timeout is 300 s; the run budget is 240 s)
 */
@Controller('reports')
export class ScheduledReportsController {
  private readonly logger = new Logger(ScheduledReportsController.name);

  constructor(private readonly reports: ScheduledReportsService) {}

  @Public()
  @Post('run')
  @HttpCode(HttpStatus.OK)
  async run(
    @Headers('x-reports-run-secret') secret?: string,
    @Query('force') force?: string,
  ): Promise<{ ok: true; dateLabel: string; reports: ReportOutcome[]; skipped?: 'already-sent' }> {
    const expected = process.env.REPORTS_RUN_SECRET;
    if (!expected) throw new ForbiddenException('Reports run disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid reports-run secret');
    }
    const result = await this.reports.runDailyReports(Date.now(), { force: force === 'true' || force === '1' });
    const outcome = result.reports[0];
    const status = httpStatusFor(outcome);
    // ONE structured line per run with the full outcome — the place the error body points to.
    const runId = randomUUID().slice(0, 8);
    const line = `daily-digest-run ${runId} ${JSON.stringify({ httpStatus: status, ...result })}`;
    if (status === HttpStatus.OK) this.logger.log(line);
    else this.logger.error(line);
    if (status !== HttpStatus.OK) {
      // The global filter forwards only `message`: make it the readable summary (+ the log line id).
      throw new HttpException({ message: outcomeMessage(outcome, runId), statusCode: status, runId, ...result }, status);
    }
    return { ok: true, ...result, ...(outcome.status === 'skipped' ? { skipped: 'already-sent' as const } : {}) };
  }
}
