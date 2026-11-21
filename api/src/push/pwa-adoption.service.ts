import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PwaPlatform } from './dto/push.dto';

/**
 * The ONE definition of "an installed user of this tenant" — shared by the App Adoption page count
 * (PwaAdoptionService.adoption) and the "Download installed users" Excel (app-installed-users export kind), so the
 * number on the page and the file's row count (no filters) always match.
 *
 *   • the install row is stamped with this tenant (pwa_install.clientId), AND
 *   • the user BELONGS to this tenant (user.clientId) — a Gifsy operator who opened the app while assumed into the
 *     tenant leaves an install row stamped with it, but is not one of the tenant's users, AND
 *   • the user is not soft-deleted (owner policy: removed users' phone numbers must not circulate). Inactive /
 *     suspended users still count — they did install the app.
 */
export function tenantInstallWhere(clientId: string): Prisma.PwaInstallWhereInput {
  return { clientId, user: { clientId, deletedAt: null } };
}

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
    users: number; // distinct users of this tenant (not deleted) who launched the installed PWA — see tenantInstallWhere
    devices: number; // pwa_install rows (one per user × platform)
    byRole: { role: string; users: number }[];
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

    // ── Installed to home screen (pwa_install) — same population as the installed-users Excel. ──
    const installs = await this.prisma.pwaInstall.findMany({
      where: tenantInstallWhere(clientId),
      select: { userId: true, platform: true, user: { select: { role: true } } },
    });
    const installUsers = new Set<string>();
    const platformUsers = new Map<string, Set<string>>();
    const installRoleUsers = new Map<string, Set<string>>();
    for (const i of installs) {
      installUsers.add(i.userId);
      (platformUsers.get(i.platform) ?? platformUsers.set(i.platform, new Set()).get(i.platform)!).add(i.userId);
      const role = i.user?.role ?? 'UNKNOWN';
      (installRoleUsers.get(role) ?? installRoleUsers.set(role, new Set()).get(role)!).add(i.userId);
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
        // One pwa_install row per (user, platform) → "across N devices" like the notifications card.
        devices: installs.length,
        byRole: [...installRoleUsers.entries()]
          .map(([role, set]) => ({ role, users: set.size }))
          .sort((a, b) => b.users - a.users),
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
