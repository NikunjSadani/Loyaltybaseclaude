import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OfferTile, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import {
  assertNoNulls,
  dateToIstDay,
  istDayToDate,
  monthBounds,
  sortTiles,
  validateTileInput,
} from './offers.helpers';
import {
  NormalizedOfferTileInput,
  OfferGroup,
  OfferTileAdmin,
  OfferTileInput,
  OfferValueType,
} from './offers.types';
import { CopyMonthDto, CreateOfferTileDto, UpdateOfferTileDto } from './dto/offers.dto';

const ENTITY = 'OFFER_TILE';

/** DB row → admin contract view (Decimal → number, @db.Date → 'YYYY-MM-DD'). */
export function toAdminView(r: OfferTile): OfferTileAdmin {
  return {
    id: r.id,
    group: r.group as OfferGroup,
    valueType: r.valueType as OfferValueType,
    valueNumber: r.valueNumber === null ? null : Number(r.valueNumber),
    valueText: r.valueText,
    unitLabel: r.unitLabel,
    product: r.product,
    label: r.label,
    details: r.details,
    validFrom: dateToIstDay(r.validFrom),
    validTo: dateToIstDay(r.validTo),
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    programNames: r.programNames,
    outletTypeCodes: r.outletTypeCodes,
    zones: r.zones,
    states: r.states,
    kpiCode: r.kpiCode,
    copiedFromId: r.copiedFromId,
    copiedToMonth: r.copiedToMonth,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** DB row → the (unnormalized) input shape, for PATCH merges + copy-month. */
function rowToInput(r: OfferTile): OfferTileInput {
  const v = toAdminView(r);
  return {
    group: v.group,
    valueType: v.valueType,
    valueNumber: v.valueNumber,
    valueText: v.valueText,
    unitLabel: v.unitLabel,
    product: v.product,
    label: v.label,
    details: v.details,
    validFrom: v.validFrom,
    validTo: v.validTo,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
    programNames: v.programNames,
    outletTypeCodes: v.outletTypeCodes,
    zones: v.zones,
    states: v.states,
    kpiCode: v.kpiCode,
  };
}

/** Normalized input → Prisma scalar fields (dates as @db.Date values). */
function toDbFields(i: NormalizedOfferTileInput) {
  return {
    group: i.group,
    valueType: i.valueType,
    valueNumber: i.valueNumber,
    valueText: i.valueText,
    unitLabel: i.unitLabel,
    product: i.product,
    label: i.label,
    details: i.details,
    validFrom: istDayToDate(i.validFrom),
    validTo: istDayToDate(i.validTo),
    sortOrder: i.sortOrder,
    isActive: i.isActive,
    programNames: i.programNames,
    outletTypeCodes: i.outletTypeCodes,
    zones: i.zones,
    states: i.states,
    kpiCode: i.kpiCode,
  };
}

const auditJson = (r: OfferTile) => toAdminView(r) as unknown as Prisma.InputJsonValue;

/**
 * OffersAdminService — per-tenant CRUD for "This month's offers" tiles (DISPLAY-ONLY content; see
 * platform/docs/plans/OFFER-TILES-PLAN.md §3.3).
 *
 * Gates on EVERY method, in order:
 *   1. tenant context — an UN-ASSUMED Gifsy operator (GIFSY_ADMIN or GIFSY_STAFF) gets 400 (else
 *      rows would land under 'gifsy');
 *   2. the per-tenant `features.offerTiles` flag (default OFF) — 403 when not true (fail-closed:
 *      an unresolvable tenant reads as OFF), mirroring the Visibility master-switch pattern.
 * Every query is scoped by `clientId: user.clientId`.
 */
@Injectable()
export class OffersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  private async assertAccess(user: JwtPayload): Promise<void> {
    // platformWide() is OWNER-only (an un-assumed GIFSY_STAFF is not platform-wide, it is pinned
    // to its home 'gifsy' clientId) — so check both operator roles explicitly.
    const unassumedOperator =
      platformWide(user) || (user.role === 'GIFSY_STAFF' && !user.assumed);
    if (unassumedOperator) throw new BadRequestException('Assume a tenant to manage offers.');
    const features = await resolveTenantFeatures(this.tenant, user.clientId);
    if (features.offerTiles !== true) {
      throw new ForbiddenException("This month's offers is not enabled for this tenant.");
    }
  }

  /** kpiCode must be an ENABLED KpiDef of this tenant; outletTypeCodes ⊆ the tenant's enabled types. */
  private async assertRefs(
    clientId: string,
    input: NormalizedOfferTileInput,
    check: { kpi: boolean; outletTypes: boolean },
  ): Promise<void> {
    if (check.kpi && input.kpiCode) {
      const kpi = await this.prisma.kpiDef.findFirst({
        where: { clientId, code: input.kpiCode, enabled: true },
        select: { code: true },
      });
      if (!kpi) throw new BadRequestException('Unknown KPI');
    }
    if (check.outletTypes && input.outletTypeCodes.length > 0) {
      const allowed = new Set(
        (await this.tenantSettings.getOutletTypes(clientId)).map((t) => t.code.toUpperCase()),
      );
      const unknown = input.outletTypeCodes.filter((c) => !allowed.has(c.toUpperCase()));
      if (unknown.length > 0) {
        throw new BadRequestException(`Unknown outlet type: ${unknown.join(', ')}`);
      }
    }
  }

  private async findOwned(clientId: string, id: string): Promise<OfferTile> {
    const existing = await this.prisma.offerTile.findFirst({ where: { id, clientId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Offer tile not found');
    return existing;
  }

  /** GET /v1/admin/offers?month=YYYY-MM — non-deleted tiles whose window OVERLAPS the month. */
  async list(user: JwtPayload, month: string) {
    await this.assertAccess(user);
    const { first, last } = monthBounds(month);
    const rows = await this.prisma.offerTile.findMany({
      where: {
        clientId: user.clientId,
        deletedAt: null,
        validFrom: { lte: istDayToDate(last) },
        validTo: { gte: istDayToDate(first) },
      },
      // Enum asc = declaration order (TARGET_REWARD first); re-sorted in JS for safety.
      orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { month, tiles: sortTiles(rows).map(toAdminView) };
  }

  /** GET /v1/admin/offers/segment-options — distinct program/zone/state values of this tenant's outlets. */
  async segmentOptions(user: JwtPayload) {
    await this.assertAccess(user);
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: { programName: true, zone: true, state: true },
      distinct: ['programName', 'zone', 'state'],
    });
    const collect = (vals: (string | null)[]) => {
      const seen = new Map<string, string>(); // lower → first-seen trimmed spelling
      for (const v of vals) {
        const s = (v ?? '').trim();
        if (s === '') continue;
        const k = s.toLowerCase();
        if (!seen.has(k)) seen.set(k, s);
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    };
    return {
      programNames: collect(outlets.map((o) => o.programName)),
      zones: collect(outlets.map((o) => o.zone)),
      states: collect(outlets.map((o) => o.state)),
    };
  }

  /** POST /v1/admin/offers */
  async create(user: JwtPayload, dto: CreateOfferTileDto) {
    await this.assertAccess(user);
    assertNoNulls(dto);
    const input = validateTileInput(dto as OfferTileInput);
    await this.assertRefs(user.clientId, input, { kpi: true, outletTypes: true });
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.offerTile.create({
        data: { ...toDbFields(input), clientId: user.clientId, createdById: user.sub },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.sub,
          action: 'CREATE',
          entityType: ENTITY,
          entityId: created.id,
          newValues: auditJson(created),
          metadata: { clientId: user.clientId },
        },
      });
      return { tile: toAdminView(created) };
    });
  }

  /**
   * PATCH /v1/admin/offers/:id — validates the MERGED (existing + patch) row. An explicit null on a
   * non-nullable field is a 400 (never a silent default). kpiCode / outletTypeCodes are re-checked
   * against the tenant masters when the patch sets them OR when the patch PUBLISHES the tile
   * (isActive false→true, e.g. a copied draft) — so a dead reference can't go live, while a KPI or
   * outlet type disabled after creation still never blocks an unrelated edit (e.g. unpublishing).
   */
  async update(user: JwtPayload, id: string, dto: UpdateOfferTileDto) {
    await this.assertAccess(user);
    assertNoNulls(dto);
    const existing = await this.findOwned(user.clientId, id);
    const patch = Object.fromEntries(
      Object.entries(dto ?? {}).filter(([, v]) => v !== undefined),
    ) as Partial<OfferTileInput>;
    const input = validateTileInput({ ...rowToInput(existing), ...patch });
    const publishing = !existing.isActive && input.isActive;
    await this.assertRefs(user.clientId, input, {
      kpi: publishing || 'kpiCode' in patch,
      outletTypes: publishing || 'outletTypeCodes' in patch,
    });
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.offerTile.update({
        where: { id: existing.id },
        data: { ...toDbFields(input), updatedById: user.sub },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.sub,
          action: 'UPDATE',
          entityType: ENTITY,
          entityId: existing.id,
          oldValues: auditJson(existing),
          newValues: auditJson(updated),
          metadata: { clientId: user.clientId },
        },
      });
      return { tile: toAdminView(updated) };
    });
  }

  /** DELETE /v1/admin/offers/:id — SOFT delete (deletedAt). */
  async remove(user: JwtPayload, id: string) {
    await this.assertAccess(user);
    const existing = await this.findOwned(user.clientId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.offerTile.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), updatedById: user.sub },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.sub,
          action: 'DELETE',
          entityType: ENTITY,
          entityId: existing.id,
          oldValues: auditJson(existing),
          metadata: { clientId: user.clientId },
        },
      });
    });
    return { id: existing.id };
  }

  /**
   * POST /v1/admin/offers/copy-month — copy every non-deleted tile whose validFrom is in fromMonth
   * into toMonth as a DRAFT (isActive=false) spanning the whole target month.
   *
   * Idempotent on (copiedFromId, copiedToMonth) — NOT on validFrom, which the admin may edit after
   * copying: a source with a non-deleted copy tagged for toMonth is skipped. A per-(tenant,toMonth)
   * advisory lock serialises concurrent copies (double-click race).
   *
   * Dead references (the source's KPI was deleted/disabled since): the copy gets kpiCode = null (no
   * progress bar) and its id is reported in `kpiCleared`. Outlet types are NOT rewritten — dropping
   * an unknown code could widen the audience to "all" — the copy keeps them and its id is reported in
   * `unknownOutletTypes`; it stays a draft and publishing it is refused until the admin fixes it
   * (PATCH re-validates refs on isActive false→true).
   */
  async copyMonth(user: JwtPayload, dto: CopyMonthDto) {
    await this.assertAccess(user);
    if (dto.fromMonth === dto.toMonth) {
      throw new BadRequestException('fromMonth and toMonth must be different months.');
    }
    const from = monthBounds(dto.fromMonth);
    const to = monthBounds(dto.toMonth);
    const clientId = user.clientId;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`OFFERCOPY|${clientId}|${dto.toMonth}`}, 0))`;

      const sources = sortTiles(
        await tx.offerTile.findMany({
          where: {
            clientId,
            deletedAt: null,
            validFrom: { gte: istDayToDate(from.first), lte: istDayToDate(from.last) },
          },
        }),
      );
      const already =
        sources.length === 0
          ? []
          : await tx.offerTile.findMany({
              where: {
                clientId,
                deletedAt: null,
                copiedFromId: { in: sources.map((s) => s.id) },
                copiedToMonth: dto.toMonth,
              },
              select: { copiedFromId: true },
            });
      const copied = new Set(already.map((a) => a.copiedFromId));

      // Tenant masters, read once: ENABLED KPI codes + enabled outlet-type codes.
      const pending = sources.filter((s) => !copied.has(s.id));
      const wantKpis = [...new Set(pending.map((s) => s.kpiCode).filter((c): c is string => !!c))];
      const liveKpis = new Set(
        wantKpis.length === 0
          ? []
          : (
              await tx.kpiDef.findMany({
                where: { clientId, code: { in: wantKpis }, enabled: true },
                select: { code: true },
              })
            ).map((k) => k.code),
      );
      const needTypes = pending.some((s) => s.outletTypeCodes.length > 0);
      const liveTypes = needTypes
        ? new Set((await this.tenantSettings.getOutletTypes(clientId)).map((t) => t.code.toUpperCase()))
        : new Set<string>();
      const kpiCleared: string[] = [];
      const unknownOutletTypes: string[] = [];

      const createdRows: OfferTile[] = [];
      let skipped = 0;
      for (const src of sources) {
        if (copied.has(src.id)) {
          skipped++;
          continue;
        }
        const s = rowToInput(src);
        const kpiDead = !!s.kpiCode && !liveKpis.has(s.kpiCode);
        const typesDead = (s.outletTypeCodes ?? []).some((c) => !liveTypes.has(c.toUpperCase()));
        const row = await tx.offerTile.create({
          data: {
            group: s.group,
            valueType: s.valueType,
            valueNumber: s.valueNumber ?? null,
            valueText: s.valueText ?? null,
            unitLabel: s.unitLabel ?? null,
            product: s.product ?? null,
            label: s.label,
            details: s.details ?? null,
            validFrom: istDayToDate(to.first),
            validTo: istDayToDate(to.last),
            sortOrder: s.sortOrder ?? 0,
            isActive: false,
            programNames: s.programNames ?? [],
            outletTypeCodes: s.outletTypeCodes ?? [],
            zones: s.zones ?? [],
            states: s.states ?? [],
            kpiCode: kpiDead ? null : (s.kpiCode ?? null),
            copiedFromId: src.id,
            copiedToMonth: dto.toMonth,
            clientId,
            createdById: user.sub,
          },
        });
        createdRows.push(row);
        if (kpiDead) kpiCleared.push(row.id);
        if (typesDead) unknownOutletTypes.push(row.id);
      }

      await tx.auditLog.create({
        data: {
          actorId: user.sub,
          action: 'CREATE',
          entityType: ENTITY,
          entityId: `copy:${dto.fromMonth}→${dto.toMonth}`,
          metadata: {
            clientId,
            fromMonth: dto.fromMonth,
            toMonth: dto.toMonth,
            createdIds: createdRows.map((r) => r.id),
            skipped,
            kpiCleared,
            unknownOutletTypes,
          },
        },
      });

      return {
        created: createdRows.length,
        skipped,
        kpiCleared,
        unknownOutletTypes,
        tiles: createdRows.map(toAdminView),
      };
    });
  }
}
