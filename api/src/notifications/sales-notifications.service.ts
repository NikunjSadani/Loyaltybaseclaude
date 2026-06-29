import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import {
  firstActiveApproverId,
  SalesApproverNode,
} from '../sales/sales-hierarchy-access.helper';

/**
 * SalesNotificationsService — fan-out of PUSH notifications to the SALES team for
 * the three operational events the operator asked for:
 *
 *   1. A new outlet/KYC is ASSIGNED to a rep (they must do the KYC).
 *   2. A KYC is SUBMITTED → notify the routed approving manager up the chain.
 *   3. A KYC is REJECTED / sent back for RE-UPLOAD → notify the responsible rep.
 *   4. TARGETS are uploaded → notify the assigned rep (XSR) + their manager (SO)
 *      for every outlet that got a target.
 *
 * SECURITY: every recipient is resolved through TENANT-SCOPED queries — an outlet's
 * responsible rep, a submitter's approver, and an assigned rep are all looked up
 * `where clientId = <caller clientId>`. A notification carries an outlet label / KYC
 * status, so a cross-tenant resolution would leak one tenant's data to another
 * tenant's rep; the clientId filter on every query is the guard.
 *
 * Every method is FIRE-AND-FORGET and wrapped so it can NEVER throw into — or slow
 * the failure of — the calling money/KYC/upload path. Callers invoke AFTER their own
 * DB transaction has committed (mirrors the existing `notify()` B1 discipline: the
 * enqueue runs on the base Prisma client, never inside the domain tx).
 *
 * Delivery is the standard path: enqueue a QUEUED `NotificationQueue` PUSH row; the
 * push-delivery worker (Cloud-Scheduler-triggered drain) sends it to the rep's
 * subscriptions. A rep with no push subscription simply receives nothing — enqueue
 * is still harmless (the worker sends to 0 endpoints).
 */
@Injectable()
export class SalesNotificationsService {
  private readonly logger = new Logger(SalesNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ── Event 1: outlets assigned to a rep (aggregated, one push per rep) ─────── */

  /**
   * Notify a rep that `count` new outlet(s) were assigned to them for KYC. Called
   * once per rep after a bulk outlet upload / reassignment (NOT once per outlet).
   */
  async outletsAssigned(clientId: string, salesUserId: string, count: number): Promise<void> {
    if (count <= 0) return;
    try {
      const userId = await this.salesUserLoginId(clientId, salesUserId);
      if (!userId) return;
      const noun = count === 1 ? 'outlet' : 'outlets';
      await this.enqueuePush(
        userId,
        'New KYC assigned',
        `${count} new ${noun} assigned to you for KYC.`,
        '/sales/kyc',
      );
    } catch (e) {
      this.logger.warn(`[sales-notify] outletsAssigned failed: ${e}`);
    }
  }

  /* ── Event 2: KYC submitted → notify the routed approver ───────────────────── */

  /**
   * Notify the submitting rep's first ACTIVE reporting manager (the routed approver)
   * that a KYC is pending their approval. No-op when the submitter is not a sales
   * user or has no active manager up the chain (e.g. a self-KYC, or a top-level rep).
   */
  async kycSubmittedForApproval(
    clientId: string,
    submitterLoginUserId: string,
    outletLabel: string,
  ): Promise<void> {
    try {
      const submitter = await this.prisma.salesUser.findFirst({
        where: { clientId, userId: submitterLoginUserId, deletedAt: null },
        select: { id: true },
      });
      if (!submitter) return; // self-KYC / non-sales submitter → nobody to route to

      const approverUserId = await this.approverLoginId(clientId, submitter.id);
      if (!approverUserId) return;

      await this.enqueuePush(
        approverUserId,
        'KYC pending approval',
        `A new KYC for ${outletLabel} is pending your approval.`,
        '/sales/kyc',
      );
    } catch (e) {
      this.logger.warn(`[sales-notify] kycSubmittedForApproval failed: ${e}`);
    }
  }

  /* ── Event 3: KYC rejected / re-upload → notify the responsible rep ─────────── */

  /**
   * Notify the rep responsible for an outlet that its KYC was rejected or sent back
   * for re-upload. `partnerId` is the submission's owning partner; the outlet (and
   * thus its active assignment) is resolved from it.
   */
  async kycBounced(
    clientId: string,
    partnerId: string | null,
    status: 'REJECTED' | 'RE_UPLOAD_REQUIRED',
    reason: string | null,
  ): Promise<void> {
    if (!partnerId) return;
    try {
      const outlet = await this.prisma.outlet.findFirst({
        where: { clientId, partnerId },
        select: { id: true, name: true },
      });
      if (!outlet) return;

      const rep = await this.responsibleRep(clientId, outlet.id);
      if (!rep) return;

      const label = outlet.name || 'an outlet';
      const verb = status === 'REJECTED' ? 'was rejected' : 'needs re-upload';
      const tail = reason ? ` Reason: ${reason}` : '';
      await this.enqueuePush(
        rep.userId,
        status === 'REJECTED' ? 'KYC rejected' : 'KYC re-upload required',
        `KYC for ${label} ${verb}.${tail}`,
        '/sales/kyc',
      );
    } catch (e) {
      this.logger.warn(`[sales-notify] kycBounced failed: ${e}`);
    }
  }

  /* ── Event 4: targets uploaded → notify assigned rep (XSR) + manager (SO) ───── */

  /**
   * Notify, for every outlet that received a target, the assigned rep (XSR) AND that
   * rep's first active manager (the SO). De-duplicated, so a manager covering many
   * outlets in the batch gets ONE push. No-op for an empty outlet set. Keyed by
   * outletCode (what the targets upload carries), resolved to assignments via the
   * tenant-scoped outlet relation.
   */
  async targetsUploaded(clientId: string, outletCodes: string[]): Promise<void> {
    const codes = Array.from(new Set(outletCodes.filter(Boolean)));
    if (codes.length === 0) return;
    try {
      // Active assignment per outlet → the responsible (XSR) sales user.
      const assignments = await this.prisma.salesUserAssignment.findMany({
        where: {
          unassignedAt: null,
          outlet: { clientId, outletCode: { in: codes } },
          salesUser: { clientId, deletedAt: null },
        },
        select: { salesUser: { select: { id: true, userId: true } } },
      });
      if (assignments.length === 0) return;

      // One tenant node list for all approver walks.
      const nodes = await this.tenantNodes(clientId);
      const nodeUserId = new Map(
        (await this.prisma.salesUser.findMany({
          where: { clientId, deletedAt: null },
          select: { id: true, userId: true },
        })).map((n) => [n.id, n.userId]),
      );

      const recipients = new Set<string>();
      for (const a of assignments) {
        if (!a.salesUser) continue;
        recipients.add(a.salesUser.userId); // the XSR
        const soId = firstActiveApproverId(a.salesUser.id, nodes); // the SO (first active manager)
        const soUserId = soId ? nodeUserId.get(soId) : undefined;
        if (soUserId) recipients.add(soUserId);
      }

      await Promise.all(
        Array.from(recipients).map((userId) =>
          this.enqueuePush(
            userId,
            'New targets uploaded',
            'New targets have been uploaded. Check your dashboard.',
            '/sales/targets',
          ),
        ),
      );
    } catch (e) {
      this.logger.warn(`[sales-notify] targetsUploaded failed: ${e}`);
    }
  }

  /* ── Resolvers (tenant-scoped) ─────────────────────────────────────────────── */

  /** The login userId for a SalesUser.id (tenant-scoped, non-deleted). */
  private async salesUserLoginId(clientId: string, salesUserId: string): Promise<string | null> {
    const su = await this.prisma.salesUser.findFirst({
      where: { id: salesUserId, clientId, deletedAt: null },
      select: { userId: true },
    });
    return su?.userId ?? null;
  }

  /** The rep actively assigned to an outlet, tenant-scoped. */
  private async responsibleRep(
    clientId: string,
    outletId: string,
  ): Promise<{ salesUserId: string; userId: string } | null> {
    const a = await this.prisma.salesUserAssignment.findFirst({
      where: { outletId, unassignedAt: null, salesUser: { clientId, deletedAt: null } },
      orderBy: { assignedAt: 'desc' },
      select: { salesUser: { select: { id: true, userId: true } } },
    });
    if (!a?.salesUser) return null;
    return { salesUserId: a.salesUser.id, userId: a.salesUser.userId };
  }

  /** Login userId of the first active manager up a submitter's chain (the approver). */
  private async approverLoginId(clientId: string, submitterSalesUserId: string): Promise<string | null> {
    const nodes = await this.tenantNodes(clientId);
    const approverSalesUserId = firstActiveApproverId(submitterSalesUserId, nodes);
    if (!approverSalesUserId) return null;
    return this.salesUserLoginId(clientId, approverSalesUserId);
  }

  /** Tenant-scoped reporting node list for the hierarchy walk. */
  private async tenantNodes(clientId: string): Promise<SalesApproverNode[]> {
    return this.prisma.salesUser.findMany({
      where: { clientId, deletedAt: null },
      select: { id: true, reportingToId: true, isActive: true },
    });
  }

  /** Enqueue a single PUSH row. Never throws (caller already wraps, belt-and-suspenders). */
  private async enqueuePush(
    userId: string,
    subject: string,
    body: string,
    url?: string,
  ): Promise<void> {
    await this.notifications
      .enqueue({
        userId,
        channel: 'PUSH',
        subject,
        body,
        variables: url ? { url } : undefined,
      })
      .catch((e) => this.logger.warn(`[sales-notify] enqueue failed for ${userId}: ${e}`));
  }
}
