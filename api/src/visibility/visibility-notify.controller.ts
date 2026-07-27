import { Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/roles.decorator';
import {
  VisibilityNotifyService,
  WeeklyReminderResult,
} from './visibility-notify.service';

/**
 * Visibility (POSM) weekly-reminder trigger — POST /v1/visibility/weekly-reminder.
 *
 * Cloud Run throttles CPU between requests, so an in-process @Cron/@Interval timer does
 * not fire reliably while the instance is idle; a weekly Cloud Scheduler job pings this
 * endpoint (the request itself un-throttles the CPU). Mirrors the push /drain +
 * kyc /cleanup-stale-drafts security pattern.
 *
 * @Public (Cloud Scheduler carries no JWT) but gated by a shared secret in the
 * `x-visibility-reminder-secret` header matched against VISIBILITY_REMINDER_SECRET.
 * FAIL-CLOSED: if the env secret is unset the endpoint refuses, so it is never an open
 * trigger. Constant-time compare. Worst case of a leaked secret is an early reminder pass
 * (identical to the schedule firing) — the body carries no user input and only enqueues
 * best-effort web-push rows, never exposes data.
 *
 * NOTE (infra — orchestrator): a weekly Cloud Scheduler job + a VISIBILITY_REMINDER_SECRET
 * secret bound on the api service must be created at go-live (owner-gated at cutover); they
 * do NOT exist yet. Until the secret is set, this endpoint fails closed (403).
 */
@Controller('visibility')
export class VisibilityNotifyController {
  constructor(private readonly notify: VisibilityNotifyService) {}

  @Public()
  @Post('weekly-reminder')
  async weeklyReminder(
    @Headers('x-visibility-reminder-secret') secret?: string,
  ): Promise<WeeklyReminderResult> {
    const expected = process.env.VISIBILITY_REMINDER_SECRET;
    // Fail-closed: no configured secret → never an open trigger.
    if (!expected) throw new ForbiddenException('Visibility reminder disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid visibility reminder secret');
    }
    return this.notify.runWeeklyReminder();
  }
}
