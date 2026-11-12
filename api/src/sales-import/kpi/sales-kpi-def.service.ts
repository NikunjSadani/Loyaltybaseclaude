import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SalesKpiDefinition } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import type {
  SalesColumnMapping,
  SalesKpiDefinitionDto,
  SalesKpiDefinitionList,
  SalesKpiDefinitionPatch,
  SalesKpiFilter,
  SalesKpiMeasure,
  SalesKpiTestRequest,
  SalesKpiTestResult,
  SalesSegmentOptions,
} from '../sales-import.contract';
import {
  OutletKpiAccumulator,
  SALES_KPI_MEASURES,
  definitionsHash,
  entryMatches,
  outletInScope,
  redundantAnyOfEntries,
  validateAndNormalizeFilter,
  type KpiDefLite,
} from './sales-kpi.helper';
import { forEachAggregatePage, loadRosterMeta, resolveReadyImport, rosterIndexOf } from './sales-import-data';
import { storedUnits, unitsToNumber } from '../apply/month-compute';

/**
 * M4: the tester memoises everything per DISTINCT product combo (dimKey) — the KPI match vector (shared by every
 * month's accumulator) and the per-entry hits — so work is O(aggregates + combos × entries), never
 * O(aggregates × entries). Bounded: a file with more distinct combos than this is refused with a 400.
 */
export const KPI_TEST_MAX_COMBOS = 100_000;

export function toDto(row: SalesKpiDefinition): SalesKpiDefinitionDto {
  return {
    id: row.id,
    kpiCode: row.kpiCode,
    measure: row.measure as SalesKpiMeasure,
    filter: (row.filter ?? {}) as SalesKpiFilter,
    outletTypes: row.outletTypes,
    programs: row.programs,
    enabled: row.enabled,
    order: row.order,
  };
}

export function toLite(
  row: Pick<SalesKpiDefinition, 'kpiCode' | 'measure' | 'filter' | 'outletTypes' | 'programs'>,
  kpiOutletType: string | null = null,
): KpiDefLite {
  return {
    kpiCode: row.kpiCode,
    measure: row.measure as SalesKpiMeasure,
    filter: (row.filter ?? {}) as SalesKpiFilter,
    outletTypes: row.outletTypes ?? [],
    programs: row.programs ?? [],
    kpiOutletType,
  };
}

/**
 * L4: the target KPIs' own type tags (KpiDef.outletType; null = shared KPI) for the given codes. A type-tagged KPI is only
 * written for outlets of that type — intersected with the definition's outletTypes (see outletInScope).
 */
export async function kpiOutletTypesOf(
  db: Pick<Prisma.TransactionClient, 'kpiDef'>,
  clientId: string,
  codes: readonly string[],
): Promise<Map<string, string | null>> {
  if (codes.length === 0) return new Map();
  const rows = await db.kpiDef.findMany({ where: { clientId, code: { in: [...codes] } }, select: { code: true, outletType: true } });
  return new Map(rows.map((r) => [r.code, (r.outletType ?? '').trim() || null]));
}

function strList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadRequestException(`${field} must be a list of text values.`);
  return [...new Set((v as string[]).map((s) => s.trim()).filter((s) => s !== ''))];
}

/**
 * Importer-owned KPI definitions CRUD + definitionsHash + the draft-filter tester (plan §5.2, §6.2, §6.2a; task K-2).
 * OWNER: Lane K. Existence of an ENABLED definition makes the KPI importer-owned (G4); DELETE only disables it, which
 * hands the KPI back to the manual achievement upload.
 */
@Injectable()
export class SalesKpiDefService {
  constructor(readonly prisma: PrismaService) {}

  async list(clientId: string): Promise<SalesKpiDefinitionList> {
    const rows = await this.prisma.salesKpiDefinition.findMany({
      where: { clientId },
      orderBy: [{ order: 'asc' }, { kpiCode: 'asc' }],
    });
    const enabled = rows.filter((r) => r.enabled);
    const types = await kpiOutletTypesOf(this.prisma, clientId, enabled.map((r) => r.kpiCode));
    return {
      definitions: rows.map(toDto),
      definitionsHash: definitionsHash(enabled.map((r) => toLite(r, types.get(r.kpiCode) ?? null))),
    };
  }

  /**
   * GET segment-options — the tenant's DISTINCT outlet-type codes and programme names among non-deleted outlets, for
   * the KPI editor's scope multi-selects. Shape: `{ outletTypes: [{code, name}], programs: string[] }` (both sorted).
   */
  async segmentOptions(clientId: string): Promise<SalesSegmentOptions> {
    // groupBy = SQL GROUP BY (Prisma's `distinct` dedupes in Node after fetching every outlet row — final check H1).
    const [typeGroups, programs] = await Promise.all([
      this.prisma.outlet.groupBy({ by: ['outletTypeId'], where: { clientId, deletedAt: null } }),
      this.prisma.outlet.groupBy({ by: ['programName'], where: { clientId, deletedAt: null, programName: { not: null } } }),
    ]);
    const typeIds = typeGroups.map((g) => g.outletTypeId).filter((x): x is string => !!x);
    const types = typeIds.length
      ? await this.prisma.outletType.findMany({ where: { id: { in: typeIds } }, select: { code: true, name: true } })
      : [];
    const byCode = new Map<string, string>();
    for (const t of types) if (t.code) byCode.set(t.code, t.name);
    return {
      outletTypes: [...byCode.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code)),
      programs: [...new Set(programs.map((p) => (p.programName ?? '').trim()).filter((p) => p !== ''))].sort((a, b) => a.localeCompare(b)),
    };
  }

  /** Enabled definitions (the owned set) + their hash — used by preview / apply. */
  async enabled(clientId: string, db: Pick<Prisma.TransactionClient, 'salesKpiDefinition' | 'kpiDef'> = this.prisma) {
    const rows = await db.salesKpiDefinition.findMany({
      where: { clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { kpiCode: 'asc' }],
    });
    // L4: each def carries its KPI's own type tag, so preview / apply / recalculate all scope it the same way (and a
    // tag change moves the hash → a stale preview's apply is refused).
    const types = await kpiOutletTypesOf(db, clientId, rows.map((r) => r.kpiCode));
    const defs = rows.map((r) => toLite(r, types.get(r.kpiCode) ?? null));
    return { rows, defs, hash: definitionsHash(defs) };
  }

  private async profile(clientId: string): Promise<SalesColumnMapping> {
    const p = await this.prisma.salesImportProfile.findUnique({ where: { clientId } });
    if (!p) throw new BadRequestException('Save the column mapping (Settings) before defining KPIs.');
    return p.columnMapping as unknown as SalesColumnMapping;
  }

  /** Full validation of a definition body against the tenant (KpiDef, profile dims + measure columns). */
  private async validate(clientId: string, dto: Partial<SalesKpiDefinitionDto>) {
    const kpiCode = typeof dto.kpiCode === 'string' ? dto.kpiCode.trim() : '';
    if (!kpiCode) throw new BadRequestException('kpiCode is required.');
    const kpi = await this.prisma.kpiDef.findFirst({
      where: { clientId, code: kpiCode, enabled: true },
      select: { code: true },
    });
    if (!kpi) throw new BadRequestException(`"${kpiCode}" is not an enabled KPI of this tenant. Create it in KPI settings first.`);

    const measure = dto.measure as SalesKpiMeasure;
    if (!SALES_KPI_MEASURES.includes(measure)) throw new BadRequestException('measure must be AMOUNT or QUANTITY.');
    const profile = await this.profile(clientId);
    if (measure === 'AMOUNT' && !profile.amount) throw new BadRequestException('The column mapping has no amount column, so an AMOUNT KPI cannot be computed.');
    if (measure === 'QUANTITY' && !profile.quantity) throw new BadRequestException('The column mapping has no quantity column, so a QUANTITY KPI cannot be computed.');

    const fv = validateAndNormalizeFilter(dto.filter ?? {}, profile.dimensions.map((d) => d.key));
    if (fv.errors.length > 0) throw new BadRequestException(fv.errors.join(' '));

    const order = dto.order === undefined || dto.order === null ? 0 : Number(dto.order);
    if (!Number.isInteger(order)) throw new BadRequestException('order must be a whole number.');
    if (dto.enabled !== undefined && typeof dto.enabled !== 'boolean') throw new BadRequestException('enabled must be true/false.');

    return {
      kpiCode,
      measure,
      filter: fv.filter,
      outletTypes: strList(dto.outletTypes, 'outletTypes').map((s) => s.toUpperCase()),
      programs: strList(dto.programs, 'programs'),
      enabled: dto.enabled ?? true,
      order,
      notes: fv.notes,
    };
  }

  async create(user: JwtPayload, dto: SalesKpiDefinitionDto): Promise<SalesKpiDefinitionDto> {
    const clientId = user.clientId;
    const v = await this.validate(clientId, dto);
    const data = {
      measure: v.measure,
      filter: v.filter as Prisma.InputJsonValue,
      outletTypes: v.outletTypes,
      programs: v.programs,
      enabled: v.enabled,
      order: v.order,
      updatedById: user.sub,
    };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.salesKpiDefinition.findUnique({ where: { clientId_kpiCode: { clientId, kpiCode: v.kpiCode } } });
      if (existing?.enabled) throw new ConflictException(`"${v.kpiCode}" is already fed by Sales Import.`);
      // A disabled (released) definition is revived in place — (clientId, kpiCode) is unique.
      const row = existing
        ? await tx.salesKpiDefinition.update({ where: { id: existing.id }, data })
        : await tx.salesKpiDefinition.create({ data: { clientId, kpiCode: v.kpiCode, ...data } });
      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'SALES_KPI_DEFINITION',
          entityId: row.id,
          actorId: user.sub,
          oldValues: existing ? (toDto(existing) as unknown as Prisma.InputJsonValue) : undefined,
          newValues: toDto(row) as unknown as Prisma.InputJsonValue,
          metadata: { clientId, kpiCode: row.kpiCode },
        },
      });
      return toDto(row);
    });
  }

  async patch(user: JwtPayload, id: string, patch: SalesKpiDefinitionPatch): Promise<SalesKpiDefinitionDto> {
    const clientId = user.clientId;
    const before = await this.prisma.salesKpiDefinition.findFirst({ where: { id, clientId } });
    if (!before) throw new NotFoundException('KPI definition not found');
    const merged = { ...toDto(before), ...(patch ?? {}), id: before.id };
    const v = await this.validate(clientId, merged);
    if (v.kpiCode !== before.kpiCode) {
      const clash = await this.prisma.salesKpiDefinition.findUnique({ where: { clientId_kpiCode: { clientId, kpiCode: v.kpiCode } } });
      if (clash) throw new ConflictException(`"${v.kpiCode}" already has a Sales Import definition.`);
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.salesKpiDefinition.update({
        where: { id: before.id },
        data: {
          kpiCode: v.kpiCode,
          measure: v.measure,
          filter: v.filter as Prisma.InputJsonValue,
          outletTypes: v.outletTypes,
          programs: v.programs,
          enabled: v.enabled,
          order: v.order,
          updatedById: user.sub,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'SALES_KPI_DEFINITION',
          entityId: row.id,
          actorId: user.sub,
          oldValues: toDto(before) as unknown as Prisma.InputJsonValue,
          newValues: toDto(row) as unknown as Prisma.InputJsonValue,
          metadata: { clientId, kpiCode: row.kpiCode },
        },
      });
      return toDto(row);
    });
  }

  /** DELETE = disable (ownership released to the manual upload). Idempotent. */
  async disable(user: JwtPayload, id: string): Promise<SalesKpiDefinitionDto> {
    const clientId = user.clientId;
    const before = await this.prisma.salesKpiDefinition.findFirst({ where: { id, clientId } });
    if (!before) throw new NotFoundException('KPI definition not found');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.salesKpiDefinition.update({ where: { id: before.id }, data: { enabled: false, updatedById: user.sub } });
      await tx.auditLog.create({
        data: {
          action: 'DELETE',
          entityType: 'SALES_KPI_DEFINITION',
          entityId: row.id,
          actorId: user.sub,
          oldValues: toDto(before) as unknown as Prisma.InputJsonValue,
          newValues: toDto(row) as unknown as Prisma.InputJsonValue,
          metadata: { clientId, kpiCode: row.kpiCode },
        },
      });
      return toDto(row);
    });
  }

  /**
   * POST kpis/test — evaluate a DRAFT definition against a READY import (no write; §6.2a). Per month: ₹ / cases totals
   * over in-scope roster outlets + outletsNonZero. Also: anyOf/noneOf entries that match no line of the import
   * (unmatchedEntries) and anyOf entries covered by another entry (redundantEntries).
   */
  async test(user: JwtPayload, req: SalesKpiTestRequest): Promise<SalesKpiTestResult> {
    const clientId = user.clientId;
    if (!req || typeof req !== 'object' || !req.definition) throw new BadRequestException('importId and definition are required.');
    const imp = await resolveReadyImport(this.prisma, clientId, String(req.importId ?? ''));
    const profile = await this.profile(clientId);
    const measure = req.definition.measure as SalesKpiMeasure;
    if (!SALES_KPI_MEASURES.includes(measure)) throw new BadRequestException('measure must be AMOUNT or QUANTITY.');
    const fv = validateAndNormalizeFilter(req.definition.filter ?? {}, profile.dimensions.map((d) => d.key));
    if (fv.errors.length > 0) throw new BadRequestException(fv.errors.join(' '));

    // Indexes must point into the REQUEST's lists, so evaluate entries per original index (normalised copies).
    const rawAny = Array.isArray(req.definition.filter?.anyOf) ? req.definition.filter.anyOf : [];
    const rawNone = Array.isArray(req.definition.filter?.noneOf) ? req.definition.filter.noneOf : [];
    const anyHit = rawAny.map(() => false);
    const noneHit = rawNone.map(() => false);

    const draftCode = typeof req.definition.kpiCode === 'string' ? req.definition.kpiCode.trim() : '';
    const scope = {
      outletTypes: strList(req.definition.outletTypes, 'outletTypes'),
      programs: strList(req.definition.programs, 'programs'),
      // L4: the tester shows what apply would write, so the target KPI's own type tag applies here too.
      kpiOutletType: draftCode ? ((await kpiOutletTypesOf(this.prisma, clientId, [draftCode])).get(draftCode) ?? null) : null,
    };
    // Both measures over the SAME set, so the author sees ₹ and cases together (§6.2a "Duplicate as cases KPI").
    const defs: KpiDefLite[] = [
      { kpiCode: 'AMOUNT', measure: 'AMOUNT', filter: fv.filter, ...scope },
      { kpiCode: 'QUANTITY', measure: 'QUANTITY', filter: fv.filter, ...scope },
    ];
    const measureIdx = measure === 'AMOUNT' ? 0 : 1;
    const roster = await loadRosterMeta(this.prisma, clientId);
    const index = rosterIndexOf(roster); // M6: file code → CURRENT roster outlet

    const perMonth = new Map<string, OutletKpiAccumulator>();
    const matchCache = new Map<string, boolean[]>(); // shared by every month's accumulator
    const seenCombos = new Set<string>();
    await forEachAggregatePage(this.prisma, imp.id, null, (rows) => {
      for (const a of rows) {
        if (!seenCombos.has(a.dimKey)) {
          if (seenCombos.size >= KPI_TEST_MAX_COMBOS) {
            throw new BadRequestException(
              `This file has more than ${KPI_TEST_MAX_COMBOS.toLocaleString('en-IN')} distinct product combinations, too many to test interactively. Check the dimension columns of the mapping.`,
            );
          }
          seenCombos.add(a.dimKey);
          rawAny.forEach((e, i) => {
            if (!anyHit[i] && entryMatches(a.dims, e)) anyHit[i] = true;
          });
          rawNone.forEach((e, i) => {
            if (!noneHit[i] && entryMatches(a.dims, e)) noneHit[i] = true;
          });
        }
        const code = index.get(a.outletCode);
        const meta = code === undefined ? undefined : roster.get(code);
        if (!code || !meta || !outletInScope(defs[0], meta)) continue; // unmatched / off-roster / out-of-scope outlets
        let acc = perMonth.get(a.month);
        if (!acc) perMonth.set(a.month, (acc = new OutletKpiAccumulator(defs, matchCache)));
        acc.add(code, a, a.dimKey);
      }
    });

    let matchedLines = 0;
    const months: SalesKpiTestResult['months'] = [];
    for (const month of [...perMonth.keys()].sort()) {
      const acc = perMonth.get(month)!;
      matchedLines += acc.matchedLines;
      // Same rule as preview / apply (real-DB finding 2 / audit L2): totals are sums of the per-outlet STORED values,
      // and "non-zero" is judged on the stored (rounded) value.
      let paise = 0n;
      let thousandths = 0n;
      let nonZero = 0;
      for (const code of acc.outletCodes()) {
        const units = [storedUnits(acc.rawSum(code, 0), 'AMOUNT'), storedUnits(acc.rawSum(code, 1), 'QUANTITY')];
        paise += units[0];
        thousandths += units[1];
        if (units[measureIdx] !== 0n) nonZero++;
      }
      months.push({
        month,
        totalAmountRupees: unitsToNumber(paise, 'AMOUNT'),
        totalQuantity: unitsToNumber(thousandths, 'QUANTITY'),
        outletsNonZero: nonZero,
      });
    }

    return {
      months,
      unmatchedEntries: {
        anyOf: anyHit.flatMap((h, i) => (h ? [] : [i])),
        noneOf: noneHit.flatMap((h, i) => (h ? [] : [i])),
      },
      redundantEntries: { anyOf: redundantAnyOfEntries(rawAny) },
      matchedLines,
    };
  }
}

