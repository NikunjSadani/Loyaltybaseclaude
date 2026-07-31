import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { currentWindowKey, windowBoundsForKey } from './visibility-window.helper';

export interface WeeklyReminderResult {
  /** Eligible tenants examined (visibilityEnabled AND capture mode PHOTO_APPROVAL). */
  tenants: number;
  /** Distinct reps who received an aggregated web-push (across all tenants). */
  repsNotified: number;
  /** Total in-scope outlets still PENDING an approved capture this window (coverage gap). */
  outletsPending: number;
}

/**
 * VisibilityNotifyService — the WEEKLY Visibility (POSM) capture REMINDER (design
 * VISIBILITY-POSM-DESIGN.md §1 "Weekly reminders — IN v1", owner-confirmed 2026-07-27).
 *
 * Channel = in-app WEB-PUSH ONLY (reuse the free `NotificationQueue` → push-drain
 * worker path, the same enqueue the sales-notifications service uses). NO SMS/WhatsApp.
 * Recipients = the CAPTURING REPS themselves (the front-line rep actively assigned to a
 * pending outlet, at an allowed hierarchy level). NO manager escalation in v1. Cadence =
 * weekly, driven by a `@Public`, shared-secret-gated endpoint pinged by a Cloud Scheduler
 * job (mirrors push /drain + kyc /cleanup-stale-drafts).
 *
 * Per eligible tenant (visibilityEnabled AND visibilityCaptureMode === 'PHOTO_APPROVAL')
 * it computes the CURRENT window's in-scope outlets that do NOT yet have an APPROVED
 * capture (state due / rejected / never = "pending"), resolves each pending outlet's
 * assigned capturing rep, and enqueues ONE aggregated push per rep.
 *
 * FIRE-AND-FORGET: every enqueue is best-effort; a rep with no push subscription simply
 * receives nothing (the drain worker sends to 0 endpoints — the always-visible sales
 * Tasks badge is the fallback). A per-tenant failure is logged and skipped so one bad
 * tenant never blocks the others. Recipient resolution is TENANT-SCOPED on every query.
 */
@Injectable()
export class VisibilityNotifyService {
  private readonly logger = new Logger(VisibilityNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Run the weekly reminder across every eligible tenant. Returns a summary
   * { tenants, repsNotified, outletsPending } for the caller/log.
   */
  async runWeeklyReminder(): Promise<WeeklyReminderResult> {
    const now = new Date();

    // Candidate tenants = those with the master switch ON (program_settings-backed,
    // the same row resolveVisibilityEnabled reads). settingValue is a JSON boolean.
    const enabledRows = await this.prisma.programSetting.findMany({
      where: { settingKey: 'visibilityEnabled', settingValue: { equals: true } },
      select: { clientId: true },
    });

    let tenants = 0;
    let repsNotified = 0;
    let outletsPending = 0;

    for (const { clientId } of enabledRows) {
      try {
        // Only the PHOTO_APPROVAL capture mode has a capture-and-approve flow to remind on.
        const mode = await this.tenant.resolveVisibilityCaptureMode(clientId);
        if (mode !== 'PHOTO_APPROVAL') continue;

        tenants += 1;
        const res = await this.remindTenant(clientId, now);
        repsNotified += res.repsNotified;
        outletsPending += res.outletsPending;
      } catch (e) {
        this.logger.warn(`[visibility-notify] tenant ${clientId} reminder failed: ${e}`);
      }
    }

    this.logger.log(
      `[visibility-notify] weekly reminder: tenants=${tenants} repsNotified=${repsNotified} outletsPending=${outletsPending}`,
    );
    return { tenants, repsNotified, outletsPending };
  }

  /** One eligible tenant: find pending outlets → aggregate per rep → enqueue one push each. */
  private async remindTenant(
    clientId: string,
    now: Date,
  ): Promise<{ repsNotified: number; outletsPending: number }> {
    const config = (await this.tenantSettings.getEffectiveSettings(clientId)).visibilityConfig;
    const { outletScope, frequencyPerMonth, allowedSalesLevels } = config;

    // No scope configured yet → no outlets in the universe → nothing to remind.
    if (!outletScope || outletScope.length === 0) return { repsNotified: 0, outletsPending: 0 };

    const windowKey = currentWindowKey(now, frequencyPerMonth);
    const dueDate = this.windowEndDate(windowKey, frequencyPerMonth);

    // Pending = addressable in-scope outlets with NO APPROVED capture at the current window
    // (due / rejected / never). The addressable-universe `where` mirrors the report service's
    // denominator (NOT `isActive:true`; kycIntent OR-wrapped so NULL-intent outlets survive).
    // We load each outlet's single active assignment → its capturing rep (level + login userId).
    const allowedLevels = new Set(allowedSalesLevels ?? []);
    const pendingOutlets = await this.prisma.outlet.findMany({
      where: {
        clientId,
        deletedAt: null,
        deactivatedAt: null,
        // Don't nudge a rep about a NOT_INTERESTED (declined) or PARKED (admin-removed) outlet.
        // notIn drops NULLs → the {null} branch keeps normal pending outlets.
        OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
        outletType: { code: { in: outletScope } },
        NOT: { visibilityCaptures: { some: { windowKey, status: 'APPROVED' } } },
      } as Prisma.OutletWhereInput,
      select: {
        id: true,
        salesAssignments: {
          where: { unassignedAt: null, salesUser: { clientId, deletedAt: null } },
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: {
            salesUser: {
              select: { userId: true, hierarchyLevel: { select: { code: true } } },
            },
          },
        },
      },
    });

    const outletsPending = pendingOutlets.length;
    if (outletsPending === 0) return { repsNotified: 0, outletsPending: 0 };

    // Aggregate pending-outlet COUNT per capturing rep (login userId).
    const pendingPerRep = new Map<string, number>();
    for (const outlet of pendingOutlets) {
      const rep = outlet.salesAssignments[0]?.salesUser;
      // No active assignment → no natural front-line capturer → skip for NOTIFICATION.
      // (The outlet still surfaces on the sales Tasks page for managers to action.)
      if (!rep) continue;
      // L3 — never enqueuePush(null/'' , …). SalesUser.userId is non-nullable in the schema
      // (String @unique), so this is defence-in-depth against a malformed row / future
      // nullability, guaranteeing a push is only ever enqueued for a real login.
      if (!rep.userId) continue;
      // The assigned rep's level is NOT an allowed capturing level → skip that outlet for
      // notification (again: it still shows in the Tasks page for a manager, just no push).
      if (!allowedLevels.has(rep.hierarchyLevel.code)) continue;
      pendingPerRep.set(rep.userId, (pendingPerRep.get(rep.userId) ?? 0) + 1);
    }

    if (pendingPerRep.size === 0) return { repsNotified: 0, outletsPending };

    // One aggregated push per rep. displayName prefixes the title (e.g. "Deoleo Visibility").
    const displayName = await this.tenantDisplayName(clientId);
    await Promise.all(
      Array.from(pendingPerRep.entries()).map(([userId, count]) => {
        const noun = count === 1 ? 'outlet' : 'outlets';
        return this.enqueuePush(
          userId,
          `${displayName} Visibility`,
          `${count} ${noun} still need a photo this period (due ${dueDate}). Tap to capture.`,
          '/sales/visibility',
        );
      }),
    );

    return { repsNotified: pendingPerRep.size, outletsPending };
  }

  /** The IST calendar date (YYYY-MM-DD) a window closes on, for the "due {date}" copy. */
  private windowEndDate(windowKey: string, freq: number): string {
    // windowKey = "YYYY-MM-Pn"; take its year-month + the window's endDay.
    const [yearMonth] = windowKey.split('-P');
    const { endDay } = windowBoundsForKey(windowKey, freq);
    return `${yearMonth}-${String(endDay).padStart(2, '0')}`;
  }

  /** Tenant display label for the push title (falls back to the internal/slug name). */
  private async tenantDisplayName(clientId: string): Promise<string> {
    try {
      return (await this.tenant.resolveClient(clientId)).branding.displayName;
    } catch {
      return 'Visibility';
    }
  }

  /**
   * Enqueue a single PUSH row (fire-and-forget). Never throws — a failed enqueue for one
   * rep must not abort the fan-out to the others. The click-through URL rides in `variables`.
   */
  private async enqueuePush(
    userId: string,
    subject: string,
    body: string,
    url: string,
  ): Promise<void> {
    await this.notifications
      .enqueue({ userId, channel: 'PUSH', subject, body, variables: { url } })
      .catch((e) => this.logger.warn(`[visibility-notify] enqueue failed for ${userId}: ${e}`));
  }
}
