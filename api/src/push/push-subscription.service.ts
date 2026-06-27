import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpsertSubscriptionParams {
  userId: string;
  clientId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * PushSubscription persistence — one row per browser/device endpoint a user has
 * granted Web Push permission on. Every write is keyed on the W3C `endpoint` URL
 * (unique); `userId`/`clientId` are supplied by the controller from the JWT and
 * never trusted from the request body (tenant isolation). Reads are always by
 * `userId`, which is already tenant-bound.
 */
@Injectable()
export class PushSubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * UPSERT on the unique `endpoint`. If the same browser re-subscribes (e.g. keys
   * rotated, or the user logged in as someone else on a shared device), the row is
   * re-pointed to the current user — the endpoint can only ever belong to one user.
   */
  async upsert(params: UpsertSubscriptionParams): Promise<{ id: string }> {
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: params.endpoint },
      create: {
        userId: params.userId,
        clientId: params.clientId,
        endpoint: params.endpoint,
        p256dh: params.p256dh,
        auth: params.auth,
        userAgent: params.userAgent ?? null,
      },
      update: {
        userId: params.userId,
        clientId: params.clientId,
        p256dh: params.p256dh,
        auth: params.auth,
        userAgent: params.userAgent ?? null,
      },
      select: { id: true },
    });
    return row;
  }

  /** Delete the subscription for `endpoint`, scoped to the current user. */
  async remove(userId: string, endpoint: string): Promise<{ success: true }> {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return { success: true };
  }

  /** All subscriptions for a user (already tenant-bound). */
  listByUser(userId: string) {
    return this.prisma.pushSubscription.findMany({ where: { userId } });
  }
}
