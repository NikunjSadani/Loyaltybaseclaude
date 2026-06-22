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
  ConflictException,
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
  ListAchievementBatchesQueryDto,
  ListAchievementsQueryDto,
  PaceQueryDto,
} from './dto/targets.dto';
import {
  generateTargetTemplateBuffer,
  buildResolvedTargetsBuffer,
  parseTargetUploadBuffer,
  currentMonthKey,
  isMonthLocked,
  kpiCodeKeys,
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
      // Stable, deterministic order: primary tiebreak on `code` so the
      // "first primary" selection can never flip on equal `order`.
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
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

    // Invariant: at most ONE primary KpiDef per tenant. The upsert is keyed by
    // (clientId, code), so when this write makes a KPI primary we first demote
    // every OTHER KPI for the same clientId (code != incoming code) in the SAME
    // transaction, then write this row as primary. This is atomic — a concurrent
    // reader never sees two primaries, and either both steps land or neither does.
    // The DB partial unique index (kpi_defs_one_primary_per_client) is the
    // race-condition backstop: a concurrent writer that slips between the demote
    // and the upsert surfaces a P2002 → ConflictException (409), never two primaries.
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (isPrimary === true) {
          await tx.kpiDef.updateMany({
            where: { clientId: user.clientId, NOT: { code } },
            data: { isPrimary: false },
          });
        }

        return tx.kpiDef.upsert({
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
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another KPI is already primary for this client — retry.',
        );
      }
      throw error;
    }
  }

  // ─── KpiDef: set primary (MOVES the single primary) ──────────────────────────

  /**
   * Make `kpiId` the SINGLE primary KPI for the caller's tenant.
   *
   * Invariant: at most ONE primary KpiDef per tenant — choosing a primary MOVES
   * it. In one transaction we (a) verify the KPI is this tenant's, (b) demote
   * every OTHER primary (by id, NOT by code), then (c) set this one primary.
   * Atomic: a concurrent reader never sees two primaries.
   *
   * The DB partial unique index (kpi_defs_one_primary_per_client) is the
   * race-condition backstop: a concurrent writer slipping between the demote and
   * the set surfaces a P2002 → ConflictException (409), never two primaries.
   */
  async setPrimary(user: JwtPayload, kpiId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const kpi = await tx.kpiDef.findFirst({
          where: { id: kpiId, clientId: user.clientId },
        });
        if (!kpi) throw new NotFoundException('KpiDef not found');

        await tx.kpiDef.updateMany({
          where: { clientId: user.clientId, NOT: { id: kpiId } },
          data: { isPrimary: false },
        });

        return tx.kpiDef.update({
          where: { id: kpiId },
          data: { isPrimary: true },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another KPI is already primary for this client — retry.',
        );
      }
      throw error;
    }
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
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
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

  /**
   * GET /v1/admin/targets/export?month=YYYY-MM — "final targets" export.
   * Dumps the stored OutletTarget.targetValues per outlet for the month, verbatim
   * (no compute/resolution). Tenant-scoped. Blank cell = KPI not configured.
   */
  async exportTargetsBuffer(user: JwtPayload, month: string): Promise<Buffer> {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('A valid YYYY-MM "month" query param is required');
    }

    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
    });
    if (kpiRows.length === 0) {
      throw new BadRequestException('No enabled KPIs found for this tenant.');
    }

    const targetRows = await this.prisma.outletTarget.findMany({
      where: { clientId: user.clientId, month },
      orderBy: { outletCode: 'asc' },
      select: {
        outletCode: true,
        outletName: true,
        outletType: true,
        targetValues: true,
      },
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

    return buildResolvedTargetsBuffer(month, kpis, targetRows);
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
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
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

    // ── Past-month lock ───────────────────────────────────────────────────────
    // Targets for a month already in the PAST cannot be edited (prevents
    // retroactively rewriting historical targets to game pace). The current +
    // future months stay editable. Locked months in the upload are NOT written;
    // they are reported back so the admin sees what was skipped and why.
    const currentMonth = currentMonthKey();
    const sortedMonths = [...monthsInUpload].sort();
    const lockedMonths = sortedMonths.filter((m) => isMonthLocked(m, currentMonth));
    const writableMonths = sortedMonths.filter((m) => !isMonthLocked(m, currentMonth));

    // Batch is labelled by the earliest WRITABLE month (else the earliest present).
    const batchMonth = writableMonths[0] ?? sortedMonths[0] ?? 'unknown';

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
        if (isMonthLocked(month, currentMonth)) continue; // past month — not editable
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
      writableMonths,
      // Past months present in the file that were skipped (locked, not editable).
      skippedLockedMonths: lockedMonths,
      totalRows,
      acceptedCount,
      rejectedCount,
      rows:          parseResult.rows,
    };
  }

  // ─── Achievement template download ──────────────────────────────────────────

  /**
   * GET /v1/admin/achievements/template?month=YYYY-MM
   *
   * Build the achievement (sales) upload template. It is byte-for-byte the SAME
   * month-group 2-row layout that the TARGET template uses (so the file the admin
   * fills in parses cleanly back through parseTargetUploadBuffer on upload). This
   * makes ONE source of truth for the upload format — the old FE generateSalesTemplate
   * (12-col MOCK_OUTLETS, incompatible parser) is retired.
   *
   * Reuses the exact KPI + REAL tenant-scoped outlet-roster queries from
   * getTemplateBuffer (NO mock outlets). Single month wrapped into the [months]
   * array that generateTargetTemplateBuffer expects. Tenant-scoped by clientId.
   */
  async buildAchievementTemplate(user: JwtPayload, month: string): Promise<Buffer> {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('A valid YYYY-MM "month" query param is required');
    }

    // Enabled KPIs for the tenant — same query as the target template path.
    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
    });

    if (kpiRows.length === 0) {
      throw new BadRequestException(
        'No enabled KPIs found for this tenant. Seed KPIs first via POST /v1/admin/kpis/seed-defaults.',
      );
    }

    // REAL active outlet roster — identical query to getTemplateBuffer (no mocks).
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

    return generateTargetTemplateBuffer(kpis, [month], outletList);
  }

  // ─── Achievement upload ─────────────────────────────────────────────────────

  /**
   * Parse and store achievement values from an uploaded .xlsx file.
   *
   * The xlsx has the SAME layout as the target template (outlet roster × KPI ×
   * month).  Blank cell → omitted key (not stored as 0). Numbers are stored
   * VERBATIM inside OutletSalesRecord.kpiValues.  No compute.
   *
   * Upserts on @@unique([clientId, outletCode, month]) — re-uploads are
   * idempotent.  Unknown outlet codes are rejected (same guard as target upload).
   *
   * Defensive guards mirror target upload:
   *   • FileInterceptor size/type filter is on the controller side.
   *   • `if (!file)` guard here.
   *   • XLSX parse wrapped in try/catch → BadRequestException.
   *   • Every Prisma query tenant-scoped by clientId.
   */
  async uploadAchievements(user: JwtPayload, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    // ── Fetch KPIs (same KpiDef set drives the achievement template) ──────────
    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
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

    // ── Parse the upload (reuse the target parse helper — same xlsx shape) ────
    const kpis: KpiDefLike[] = kpiRows.map((k) => ({
      code: k.code,
      label: k.label,
      isPrimary: k.isPrimary,
      hasNameOverride: k.hasNameOverride,
      nameOverrideLabel: k.nameOverrideLabel ?? null,
      order: k.order,
      enabled: k.enabled,
    }));

    let parseResult: ReturnType<typeof parseTargetUploadBuffer>;
    try {
      parseResult = parseTargetUploadBuffer(file.buffer, kpis, knownOutletCodes);
    } catch {
      throw new BadRequestException('Invalid or corrupted xlsx file');
    }

    // ── Determine months present in the upload ────────────────────────────────
    const monthsInUpload = new Set<string>();
    for (const month of Object.keys(parseResult.acceptedTargets)) {
      monthsInUpload.add(month);
    }

    const sortedMonths = [...monthsInUpload].sort();
    const batchMonth = sortedMonths[0] ?? 'unknown';

    const totalRows     = parseResult.summary.total;
    const acceptedCount = parseResult.summary.accepted;
    const rejectedCount = parseResult.summary.rejected;

    // ── Persist inside a transaction ──────────────────────────────────────────
    const batch = await this.prisma.$transaction(async (tx) => {
      const batchRecord = await tx.salesUploadBatch.create({
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

      // Write one OutletSalesRecord per (outletCode, month) with non-blank values
      for (const [month, outletMap] of Object.entries(parseResult.acceptedTargets)) {
        for (const [outletCode, kpiMapRaw] of Object.entries(outletMap)) {
          // Achievements have no per-outlet display-name concept. The shared target
          // parser may have collected an override-name column into `__names`; strip it
          // here so it never persists as inert dead data in kpiValues (audit O-1).
          const kpiMap = Object.fromEntries(
            kpiCodeKeys(kpiMapRaw).map((k) => [k, kpiMapRaw[k]]),
          );
          if (Object.keys(kpiMap).length === 0) continue; // skip fully-blank rows

          const meta = outletMeta.get(outletCode);

          await tx.outletSalesRecord.upsert({
            where: {
              clientId_outletCode_month: { clientId: user.clientId, outletCode, month },
            },
            create: {
              clientId:   user.clientId,
              outletCode,
              outletName: meta?.name ?? outletCode,
              outletType: meta?.type ?? '',
              month,
              kpiValues:  kpiMap as unknown as Prisma.InputJsonValue,
              batchId:    batchRecord.id,
            },
            update: {
              kpiValues:  kpiMap as unknown as Prisma.InputJsonValue,
              outletName: meta?.name ?? outletCode,
              outletType: meta?.type ?? '',
              batchId:    batchRecord.id,
              updatedAt:  new Date(),
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

  // ─── List achievement batches ───────────────────────────────────────────────

  async listAchievementBatches(user: JwtPayload, q: ListAchievementBatchesQueryDto) {
    return this.prisma.salesUploadBatch.findMany({
      where: {
        clientId: user.clientId,
        ...(q.month ? { month: q.month } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── Delete an achievement upload batch (+ cascade its OutletSalesRecord rows) ─

  /**
   * Delete a SalesUploadBatch and (by schema cascade) its OutletSalesRecord rows.
   * Tenant-scoped: a batch outside the caller's client is a clean 404, never a
   * cross-tenant delete. Used to clear TEST uploads before go-live.
   */
  async deleteAchievementBatch(user: JwtPayload, id: string) {
    const batch = await this.prisma.salesUploadBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Upload batch not found');

    await this.prisma.salesUploadBatch.delete({ where: { id } });
    return { deleted: true, id, removedRecords: batch.acceptedCount };
  }

  // ─── List achievement rows ──────────────────────────────────────────────────

  async listAchievements(user: JwtPayload, q: ListAchievementsQueryDto) {
    if (!q.month) throw new BadRequestException('month query parameter is required');

    return this.prisma.outletSalesRecord.findMany({
      where: {
        clientId: user.clientId,
        month: q.month,
        ...(q.outletCode ? { outletCode: q.outletCode } : {}),
      },
      orderBy: { outletCode: 'asc' },
    });
  }

  // ─── Pace ──────────────────────────────────────────────────────────────────

  /**
   * GET /v1/admin/achievements/pace?month=YYYY-MM[&outletCode=XXX]
   *
   * Joins OutletTarget.targetValues ↔ OutletSalesRecord.kpiValues on
   * (clientId, outletCode, month) and computes pace per KPI:
   *
   *   pace = achieved ÷ target
   *
   * Divide-by-zero guard:
   *   • target key absent  → pace: null
   *   • target value === 0 → pace: null   (avoids ±Infinity)
   *   • Otherwise          → pace: achieved / target  (a ratio; NOT capped)
   *
   * Only outlets with either a target OR an achievement record for the month
   * are included. Tenant-scoped by clientId.
   */
  async getPace(user: JwtPayload, q: PaceQueryDto) {
    if (!q.month) throw new BadRequestException('month query parameter is required');

    const whereBase = {
      clientId: user.clientId,
      month: q.month,
      ...(q.outletCode ? { outletCode: q.outletCode } : {}),
    };

    // Fetch both sides in parallel — they may not have identical outlet sets
    const [targetRows, achievementRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: whereBase,
        select: { outletCode: true, outletName: true, outletType: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { outletCode: true, kpiValues: true },
      }),
    ]);

    // Index by outletCode
    const targetIndex = new Map(targetRows.map((r) => [r.outletCode, r]));
    const achievementIndex = new Map(achievementRows.map((r) => [r.outletCode, r]));

    // Union of outlet codes from both sides
    const allOutletCodes = new Set([
      ...targetIndex.keys(),
      ...achievementIndex.keys(),
    ]);

    const results: Array<{
      outletCode: string;
      outletName: string;
      outletType: string;
      month: string;
      kpis: Array<{
        code: string;
        target: number | null;
        achieved: number | null;
        pace: number | null;
      }>;
    }> = [];

    // Gather all KPI codes observed across both sides for this outlet
    for (const outletCode of allOutletCodes) {
      const targetRow       = targetIndex.get(outletCode);
      const achievementRow  = achievementIndex.get(outletCode);

      const targetValues    = (targetRow?.targetValues   ?? {}) as Record<string, number>;
      const kpiValues       = (achievementRow?.kpiValues ?? {}) as Record<string, number>;

      // Enumerate KPI codes from both sides, EXCLUDING the reserved `__names`
      // key (per-outlet custom display names live there, not a KPI value).
      const allKpiCodes = new Set([
        ...kpiCodeKeys(targetValues),
        ...kpiCodeKeys(kpiValues),
      ]);

      const kpis: Array<{
        code: string;
        target: number | null;
        achieved: number | null;
        pace: number | null;
      }> = [];

      for (const code of allKpiCodes) {
        const target   = Object.prototype.hasOwnProperty.call(targetValues, code)
          ? targetValues[code]
          : null;
        const achieved = Object.prototype.hasOwnProperty.call(kpiValues, code)
          ? kpiValues[code]
          : null;

        // Divide-by-zero guard: target absent OR target===0 → pace null
        let pace: number | null = null;
        if (target !== null && target !== 0 && achieved !== null) {
          pace = achieved / target;
        }

        kpis.push({ code, target, achieved, pace });
      }

      results.push({
        outletCode,
        outletName: targetRow?.outletName ?? achievementRow?.outletCode ?? outletCode,
        outletType: targetRow?.outletType ?? '',
        month: q.month,
        kpis,
      });
    }

    // Sort deterministically
    results.sort((a, b) => a.outletCode.localeCompare(b.outletCode));

    return { month: q.month, outlets: results };
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
