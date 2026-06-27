import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Web Push sender. Holds the single platform-wide VAPID identity (read once from
 * env) and posts encrypted payloads to a user's browser endpoints.
 *
 * - If VAPID env is unset the sender no-ops gracefully (logs once) so a dev/staging
 *   env without keys never errors a money/KYC path.
 * - Per-subscription error isolation: one bad endpoint never fails the rest.
 * - Dead endpoints (404 Not Found / 410 Gone from the push service) are pruned.
 */
@Injectable()
export class PushSenderService {
  private readonly logger = new Logger(PushSenderService.name);
  private readonly configured: boolean;
  private warnedUnconfigured = false;

  constructor(private readonly prisma: PrismaService) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;

    if (publicKey && privateKey && subject) {
      try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        this.configured = true;
      } catch (e) {
        // A malformed key pair must not crash app bootstrap.
        this.logger.error(`[push] invalid VAPID config — push disabled: ${e}`);
        this.configured = false;
      }
    } else {
      this.configured = false;
    }
  }

  /** The configured VAPID public key (or "" when push is not configured). */
  get publicKey(): string {
    return process.env.VAPID_PUBLIC_KEY ?? '';
  }

  /**
   * Send a payload to every subscription of `userId`. Returns the number of
   * endpoints that accepted the push. Best-effort: never throws.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.configured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn('[push] VAPID not configured — sendToUser is a no-op');
      }
      return 0;
    }

    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return 0;

    const body = JSON.stringify(payload);
    let sent = 0;

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
        sent += 1;
      } catch (e) {
        const statusCode = (e as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Endpoint is gone — prune so we stop trying. Scoped by id (a dead
          // endpoint string is unique anyway) and swallow a delete race.
          await this.prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => undefined);
          this.logger.debug(`[push] pruned dead subscription ${sub.id} (status ${statusCode})`);
        } else {
          // Transient / other error — log and keep going (one bad sub must not
          // fail the rest, and push is best-effort).
          this.logger.warn(`[push] send to ${sub.id} failed (status ${statusCode ?? 'n/a'}): ${e}`);
        }
      }
    }

    return sent;
  }
}
