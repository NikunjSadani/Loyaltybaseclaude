/**
 * TargetsService — P4 Stream T.
 *
 * Implements:
 *   1. KpiDef CRUD (admin): list / upsert / delete / seed Deoleo defaults.
 *   2. Target template download: streams an .xlsx template (outlet roster ×
 *      enabled KpiDefs × requested months).
 *   3. Target upload (verbatim): parses an uploaded .xlsx, validates, and writes
 *      OutletTarget rows inside a TargetUploadBatch. Blank cell = omitted key.
 *   4. Batch / target row listing.
 *
 * Every query is tenant-scoped by clientId from the JWT.
 * NO computation anywhere — numbers are stored verbatim.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  ListKpisQueryDto,
  UpsertKpiDefDto,
  TemplateQueryDto,
  ListBatchesQueryDto,
  ListTargetsQueryDto,
} from './dto/targets.dto';
import {
  generateTargetTemplateBuffer,
  parseTargetUploadBuffer,
  KpiDefLike,
  OutletLike,
} from './targets.helpers';

// ── Deoleo default KPI seeds (ported from platform/src/lib/platform/tenant-kpi-config.ts) ──

const DEOLEO_DEFAULT_KPIS: Array<{
  code: string;
  label: string;
  unit: string;
  isPrimary: boolean;
  hasNameOverride: boolean;
  nameOverrideLabel: string | null;
  order: number;
  enabled: boolean;
}> = [
  {
    code: 'MONTH_TGT', label: 'Month Target', unit: 'cases',
    isPrimary: true, hasNameOverride: false, nameOverrideLabel: null,
    order: 1, enabled: true,
  },
  {
    code: 'FOCUS_PACK_1', label: 'Focus Pack - 1', unit: 'cases',
    isPrimary: false, hasNameOverride: true, nameOverrideLabel: 'Focus Pack 1 Name',
    order: 2, enabled: true,
  },
  {
    code: 'FOCUS_PACK_2', label: 'Focus Pack - 2', unit: 'cases',
    isPrimary: false, hasNameOverride: true, nameOverrideLabel: 'Focus Pack 2 Name',
    order: 3, enabled: true,
  },
  {
    code: 'FOCUS_CATEGORY', label: 'Focus Category', unit: 'cases',
    isPrimary: false, hasNameOverride: true, nameOverrideLabel: 'Focus Category Name',
    order: 4, enabled: true,
  },
  {
    code: 'CONSISTENCY', label: 'Consistency Target', unit: 'cases',
    isPrimary: false, hasNameOverride: false, nameOverrideLabel: null,
    order: 5, enabled: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class TargetsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── KpiDef: list ──────────────────────────────────────────────────────────

  async listKpis(user: JwtPayload, q: ListKpisQueryDto) {
    const enabledOnly = q.enabledOnly === 'true';
    return this.prisma.kpiDef.findMany({
      where: {
        clientId: user.clientId,
        ...(enabledOnly ? { enabled: true } : {}),
      },
      orderBy: { order: 'asc' },
    });
  }

  // ─── KpiDef: upsert ────────────────────────────────────────────────────────

  /**
   * Upsert a KpiDef row by (clientId, code).
   * Creates if it does not exist; updates only the supplied fields otherwise.
   */
  async upsertKpi(user: JwtPayload, dto: UpsertKpiDefDto) {
    const { code, label, unit, isPrimary, hasNameOverride, nameOverrideLabel, order, enabled } =
      dto;

    return this.prisma.kpiDef.upsert({
      where: { clientId_code: { clientId: user.clientId, code } },
      create: {
        clientId: user.clientId,
        code,
        label,
        unit: unit ?? '',
        isPrimary: isPrimary ?? false,
        hasNameOverride: hasNameOverride ?? false,
        nameOverrideLabel: nameOverrideLabel ?? null,
        order: order ?? 0,
        enabled: enabled ?? true,
      },
      update: {
        label,
        ...(unit !== undefined ? { unit } : {}),
        ...(isPrimary !== undefined ? { isPrimary } : {}),
        ...(hasNameOverride !== undefined ? { hasNameOverride } : {}),
        ...(nameOverrideLabel !== undefined ? { nameOverrideLabel } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    });
  }

  // ─── KpiDef: delete ────────────────────────────────────────────────────────

  async deleteKpi(user: JwtPayload, id: string) {
    const kpi = await this.prisma.kpiDef.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!kpi) throw new NotFoundException('KpiDef not found');
    await this.prisma.kpiDef.delete({ where: { id, clientId: user.clientId } });
    return { deleted: id };
  }

  // ─── KpiDef: seed Deoleo defaults ──────────────────────────────────────────

  /**
   * Seed the Deoleo default KPI set for tenants that have no KpiDef rows yet.
   * If the tenant already has any KpiDef rows, this is a no-op (returns existing
   * count so the caller can detect the skip).
   */
  async seedDeoleoKpis(user: JwtPayload) {
    const existing = await this.prisma.kpiDef.count({
      where: { clientId: user.clientId },
    });

    if (existing > 0) {
      return { seeded: 0, skippedReason: `Tenant already has ${existing} KPI(s) defined` };
    }

    await this.prisma.kpiDef.createMany({
      data: DEOLEO_DEFAULT_KPIS.map((k) => ({ ...k, clientId: user.clientId })),
      skipDuplicates: true,
    });

    return { seeded: DEOLEO_DEFAULT_KPIS.length };
  }

  // ─── Template download ──────────────────────────────────────────────────────

  /**
   * Build and return an xlsx template buffer.
   * Columns = enabled KpiDefs × months; rows = active outlet roster.
   */
  async getTemplateBuffer(user: JwtPayload, q: TemplateQueryDto): Promise<Buffer> {
    // Parse months
    const months = q.months
      .split(',')
      .map((m) => m.trim())
      .filter((m) => /^\d{4}-\d{2}$/.test(m));

    if (months.length === 0) {
      throw new BadRequestException(
        'At least one valid YYYY-MM month is required in the "months" query param',
      );
    }

    // Fetch enabled KPIs for the tenant
    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: { order: 'asc' },
    });

    if (kpiRows.length === 0) {
      throw new BadRequestException(
        'No enabled KPIs found for this tenant. Seed KPIs first via POST /v1/admin/kpis/seed-defaults.',
      );
    }

    // Fetch active outlet roster
    const outlets = await this.prisma.outlet.findMany({
      where: {
        clientId: user.clientId,
        isActive: true,
        deletedAt: null,
      },
      include: { outletType: { select: { code: true } } },
      orderBy: { outletCode: 'asc' },
    });

    const kpis: KpiDefLike[] = kpiRows.map((k) => ({
      code: k.code,
      label: k.label,
      isPrimary: k.isPrimary,
      hasNameOverride: k.hasNameOverride,
      nameOverrideLabel: k.nameOverrideLabel ?? null,
      order: k.order,
      enabled: k.enabled,
    }));

    const outletList: OutletLike[] = outlets.map((o) => ({
      outletCode: o.outletCode,
      name: o.name,
      outletType: o.outletType.code,
    }));

    return generateTargetTemplateBuffer(kpis, months, outletList);
  }

  // ─── Target upload ──────────────────────────────────────────────────────────

  /**
   * Parse and store targets from an uploaded .xlsx file.
   *
   * Blank cell → omitted key (not stored as 0). Numbers are stored verbatim.
   * Uses upsert on (clientId, outletCode, month) so re-uploads are idempotent.
   * Tracks totals on a TargetUploadBatch row.
   */
  async uploadTargets(user: JwtPayload, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    // ── Fetch KPIs ────────────────────────────────────────────────────────────
    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: { order: 'asc' },
    });

    if (kpiRows.length === 0) {
      throw new BadRequestException(
        'No enabled KPIs found. Seed KPIs first via POST /v1/admin/kpis/seed-defaults.',
      );
    }

    // ── Fetch active outlet codes ─────────────────────────────────────────────
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, isActive: true, deletedAt: null },
      select: { outletCode: true, name: true, outletType: { select: { code: true } } },
    });

    const knownOutletCodes = new Set(outlets.map((o) => o.outletCode));
    const outletMeta = new Map(
      outlets.map((o) => [o.outletCode, { name: o.name, type: o.outletType.code }]),
    );

    // ── Parse the upload ───────────────────────────────────────────────────────
    const kpis: KpiDefLike[] = kpiRows.map((k) => ({
      code: k.code,
      label: k.label,
      isPrimary: k.isPrimary,
      hasNameOverride: k.hasNameOverride,
      nameOverrideLabel: k.nameOverrideLabel ?? null,
      order: k.order,
      enabled: k.enabled,
    }));

    // A malformed/corrupt or empty workbook makes XLSX.read (or sheet access)
    // throw — surface a clean 400 rather than a 500 from the global filter.
    let parseResult: ReturnType<typeof parseTargetUploadBuffer>;
    try {
      parseResult = parseTargetUploadBuffer(file.buffer, kpis, knownOutletCodes);
    } catch {
      throw new BadRequestException('Invalid or corrupted xlsx file');
    }

    // ── Determine months present in the upload ────────────────────────────────
    const monthsInUpload = new Set<string>();
    for (const [month] of Object.entries(parseResult.acceptedTargets)) {
      monthsInUpload.add(month);
    }

    // We create one batch per upload (regardless of how many months).
    // If multiple months are present, we use the earliest month as the batch.month.
    const sortedMonths = [...monthsInUpload].sort();
    const batchMonth = sortedMonths[0] ?? 'unknown';

    const totalRows      = parseResult.summary.total;
    const acceptedCount  = parseResult.summary.accepted;
    const rejectedCount  = parseResult.summary.rejected;

    // ── Persist inside a transaction ──────────────────────────────────────────
    const batch = await this.prisma.$transaction(async (tx) => {
      const batchRecord = await tx.targetUploadBatch.create({
        data: {
          clientId:     user.clientId,
          uploadedById: user.sub,
          month:        batchMonth,
          totalRows,
          acceptedCount,
          rejectedCount,
          status: 'COMPLETED',
        },
      });

      // Write one OutletTarget per (outletCode, month) with non-blank values
      for (const [month, outletMap] of Object.entries(parseResult.acceptedTargets)) {
        for (const [outletCode, kpiMap] of Object.entries(outletMap)) {
          if (Object.keys(kpiMap).length === 0) continue; // safety: skip fully-blank

          const meta = outletMeta.get(outletCode);

          await tx.outletTarget.upsert({
            where: {
              clientId_outletCode_month: { clientId: user.clientId, outletCode, month },
            },
            create: {
              clientId:     user.clientId,
              outletCode,
              outletName:   meta?.name ?? outletCode,
              outletType:   meta?.type ?? '',
              month,
              targetValues: kpiMap as unknown as Prisma.InputJsonValue,
              batchId:      batchRecord.id,
            },
            update: {
              targetValues: kpiMap as unknown as Prisma.InputJsonValue,
              outletName:   meta?.name ?? outletCode,
              outletType:   meta?.type ?? '',
              batchId:      batchRecord.id,
              updatedAt:    new Date(),
            },
          });
        }
      }

      return batchRecord;
    });

    return {
      batchId:       batch.id,
      month:         batchMonth,
      monthsInBatch: sortedMonths,
      totalRows,
      acceptedCount,
      rejectedCount,
      rows:          parseResult.rows,
    };
  }

  // ─── List batches ──────────────────────────────────────────────────────────

  async listBatches(user: JwtPayload, q: ListBatchesQueryDto) {
    return this.prisma.targetUploadBatch.findMany({
      where: {
        clientId: user.clientId,
        ...(q.month ? { month: q.month } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── List targets ──────────────────────────────────────────────────────────

  async listTargets(user: JwtPayload, q: ListTargetsQueryDto) {
    if (!q.month) throw new BadRequestException('month query parameter is required');

    return this.prisma.outletTarget.findMany({
      where: {
        clientId: user.clientId,
        month: q.month,
        ...(q.outletCode ? { outletCode: q.outletCode } : {}),
      },
      orderBy: { outletCode: 'asc' },
    });
  }
}
