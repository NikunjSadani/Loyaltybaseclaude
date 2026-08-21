import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isValidPhone } from '../common/audience/audience.helpers';
import { buildXlsx } from '../common/xlsx';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import {
  AudienceResolution,
  AudienceScope,
  ResolvedRecipient,
  WhatsappAudienceService,
} from './whatsapp-audience.service';
import { WhatsappSendWorker } from './whatsapp-send.worker';
import {
  deriveVariables,
  renderBody,
  templateVariableCount,
} from './whatsapp-render.helper';
import {
  CreateBroadcastDto,
  PreviewBroadcastDto,
  TestSendDto,
} from './dto/whatsapp-broadcast.dto';

const SAMPLE_SIZE = 3;
const MAX_TEST_NUMBERS = 5;

/**
 * WhatsApp Broadcasts — campaign orchestration (Gifsy OWNER only).
 *
 * DATA-BOUNDARY ENFORCEMENT: every method re-asserts the caller is the platform OWNER
 * (`role === 'GIFSY_ADMIN'`, NOT the broader isGifsyOperator which also admits GIFSY_STAFF)
 * and pins every query to the operator's ASSUMED tenant (`user.clientId`), never a body
 * value — so a tenant CLIENT_ADMIN (already 403'd at the @Roles guard) or a GIFSY_STAFF can
 * never reach this data even if a route were mis-annotated. Sends are fire-and-forget /
 * worker-drained and NEVER throw into a request that must succeed.
 */
@Injectable()
export class WhatsappBroadcastsService {
  private readonly logger = new Logger(WhatsappBroadcastsService.name);
  /** Window in which an identical create ({clientId,templateId,title,recipientCount}) is treated as a retry. */
  private static readonly CREATE_DEDUP_WINDOW_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: WhatsappTemplatesService,
    private readonly audience: WhatsappAudienceService,
    private readonly msg91: Msg91Service,
    private readonly worker: WhatsappSendWorker,
  ) {}

  /** Fail-closed OWNER gate — GIFSY_ADMIN only (excludes GIFSY_STAFF), at the data boundary. */
  private assertOperator(user: JwtPayload): void {
    if (user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('WhatsApp broadcasts are Gifsy owner only.');
    }
  }

  /** Load a template that belongs to the tenant AND is ACTIVE (only ACTIVE is sendable). */
  private async loadActiveTemplate(user: JwtPayload, templateId: string) {
    const template = await this.templates.getOwned(user, templateId);
    if (template.status !== 'ACTIVE') {
      throw new BadRequestException('Template is archived and cannot be used.');
    }
    return template;
  }

  /** Resolve the audience for a preview/create DTO (FILTER or EXCEL), validating the shape. */
  private async resolveAudience(
    user: JwtPayload,
    dto: PreviewBroadcastDto,
  ): Promise<AudienceResolution> {
    if (dto.mode === 'FILTER') {
      if (!dto.scope) {
        throw new BadRequestException('scope is required for FILTER mode.');
      }
      return this.audience.resolveFilter(
        user.clientId,
        dto.scope as AudienceScope,
        dto.filter,
      );
    }
    // EXCEL
    if (!dto.excelRows || dto.excelRows.length === 0) {
      throw new BadRequestException('excelRows is required for EXCEL mode.');
    }
    return this.audience.resolveExcel(user.clientId, dto.excelRows);
  }

  /** Ordered variable values for a resolved recipient (FILTER derives; EXCEL uses uploaded). */
  private variablesFor(
    dto: PreviewBroadcastDto,
    r: ResolvedRecipient,
    varCount: number,
  ): string[] {
    if (dto.mode === 'EXCEL') {
      const vals = r.variables ?? [];
      // Normalise to the template's variable count (pad with '' / truncate) so every
      // recipient row is consistent and renderBody never leaves a literal placeholder.
      return Array.from({ length: varCount }, (_, i) => vals[i] ?? '');
    }
    return deriveVariables(r.fields, dto.variableMapping, varCount);
  }

  /**
   * Preview — resolve audience → count + dedup + invalidCount + sample rendered messages.
   * Sends nothing and writes NO rows.
   */
  async preview(user: JwtPayload, dto: PreviewBroadcastDto) {
    this.assertOperator(user);
    const template = await this.loadActiveTemplate(user, dto.templateId);
    const resolution = await this.resolveAudience(user, dto);

    const varCount = templateVariableCount(
      template.bodyText,
      template.variableContract as { index: number }[] | null,
    );
    const sample = resolution.recipients.slice(0, SAMPLE_SIZE).map((r) => {
      const variables = this.variablesFor(dto, r, varCount);
      return { phone: r.phone, renderedBody: renderBody(template.bodyText, variables) };
    });

    return {
      recipientCount: resolution.recipientCount,
      deduped: resolution.dedupedCount,
      invalidCount: resolution.invalidCount,
      suppressedCount: resolution.suppressedCount,
      sample,
    };
  }

  /**
   * Create a broadcast: resolve audience → write the campaign + one QUEUED recipient row
   * per recipient (variables frozen at create time) → enqueue (status SENDING, kicks the
   * worker) or schedule (status SCHEDULED, drained when due). crqid = each row's id.
   */
  async create(user: JwtPayload, dto: CreateBroadcastDto) {
    this.assertOperator(user);
    const template = await this.loadActiveTemplate(user, dto.templateId);
    const resolution = await this.resolveAudience(user, dto);

    if (resolution.recipientCount === 0) {
      throw new BadRequestException('No valid recipients resolved for this audience.');
    }

    // Hard ceiling — a single blast can never exceed the configured max (guards a runaway
    // FILTER / a fat-fingered upload from billing an unbounded audience). Configurable.
    const maxRecipients =
      Number(process.env.WHATSAPP_MAX_RECIPIENTS ?? '') || 100_000;
    if (resolution.recipientCount > maxRecipients) {
      throw new BadRequestException(
        `Audience of ${resolution.recipientCount} exceeds the maximum of ${maxRecipients} recipients per broadcast.`,
      );
    }

    // Preview→create drift guard: if the operator confirmed a count at preview and the LIVE
    // re-resolved audience has since grown beyond a small tolerance, refuse (409) rather than
    // silently send/bill more than was confirmed. Under-count (fewer) is fine.
    if (dto.expectedCount != null) {
      const tolerance = Math.max(5, Math.ceil(dto.expectedCount * 0.05));
      if (resolution.recipientCount > dto.expectedCount + tolerance) {
        throw new ConflictException(
          `Audience grew from the previewed ${dto.expectedCount} to ${resolution.recipientCount} recipients. Re-preview and confirm before sending.`,
        );
      }
    }

    // Idempotency: a retried / double-submitted create (same tenant, template, title, and
    // resolved recipientCount within a short window) returns the FIRST campaign instead of
    // spawning a second full (billable) blast.
    const dupe = await this.prisma.whatsappBroadcast.findFirst({
      where: {
        clientId: user.clientId,
        templateId: template.id,
        title: dto.title,
        recipientCount: resolution.recipientCount,
        createdAt: {
          gte: new Date(Date.now() - WhatsappBroadcastsService.CREATE_DEDUP_WINDOW_MS),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (dupe) {
      this.logger.warn(
        `[whatsapp-broadcast] duplicate create suppressed — returning existing ${dupe.id}`,
      );
      return { id: dupe.id, broadcast: dupe };
    }

    const varCount = templateVariableCount(
      template.bodyText,
      template.variableContract as { index: number }[] | null,
    );

    // Future schedule → SCHEDULED (worker promotes it when due); else SENDING now.
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const isScheduled = scheduledAt != null && scheduledAt.getTime() > Date.now();
    const status = isScheduled ? 'SCHEDULED' : 'SENDING';

    // audienceConfig is a frozen snapshot of the targeting for the audit trail + report.
    const audienceConfig = {
      mode: dto.mode,
      scope: dto.scope ?? null,
      filter: dto.filter ?? null,
      variableMapping: dto.variableMapping ?? null,
      excel: dto.mode === 'EXCEL' ? { rowCount: dto.excelRows?.length ?? 0 } : null,
    } as unknown as Prisma.InputJsonValue;

    const broadcast = await this.prisma.$transaction(async (tx) => {
      const b = await tx.whatsappBroadcast.create({
        data: {
          clientId: user.clientId,
          templateId: template.id,
          title: dto.title,
          audienceMode: dto.mode,
          audienceScope: (dto.scope ?? null) as
            | 'OUTLETS'
            | 'SALES'
            | 'BOTH'
            | null,
          audienceConfig,
          status,
          scheduledAt: scheduledAt ?? undefined,
          recipientCount: resolution.recipientCount,
          createdByUserId: user.sub ?? null,
        },
      });

      await tx.whatsappBroadcastRecipient.createMany({
        data: resolution.recipients.map((r) => ({
          broadcastId: b.id,
          clientId: user.clientId,
          phone: r.phone,
          variables: this.variablesFor(dto, r, varCount) as unknown as Prisma.InputJsonValue,
          status: 'QUEUED' as const,
        })),
      });

      return b;
    });

    // Kick the drain for an immediate send (fire-and-forget; the worker's own gate +
    // `running` guard apply). A SCHEDULED broadcast is left for the interval/drain to
    // promote when due. Never awaited / never throws into this request.
    if (!isScheduled) {
      void this.worker.drain().catch((e) =>
        this.logger.warn(`[whatsapp-broadcast] post-create drain kick failed: ${e}`),
      );
    }

    // FE reads `res.data.id` to route to the new campaign; keep `broadcast` for completeness.
    return { id: broadcast.id, broadcast };
  }

  /** History — tenant-scoped, newest first, with the template name. */
  async list(user: JwtPayload) {
    this.assertOperator(user);
    const broadcasts = await this.prisma.whatsappBroadcast.findMany({
      where: { clientId: user.clientId },
      orderBy: { createdAt: 'desc' },
      include: { template: { select: { name: true, msg91TemplateName: true } } },
    });
    // FE reads `.items` (or a bare array). Surface templateName as a flat sibling so the
    // list row's subtitle resolves without reaching into the nested template object.
    const items = broadcasts.map((b) => ({ ...b, templateName: b.template?.name ?? null }));
    return { items };
  }

  /** Detail — the campaign + a LIVE status funnel + failure-reason breakdown. */
  async detail(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const broadcast = await this.prisma.whatsappBroadcast.findFirst({
      where: { id, clientId: user.clientId },
      include: { template: { select: { name: true, msg91TemplateName: true, bodyText: true } } },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    const grouped = await this.prisma.whatsappBroadcastRecipient.groupBy({
      by: ['status'],
      where: { broadcastId: id, clientId: user.clientId },
      _count: { _all: true },
    });
    const funnel: Record<string, number> = {
      QUEUED: 0,
      SENDING: 0,
      SENT: 0,
      DELIVERED: 0,
      READ: 0,
      FAILED: 0,
      SKIPPED: 0,
    };
    for (const g of grouped) funnel[g.status] = g._count._all;

    // Top failure reasons (live, from the rows) — capped so the payload stays small.
    const failedRows = await this.prisma.whatsappBroadcastRecipient.findMany({
      where: { broadcastId: id, clientId: user.clientId, status: 'FAILED' },
      select: { errorReason: true },
      take: 1000,
    });
    const reasonCounts = new Map<string, number>();
    for (const r of failedRows) {
      const key = r.errorReason ?? 'Unknown';
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const failureReasons = [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // FLAT shape: the FE reads campaign fields at the top level
    // (title/status/sentCount/deliveredCount/readCount/failedCount/recipientCount/
    // scheduledAt/sentAt), so spread the broadcast up and keep `funnel` + `failureReasons`
    // (and a flat `templateName` + derived `queuedCount`) as siblings.
    return {
      ...broadcast,
      templateName: broadcast.template?.name ?? null,
      queuedCount: funnel.QUEUED + funnel.SENDING,
      funnel,
      failureReasons,
    };
  }

  /**
   * Test-send to 1..5 numbers — no campaign rows, no crqid. Fire-and-forget per number
   * (a send throw is caught + counted), so this NEVER throws for a bad number.
   */
  async testSend(user: JwtPayload, dto: TestSendDto) {
    this.assertOperator(user);
    const template = await this.loadActiveTemplate(user, dto.templateId);
    if (dto.phones.length > MAX_TEST_NUMBERS) {
      throw new BadRequestException(`At most ${MAX_TEST_NUMBERS} test numbers.`);
    }

    const varCount = templateVariableCount(
      template.bodyText,
      template.variableContract as { index: number }[] | null,
    );
    const variables = Array.from({ length: varCount }, (_, i) => dto.variables?.[i] ?? '');

    let sent = 0;
    let failed = 0;
    for (const raw of dto.phones) {
      const phone = raw.replace(/\D/g, '').slice(-10);
      // A malformed number would be silently DROPPED by sendWhatsappTemplate (no dispatch,
      // no throw) — count it as failed rather than as a phantom "sent".
      if (!isValidPhone(phone)) {
        failed++;
        continue;
      }
      try {
        await this.msg91.sendWhatsappTemplate(phone, template.msg91TemplateName, variables, {
          languageCode: template.languageCode,
        });
        sent++;
      } catch (e) {
        failed++;
        this.logger.warn(`[whatsapp-broadcast] test-send failed for a number: ${e}`);
      }
    }
    return { sent, failed };
  }

  /**
   * Resend to this campaign's FAILED recipients — as a NEW EXCEL-mode broadcast snapshotting
   * those phones + their frozen variables. The original is untouched.
   *
   * BILLING-SAFE: we re-target status:'FAILED' ONLY. We deliberately do NOT re-target
   * "SENT but not yet DELIVERED/READ" rows: a SENT message was already billed, and its
   * delivery webhook can simply be lagging or unwired — re-billing the whole undelivered set
   * on that basis would double-charge the audience.
   */
  async resendFailed(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const source = await this.prisma.whatsappBroadcast.findFirst({
      where: { id, clientId: user.clientId },
      include: { template: { select: { id: true, status: true } } },
    });
    if (!source) throw new NotFoundException('Broadcast not found');
    if (source.template.status !== 'ACTIVE') {
      throw new BadRequestException('Template is archived — cannot resend.');
    }

    const targets = await this.prisma.whatsappBroadcastRecipient.findMany({
      where: {
        broadcastId: id,
        clientId: user.clientId,
        status: 'FAILED',
      },
      select: { phone: true, variables: true },
    });
    if (targets.length === 0) {
      throw new BadRequestException('No failed recipients to resend.');
    }

    const broadcast = await this.prisma.$transaction(async (tx) => {
      const b = await tx.whatsappBroadcast.create({
        data: {
          clientId: user.clientId,
          templateId: source.templateId,
          title: `${source.title} (resend)`,
          audienceMode: 'EXCEL',
          audienceScope: null,
          audienceConfig: {
            mode: 'EXCEL',
            resendOf: source.id,
          } as unknown as Prisma.InputJsonValue,
          status: 'SENDING',
          recipientCount: targets.length,
          createdByUserId: user.sub ?? null,
        },
      });
      await tx.whatsappBroadcastRecipient.createMany({
        data: targets.map((t) => ({
          broadcastId: b.id,
          clientId: user.clientId,
          phone: t.phone,
          variables: (t.variables ?? []) as Prisma.InputJsonValue,
          status: 'QUEUED' as const,
        })),
      });
      return b;
    });

    void this.worker.drain().catch((e) =>
      this.logger.warn(`[whatsapp-broadcast] resend drain kick failed: ${e}`),
    );

    // FE reads `res.data.id` to route to the new resend campaign; keep `broadcast` too.
    return { id: broadcast.id, broadcast };
  }

  /**
   * Cancel a SCHEDULED / not-fully-sent campaign: flip the broadcast to CANCELLED and
   * mark every still-QUEUED recipient SKIPPED (already-sent rows are untouched — you
   * can't un-send). A terminal (SENT/CANCELLED) campaign can't be cancelled.
   */
  async cancel(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const broadcast = await this.prisma.whatsappBroadcast.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');
    if (broadcast.status === 'SENT' || broadcast.status === 'CANCELLED') {
      throw new BadRequestException(`Cannot cancel a ${broadcast.status} broadcast.`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.whatsappBroadcast.update({
        where: { id },
        data: { status: 'CANCELLED' },
      }),
      this.prisma.whatsappBroadcastRecipient.updateMany({
        where: { broadcastId: id, clientId: user.clientId, status: 'QUEUED' },
        data: { status: 'SKIPPED' },
      }),
    ]);
    return { broadcast: updated };
  }

  /**
   * Excel report — one row per recipient: phone, each variable, status, sent/delivered/
   * read timestamps, failure reason. Reuses the shared injection-safe xlsx builder.
   */
  async report(user: JwtPayload, id: string): Promise<StreamableFile> {
    this.assertOperator(user);
    const broadcast = await this.prisma.whatsappBroadcast.findFirst({
      where: { id, clientId: user.clientId },
      include: { template: { select: { name: true, variableContract: true, bodyText: true } } },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    const recipients = await this.prisma.whatsappBroadcastRecipient.findMany({
      where: { broadcastId: id, clientId: user.clientId },
      orderBy: { createdAt: 'asc' },
    });

    const varCount = templateVariableCount(
      broadcast.template.bodyText,
      broadcast.template.variableContract as { index: number }[] | null,
    );
    const contract =
      (broadcast.template.variableContract as { index: number; label: string }[] | null) ?? [];
    const labelForIndex = new Map<number, string>();
    for (const c of contract) labelForIndex.set(c.index, c.label);
    const varHeader = (i: number) => labelForIndex.get(i) ?? `Variable ${i}`;

    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const rows = recipients.map((r) => {
      const vars = Array.isArray(r.variables) ? (r.variables as unknown[]) : [];
      const row: Record<string, unknown> = { Phone: r.phone };
      for (let i = 1; i <= varCount; i++) {
        row[varHeader(i)] = vars[i - 1] != null ? String(vars[i - 1]) : '';
      }
      row['Status'] = r.status;
      row['Sent At'] = iso(r.sentAt);
      row['Delivered At'] = iso(r.deliveredAt);
      row['Read At'] = iso(r.readAt);
      row['Failure Reason'] = r.errorReason ?? '';
      row['MSG91 Request Id'] = r.msg91RequestId ?? '';
      return row;
    });

    // buildXlsx derives the header from the first row's keys; an empty campaign still
    // needs a header, so seed one placeholder row when there are no recipients.
    const sheetRows =
      rows.length > 0
        ? rows
        : [{ Phone: '', Status: '', 'Sent At': '', 'Delivered At': '', 'Read At': '', 'Failure Reason': '' }];

    const buffer = buildXlsx([{ name: 'Recipients', rows: sheetRows }]);
    const safeTitle = broadcast.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'broadcast';
    const filename = `whatsapp_${safeTitle}_${new Date().toISOString().split('T')[0]}.xlsx`;

    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
