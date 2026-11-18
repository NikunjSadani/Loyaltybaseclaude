import { Controller, ForbiddenException, Headers, HttpCode, HttpException, HttpStatus, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../common/decorators/roles.decorator';
import { ReportOutcome, ScheduledReportsService } from './scheduled-reports.service';

/**
 * HTTP status per run outcome. Cloud Scheduler treats any non-2xx as a FAILED attempt (and alerts), so
 * only a complete send or an idempotent skip may answer 2xx:
 *   sent → 200 · skipped (today's digest already sent) → 200
 *   no-recipients → 409 · in-progress (another run holds the lease) → 409
 *   degraded (emailed, but a shared input failed — window NOT advanced) → 500 · error → 500
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
 *     --attempt-deadline=600s --max-retry-attempts=0
 */
@Controller('reports')
export class ScheduledReportsController {
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
    if (status !== HttpStatus.OK) {
      // The body carries the full outcome (reason, notices, dropped recipients) for the operator.
      throw new HttpException({ ok: false, statusCode: status, ...result }, status);
    }
    return { ok: true, ...result, ...(outcome.status === 'skipped' ? { skipped: 'already-sent' as const } : {}) };
  }
}
