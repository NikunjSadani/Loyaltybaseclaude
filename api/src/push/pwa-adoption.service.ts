import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PwaPlatform } from './dto/push.dto';

/** OS bucket derived from a stored userAgent. */
type OsBucket = 'Android' | 'iOS' | 'Desktop' | 'Other';

export interface AdoptionReport {
  clientId: string;
  subscribed: {
    users: number; // distinct users with ≥1 push subscription
    devices: number; // total subscription rows
    byRole: { role: string; users: number }[];
    byOs: { os: OsBucket; users: number }[];
  };
  installed: {
    users: number; // distinct users who launched the installed PWA
    byPlatform: { platform: string; users: number }[];
  };
}

/**
 * PwaAdoptionService — PWA adoption analytics + the install beacon write.
 *
 * Two independent signals:
 *   • "Notifications enabled"  → push_subscription rows (who granted push permission).
 *   • "Installed to home screen" → pwa_install rows (a client beacon fired when the app
 *     was launched standalone). A user can do one without the other.
 *
 * All reads are TENANT-SCOPED by the caller's clientId (CLIENT_ADMIN sees their own
 * tenant; a GIFSY_ADMIN sees whichever tenant they've assumed — mirrors every other
 * admin aggregation). The install write stamps userId/clientId from the JWT, never the body.
 */
@Injectable()
export class PwaAdoptionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Upsert the installed-PWA beacon for the current user+platform (refreshes lastSeenAt). */
  async recordInstall(
    userId: string,
    clientId: string,
    platform: PwaPlatform,
    userAgent: string | null,
  ): Promise<{ ok: true }> {
    const now = new Date();
    await this.prisma.pwaInstall.upsert({
      where: { userId_platform: { userId, platform } },
      create: { userId, clientId, platform, userAgent, lastSeenAt: now },
      update: { lastSeenAt: now, clientId, userAgent },
    });
    return { ok: true };
  }

  /** Tenant-scoped adoption stats for the admin "App Adoption" page. */
  async adoption(clientId: string): Promise<AdoptionReport> {
    // ── Notifications enabled (push_subscription) ──
    const subs = await this.prisma.pushSubscription.findMany({
      where: { clientId },
      select: { userId: true, userAgent: true, user: { select: { role: true } } },
    });

    const subUsers = new Set<string>();
    const roleUsers = new Map<string, Set<string>>();
    const osUsers = new Map<OsBucket, Set<string>>();
    for (const s of subs) {
      subUsers.add(s.userId);
      const role = s.user?.role ?? 'UNKNOWN';
      (roleUsers.get(role) ?? roleUsers.set(role, new Set()).get(role)!).add(s.userId);
      const os = this.osBucket(s.userAgent);
      (osUsers.get(os) ?? osUsers.set(os, new Set()).get(os)!).add(s.userId);
    }

    // ── Installed to home screen (pwa_install) ──
    const installs = await this.prisma.pwaInstall.findMany({
      where: { clientId },
      select: { userId: true, platform: true },
    });
    const installUsers = new Set<string>();
    const platformUsers = new Map<string, Set<string>>();
    for (const i of installs) {
      installUsers.add(i.userId);
      (platformUsers.get(i.platform) ?? platformUsers.set(i.platform, new Set()).get(i.platform)!).add(i.userId);
    }

    return {
      clientId,
      subscribed: {
        users: subUsers.size,
        devices: subs.length,
        byRole: [...roleUsers.entries()]
          .map(([role, set]) => ({ role, users: set.size }))
          .sort((a, b) => b.users - a.users),
        byOs: [...osUsers.entries()]
          .map(([os, set]) => ({ os, users: set.size }))
          .sort((a, b) => b.users - a.users),
      },
      installed: {
        users: installUsers.size,
        byPlatform: [...platformUsers.entries()]
          .map(([platform, set]) => ({ platform, users: set.size }))
          .sort((a, b) => b.users - a.users),
      },
    };
  }

  /** Bucket a stored userAgent into a coarse OS for the adoption breakdown. */
  private osBucket(ua: string | null): OsBucket {
    const s = ua ?? '';
    if (/Android/i.test(s)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(s)) return 'iOS';
    if (/Windows|Macintosh|Linux|CrOS/i.test(s)) return 'Desktop';
    return 'Other';
  }
}
