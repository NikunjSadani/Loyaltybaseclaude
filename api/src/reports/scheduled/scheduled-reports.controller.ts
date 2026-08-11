import { Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../common/decorators/roles.decorator';
import { ScheduledReportsService } from './scheduled-reports.service';

/**
 * POST /v1/reports/run — the daily internal-report trigger. Called by Cloud Scheduler
 * (Mon–Sat), NOT by a logged-in user, so it is @Public (no JWT) and gated ONLY by a shared
 * secret header, mirroring the push-drain endpoint.
 *
 * Fail-closed: if REPORTS_RUN_SECRET is unset the endpoint always 403s (never an open trigger).
 * Constant-time compare so the secret can't be probed by timing.
 *
 * Provisioning (go-live, imperative — NOT terraform, like push-drain):
 *   gcloud scheduler jobs create http reports-run-prod --schedule="30 3 * * 1-6" \
 *     --uri="$API/v1/reports/run" --http-method=POST --time-zone="Asia/Kolkata" \
 *     --headers="x-reports-run-secret=$REPORTS_RUN_SECRET" --message-body=" "
 */
@Controller('reports')
export class ScheduledReportsController {
  constructor(private readonly reports: ScheduledReportsService) {}

  @Public()
  @Post('run')
  async run(@Headers('x-reports-run-secret') secret?: string): Promise<{ ok: true; dateLabel: string; reports: unknown[] }> {
    const expected = process.env.REPORTS_RUN_SECRET;
    if (!expected) throw new ForbiddenException('Reports run disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid reports-run secret');
    }
    const result = await this.reports.runDailyReports();
    return { ok: true, ...result };
  }
}
