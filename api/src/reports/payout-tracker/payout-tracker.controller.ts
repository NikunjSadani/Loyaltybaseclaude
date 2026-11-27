import { BadRequestException, Body, Controller, ForbiddenException, Headers, HttpCode, HttpException, HttpStatus, Logger, Post } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches } from 'class-validator';
import { Public } from '../../common/decorators/roles.decorator';
import { PayoutTrackerSender, type TenantRunOutcome } from './payout-tracker.sender';

export class PayoutTrackerSendNowDto {
  @IsString()
  clientId!: string;

  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  recipients?: string[];
}

/** Fail-closed shared-secret gate, constant-time compare (same as POST /v1/reports/run). */
function assertSecretFrom(envName: string, secret: string | undefined, disabled: string, invalid: string): void {
  const expected = (process.env[envName] ?? '').trim();
  if (!expected) throw new ForbiddenException(disabled);
  const got = Buffer.from((secret ?? '').trim());
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ForbiddenException(invalid);
}
/** Scheduler trigger: REPORTS_RUN_SECRET (shared with the other scheduled reports). */
const assertSecret = (s: string | undefined) => assertSecretFrom('REPORTS_RUN_SECRET', s, 'Reports run disabled', 'Invalid reports-run secret');
/** Manual send-now: its OWN secret PAYOUT_TRACKER_SEND_SECRET — the scheduler secret cannot send a client email on demand. */
const assertSendSecret = (s: string | undefined) =>
  assertSecretFrom('PAYOUT_TRACKER_SEND_SECRET', s, 'Payout tracker send-now disabled', 'Invalid payout-tracker send secret');

/**
 * Scheduler trigger for the per-tenant payout-tracker email. @Public (no JWT) — gated ONLY by the
 * `x-reports-run-secret` header, like the daily digest trigger.
 *
 * POST /v1/internal/scheduled/payout-tracker — runDue(now). Safe to call every 15 min: each enabled tenant is sent
 *   at most once per IST day (claim row). 200 when nothing failed in THIS call (incl. "not due" / "already done");
 *   500 when any tenant FAILED (the ops alert email has already gone) so Cloud Scheduler also flags it.
 * POST /v1/internal/scheduled/payout-tracker/send-now — { clientId, month, recipients? } manual / test send. Gated by
 *   its OWN header `x-payout-tracker-send-secret` = PAYOUT_TRACKER_SEND_SECRET (fail-closed when unset). Explicit
 *   recipients must be internal (REPORTS_RECIPIENT_DOMAINS) or the tenant's configured recipients; every send-now
 *   writes a 'payout-tracker-manual' run row.
 *
 * Provisioning (imperative, like reports-run — NOT terraform):
 *   gcloud scheduler jobs create http payout-tracker-<env> --schedule="*\/15 * * * *" --time-zone="Asia/Kolkata" \
 *     --uri="$API/v1/internal/scheduled/payout-tracker" --http-method=POST \
 *     --headers="x-reports-run-secret=$REPORTS_RUN_SECRET" --message-body=" " \
 *     --attempt-deadline=300s --max-retry-attempts=0
 */
@Controller('internal/scheduled')
export class PayoutTrackerController {
  private readonly logger = new Logger(PayoutTrackerController.name);

  constructor(private readonly sender: PayoutTrackerSender) {}

  @Public()
  @Post('payout-tracker')
  @HttpCode(HttpStatus.OK)
  async run(@Headers('x-reports-run-secret') secret?: string): Promise<{ ok: true; runDate: string; outcomes: TenantRunOutcome[] }> {
    assertSecret(secret);
    const result = await this.sender.runDue(new Date());
    const failed = result.outcomes.filter((o) => o.status === 'failed');
    const line = `payout-tracker-run ${JSON.stringify(result)}`;
    if (failed.length) {
      this.logger.error(line);
      const message = `Payout tracker: ${failed.map((o) => `${o.clientId} FAILED: ${o.error ?? 'unknown'}${o.alertError ? ` (${o.alertError})` : ''}`).join(' | ')}`.slice(0, 900);
      throw new HttpException({ message, statusCode: HttpStatus.INTERNAL_SERVER_ERROR, ...result }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    if (result.outcomes.length) this.logger.log(line);
    return { ok: true, ...result };
  }

  @Public()
  @Post('payout-tracker/send-now')
  @HttpCode(HttpStatus.OK)
  async sendNow(@Headers('x-payout-tracker-send-secret') secret: string | undefined, @Body() dto: PayoutTrackerSendNowDto) {
    assertSendSecret(secret);
    try {
      const r = await this.sender.sendNow(dto.clientId, dto.month, dto.recipients);
      return { ok: true as const, ...r };
    } catch (e) {
      const message = `Payout tracker send-now failed: ${(e as Error)?.message ?? String(e)}`.slice(0, 900);
      this.logger.error(message);
      // A bad request (month / recipient list) is the caller's input → 400; anything else → 422.
      const status = e instanceof BadRequestException ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY;
      throw new HttpException({ message, statusCode: status }, status);
    }
  }
}
