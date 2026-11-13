import { ForbiddenException, Injectable } from '@nestjs/common';
import { OfferTile } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import { istDateKey, istMonthKey } from '../common/ist-date';
import { NAMES_KEY } from '../targets/targets.helpers';
import { kpiOutletPredicate } from '../sales/outlet-kpi-scope.helper';
import type { AppliesToOutletFacets } from '../common/applies-to/applies-to';
import {
  computeProgress,
  dateToIstDay,
  istDayToDate,
  kpiNumber,
  outletMatches,
  sortTiles,
} from './offers.helpers';
import { OfferGroup, OfferTilePartner, OfferValueType } from './offers.types';

/**
 * OffersPartnerService — GET /v1/partner/offers: the "This month's offers" tiles that apply to the
 * caller's ACTIVE outlet today (IST), with optional per-outlet KPI progress. DISPLAY-ONLY.
 *
 * Dormancy: when the tenant flag `features.offerTiles` is not true, returns `tiles: []` without
 * touching the offer table (Deoleo byte-identical). With the flag ON the hot path is ONE indexed
 * query that exits early on zero rows.
 *
 * D4 (owner): a tile applies when ANY of the partner's active outlets matches its segment; KPI
 * progress sums only over the MATCHING outlets (null target when none of them has a target row).
 */
@Injectable()
export class OffersPartnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  async listForPartner(
    user: JwtPayload,
    requestedPartnerId?: string,
  ): Promise<{ asOf: string; month: string; tiles: OfferTilePartner[] }> {
    const now = new Date();
    const asOf = istDateKey(now);
    const month = istMonthKey(now);
    const empty = { asOf, month, tiles: [] as OfferTilePartner[] };

    const features = await resolveTenantFeatures(this.tenant, user.clientId);
    if (features.offerTiles !== true) return empty;

    // Re-authorize the x-active-partner-id selector exactly like PartnerService.resolveActivePartner.
    // NEVER read partnerId from the query/body.
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!partnerId) return empty;

    const today = istDayToDate(asOf);
    const tiles = await this.prisma.offerTile.findMany({
      where: {
        clientId: user.clientId,
        deletedAt: null,
        isActive: true,
        validFrom: { lte: today },
        validTo: { gte: today },
      },
      // Enum asc = Postgres declaration order (TARGET_REWARD first). Re-sorted in JS below too.
      orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (tiles.length === 0) return empty;

    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, partnerId, isActive: true, deletedAt: null },
      select: {
        outletCode: true,
        programName: true,
        programCategory: true,
        zone: true,
        state: true,
        outletType: { select: { code: true } },
      },
    });
    if (outlets.length === 0) return empty;
    const facetsByCode = new Map<string, AppliesToOutletFacets>(
      outlets.map((o) => [
        o.outletCode,
        { outletType: o.outletType?.code ?? null, program: o.programName, subProgram: o.programCategory },
      ]),
    );

    // Per tile: the partner's outlets inside its segment; drop tiles with no match (D4: ANY).
    const kept: { tile: OfferTile; codes: string[] }[] = [];
    for (const t of sortTiles(tiles)) {
      const codes = outlets
        .filter((o) =>
          outletMatches(t, {
            programName: o.programName,
            outletTypeCode: o.outletType?.code ?? null,
            zone: o.zone,
            state: o.state,
          }),
        )
        .map((o) => o.outletCode);
      if (codes.length > 0) kept.push({ tile: t, codes });
    }
    if (kept.length === 0) return empty;

    // KPI progress — at most 3 extra queries, only when a kept tile links a KPI.
    const kpiTiles = kept.filter((k) => k.tile.kpiCode);
    const targetsByOutlet = new Map<string, Record<string, unknown>>();
    const achievedByOutlet = new Map<string, Record<string, unknown>>();
    const kpiMeta = new Map<string, { label: string; unit: string }>();
    // APPLIES-TO: KPI code → per-outlet scope predicate; absent for an unscoped KPI (pre-scope path).
    const kpiScopePred = new Map<string, (o: AppliesToOutletFacets) => boolean>();
    if (kpiTiles.length > 0) {
      const codeUnion = [...new Set(kpiTiles.flatMap((k) => k.codes))];
      const kpiCodes = [...new Set(kpiTiles.map((k) => k.tile.kpiCode as string))];
      const where = { clientId: user.clientId, month, outletCode: { in: codeUnion } };
      const [targetRows, salesRows, kpiRows] = await Promise.all([
        this.prisma.outletTarget.findMany({ where, select: { outletCode: true, targetValues: true } }),
        this.prisma.outletSalesRecord.findMany({ where, select: { outletCode: true, kpiValues: true } }),
        this.prisma.kpiDef.findMany({
          // DISABLED KPIs are ignored: a tile pointing at one shows no progress (below).
          where: { clientId: user.clientId, code: { in: kpiCodes }, enabled: true },
          select: {
            code: true,
            label: true,
            unit: true,
            outletType: true,
            outletTypes: true,
            programs: true,
            subPrograms: true,
          },
        }),
      ]);
      for (const r of targetRows) targetsByOutlet.set(r.outletCode, (r.targetValues ?? {}) as Record<string, unknown>);
      for (const r of salesRows) achievedByOutlet.set(r.outletCode, (r.kpiValues ?? {}) as Record<string, unknown>);
      for (const k of kpiRows) {
        kpiMeta.set(k.code, { label: k.label, unit: k.unit });
        const pred = kpiOutletPredicate(k);
        if (pred) kpiScopePred.set(k.code, pred);
      }
    }

    const progressFor = (kpiCode: string, codes: string[]) => {
      if (kpiCode === NAMES_KEY) return null; // never a KPI
      const meta = kpiMeta.get(kpiCode);
      if (!meta) return null; // KPI deleted or disabled since the tile was saved → no progress
      // Owner rule (every reader honours KPI scope): only the segment outlets where the KPI APPLIES
      // contribute. If it applies to none of them there is no progress to show. Unscoped KPI → all
      // segment outlets, exactly as before (Deoleo byte-identical).
      const inScope = kpiScopePred.get(kpiCode);
      if (inScope) {
        codes = codes.filter((c) => inScope(facetsByCode.get(c) ?? {}));
        if (codes.length === 0) return null;
      }
      let target: number | null = null;
      let achieved = 0;
      for (const c of codes) {
        const t = kpiNumber(targetsByOutlet.get(c)?.[kpiCode]);
        if (t !== null) target = (target ?? 0) + t;
        achieved += kpiNumber(achievedByOutlet.get(c)?.[kpiCode]) ?? 0;
      }
      return {
        kpiCode,
        kpiName: meta.label || kpiCode,
        unit: meta.unit ?? '',
        ...computeProgress(target, achieved),
      };
    };

    return {
      asOf,
      month,
      tiles: kept.map(({ tile: t, codes }) => ({
        id: t.id,
        group: t.group as OfferGroup,
        valueType: t.valueType as OfferValueType,
        valueNumber: t.valueNumber === null ? null : Number(t.valueNumber),
        valueText: t.valueText,
        unitLabel: t.unitLabel,
        product: t.product,
        label: t.label,
        details: t.details,
        validTo: dateToIstDay(t.validTo),
        progress: t.kpiCode ? progressFor(t.kpiCode, codes) : null,
      })),
    };
  }
}
