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
  SalesKpiProductSource,
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
import { frozenImportCombos } from './focus-data';
import { outletsMissingFromProcessing, processedRosterSet } from '../ingest/roster';
import { storedUnits, unitsToNumber } from '../apply/month-compute';
import type { KpiScopeLike } from '../../common/applies-to/applies-to';

/**
 * M4: the tester memoises everything per DISTINCT product combo (dimKey) — the KPI match vector (shared by every
 * month's accumulator) and the per-entry hits — so work is O(aggregates + combos × entries), never
 * O(aggregates × entries). Bounded: a file with more distinct combos than this is refused with a 400.
 */
export const KPI_TEST_MAX_COMBOS = 100_000;

const MEASURE_ERROR = `measure must be one of ${SALES_KPI_MEASURES.join(', ')}.`;

/** FOCUS-FROM-TARGETS: where a definition's products come from (absent = FILTER). */
export const SALES_KPI_PRODUCT_SOURCES: readonly SalesKpiProductSource[] = ['FILTER', 'TARGET_NAMES'];
export const TARGET_NAMES_NEEDS_NAME_COLUMN =
  'Turn on the per-outlet name column for this KPI in KPI settings first, so the target file can carry the product names.';
export const TARGET_NAMES_FILTER_MUST_BE_EMPTY =
  "A KPI whose products come from the target file can't also have its own product list. Clear the product list first.";
export const TARGET_NAMES_NEEDS_PRODUCT_COLUMNS =
  "The column mapping has no product (dimension) columns, so a 'from the target file' KPI has no products to match the names against.";
export const FOCUS_NAMES_FROM_NEEDS_TARGET_NAMES =
  "Only a KPI whose products come from the target file can use another KPI's focus names.";
export const FOCUS_NAMES_FROM_SELF = "A KPI can't use its own focus names as another KPI's. Pick a different KPI, or leave it empty.";
export const FOCUS_NAMES_FROM_NOT_FOCUS = (code: string) =>
  `"${code}" is not a Sales Import KPI whose products come from the target file, so it has no focus names to use. Set that KPI to 'from the target file' first.`;
export const FOCUS_NAMES_FROM_CHAIN = (code: string, from: string) =>
  `"${code}" itself uses the focus names of "${from}". Pick "${from}" directly.`;
export const FOCUS_NAMES_FROM_HAS_DEPENDENTS = (code: string, dependents: readonly string[]) =>
  `${dependents.map((d) => `"${d}"`).join(', ')} ${dependents.length === 1 ? 'uses' : 'use'} the focus names of "${code}". Change ${dependents.length === 1 ? 'that KPI' : 'those KPIs'} first.`;
export const TARGET_NAMES_TEST_MESSAGE =
  "Test a 'from the target file' KPI on the month screen: its products differ per outlet and per month, so they are checked against each month's targets there.";

/** Stored focusNamesFromKpi → the code to use, or null (own kpiCode). Only meaningful with TARGET_NAMES. */
export function focusNamesFromOf(v: unknown, productSource: unknown): string | null {
  if (productSourceOf(productSource) !== 'TARGET_NAMES' || typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Stored productSource → the contract value (anything but TARGET_NAMES reads as FILTER). */
export function productSourceOf(v: unknown): SalesKpiProductSource {
  return v === 'TARGET_NAMES' ? 'TARGET_NAMES' : 'FILTER';
}

export function toDto(row: SalesKpiDefinition): SalesKpiDefinitionDto {
  const namesFrom = focusNamesFromOf(row.focusNamesFromKpi, row.productSource);
  return {
    id: row.id,
    kpiCode: row.kpiCode,
    measure: row.measure as SalesKpiMeasure,
    filter: (row.filter ?? {}) as SalesKpiFilter,
    productSource: productSourceOf(row.productSource),
    // FOCUS-NAMES-FROM-KPI: only when set (every other definition's DTO is unchanged).
    ...(namesFrom ? { focusNamesFromKpi: namesFrom } : {}),
    outletTypes: row.outletTypes,
    programs: row.programs,
    enabled: row.enabled,
    order: row.order,
  };
}

/**
 * `kpi` = the TARGET KpiDef's scope columns (null = unknown KPI → shared). The lite def carries both the legacy
 * `kpiOutletType` and the APPLIES-TO `kpiScope`; `kpiOwnScope` resolves them exactly like `kpiAppliesTo`.
 */
export function toLite(
  row: Pick<SalesKpiDefinition, 'kpiCode' | 'measure' | 'filter' | 'outletTypes' | 'programs'> & {
    productSource?: string | null;
    focusNamesFromKpi?: string | null;
  },
  kpi: KpiScopeLike | null = null,
): KpiDefLite {
  const namesFrom = focusNamesFromOf(row.focusNamesFromKpi, row.productSource);
  return {
    kpiCode: row.kpiCode,
    measure: row.measure as SalesKpiMeasure,
    filter: (row.filter ?? {}) as SalesKpiFilter,
    // FOCUS-FROM-TARGETS: only a TARGET_NAMES definition carries the field (FILTER lites stay exactly as before).
    ...(productSourceOf(row.productSource) === 'TARGET_NAMES' ? { productSource: 'TARGET_NAMES' as const } : {}),
    // FOCUS-NAMES-FROM-KPI: only on a definition that borrows another KPI's names.
    ...(namesFrom ? { focusNamesFromKpi: namesFrom } : {}),
    outletTypes: row.outletTypes ?? [],
    programs: row.programs ?? [],
    kpiOutletType: (kpi?.outletType ?? '').trim() || null,
    kpiScope: {
      outletTypes: [...(kpi?.outletTypes ?? [])],
      programs: [...(kpi?.programs ?? [])],
      subPrograms: [...(kpi?.subPrograms ?? [])],
    },
  };
}

/**
 * L4 / APPLIES-TO: the target KPIs' own scope columns (legacy outletType + outletTypes / programs / subPrograms) for the
 * given codes. A scoped KPI is only written for outlets in its scope — intersected with the definition's own scope
 * (see outletInScope).
 */
export async function kpiScopesOf(
  db: Pick<Prisma.TransactionClient, 'kpiDef'>,
  clientId: string,
  codes: readonly string[],
): Promise<Map<string, KpiScopeLike>> {
  if (codes.length === 0) return new Map();
  const rows = await db.kpiDef.findMany({
    where: { clientId, code: { in: [...codes] } },
    select: { code: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
  });
  return new Map(
    rows.map((r) => [
      r.code,
      { outletType: r.outletType ?? null, outletTypes: r.outletTypes ?? [], programs: r.programs ?? [], subPrograms: r.subPrograms ?? [] },
    ]),
  );
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
    const scopes = await kpiScopesOf(this.prisma, clientId, enabled.map((r) => r.kpiCode));
    return {
      definitions: rows.map(toDto),
      definitionsHash: definitionsHash(enabled.map((r) => toLite(r, scopes.get(r.kpiCode) ?? null))),
    };
  }

  /**
   * GET segment-options — the tenant's DISTINCT outlet-type codes, programme names and sub-programme names
   * (Outlet.programCategory) among non-deleted outlets, for the KPI editor's scope multi-selects / scope hints.
   * Shape: `{ outletTypes: [{code, name}], programs: string[], subPrograms: string[] }` (all sorted).
   */
  async segmentOptions(clientId: string): Promise<SalesSegmentOptions> {
    // groupBy = SQL GROUP BY (Prisma's `distinct` dedupes in Node after fetching every outlet row — final check H1).
    const [typeGroups, programs, subPrograms] = await Promise.all([
      this.prisma.outlet.groupBy({ by: ['outletTypeId'], where: { clientId, deletedAt: null } }),
      this.prisma.outlet.groupBy({ by: ['programName'], where: { clientId, deletedAt: null, programName: { not: null } } }),
      this.prisma.outlet.groupBy({ by: ['programCategory'], where: { clientId, deletedAt: null, programCategory: { not: null } } }),
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
      subPrograms: [...new Set(subPrograms.map((p) => (p.programCategory ?? '').trim()).filter((p) => p !== ''))].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }

  /** Enabled definitions (the owned set) + their hash — used by preview / apply. */
  async enabled(clientId: string, db: Pick<Prisma.TransactionClient, 'salesKpiDefinition' | 'kpiDef'> = this.prisma) {
    const rows = await db.salesKpiDefinition.findMany({
      where: { clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { kpiCode: 'asc' }],
    });
    // L4 / APPLIES-TO: each def carries its KPI's own scope, so preview / apply / recalculate all scope it the same way
    // (and a scope change moves the hash → a stale preview's apply is refused).
    const scopes = await kpiScopesOf(db, clientId, rows.map((r) => r.kpiCode));
    const defs = rows.map((r) => toLite(r, scopes.get(r.kpiCode) ?? null));
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
      select: { code: true, hasNameOverride: true, nameOverrideLabel: true },
    });
    if (!kpi) throw new BadRequestException(`"${kpiCode}" is not an enabled KPI of this tenant. Create it in KPI settings first.`);

    const measure = dto.measure as SalesKpiMeasure;
    if (!SALES_KPI_MEASURES.includes(measure)) throw new BadRequestException(MEASURE_ERROR);
    const profile = await this.profile(clientId);
    if (measure === 'AMOUNT' && !profile.amount) throw new BadRequestException('The column mapping has no amount column, so an AMOUNT KPI cannot be computed.');
    if (measure === 'QUANTITY' && !profile.quantity) throw new BadRequestException('The column mapping has no quantity column, so a QUANTITY KPI cannot be computed.');
    // PRODUCT_COUNT counts products by their NET amount, and a product = a combination of the dimension columns.
    if (measure === 'PRODUCT_COUNT' && !profile.amount) {
      throw new BadRequestException('The column mapping has no amount column, so a PRODUCT_COUNT KPI (products with net amount above zero) cannot be computed.');
    }
    if (measure === 'PRODUCT_COUNT' && profile.dimensions.length === 0) {
      throw new BadRequestException('The column mapping has no product (dimension) columns, so a PRODUCT_COUNT KPI cannot tell products apart.');
    }

    const fv = validateAndNormalizeFilter(dto.filter ?? {}, profile.dimensions.map((d) => d.key));
    if (fv.errors.length > 0) throw new BadRequestException(fv.errors.join(' '));

    // FOCUS-FROM-TARGETS (design §9): absent = FILTER; TARGET_NAMES needs an empty product list and the KPI's per-outlet
    // name column (that is where the target file carries the product names).
    const rawSource = dto.productSource === undefined || dto.productSource === null ? 'FILTER' : dto.productSource;
    if (!SALES_KPI_PRODUCT_SOURCES.includes(rawSource as SalesKpiProductSource)) {
      throw new BadRequestException(`productSource must be one of ${SALES_KPI_PRODUCT_SOURCES.join(', ')}.`);
    }
    const productSource = rawSource as SalesKpiProductSource;
    // FOCUS-NAMES-FROM-KPI: read ANOTHER KPI's per-outlet names. Only with TARGET_NAMES; never itself; the source must be
    // an ENABLED TARGET_NAMES definition that reads its OWN names (one level only → no chains, no cycles).
    if (dto.focusNamesFromKpi !== undefined && dto.focusNamesFromKpi !== null && typeof dto.focusNamesFromKpi !== 'string') {
      throw new BadRequestException('focusNamesFromKpi must be a KPI code or empty.');
    }
    const namesFromRaw = typeof dto.focusNamesFromKpi === 'string' ? dto.focusNamesFromKpi.trim() : '';
    const focusNamesFromKpi = namesFromRaw === '' ? null : namesFromRaw;
    if (focusNamesFromKpi !== null) {
      if (productSource !== 'TARGET_NAMES') throw new BadRequestException(FOCUS_NAMES_FROM_NEEDS_TARGET_NAMES);
      if (focusNamesFromKpi === kpiCode) throw new BadRequestException(FOCUS_NAMES_FROM_SELF);
      const src = await this.prisma.salesKpiDefinition.findUnique({
        where: { clientId_kpiCode: { clientId, kpiCode: focusNamesFromKpi } },
      });
      if (!src || !src.enabled || productSourceOf(src.productSource) !== 'TARGET_NAMES') {
        throw new BadRequestException(FOCUS_NAMES_FROM_NOT_FOCUS(focusNamesFromKpi));
      }
      const srcFrom = focusNamesFromOf(src.focusNamesFromKpi, src.productSource);
      if (srcFrom) throw new BadRequestException(FOCUS_NAMES_FROM_CHAIN(focusNamesFromKpi, srcFrom));
    }
    if (productSource === 'TARGET_NAMES') {
      if ((fv.filter.anyOf?.length ?? 0) > 0 || (fv.filter.noneOf?.length ?? 0) > 0) {
        throw new BadRequestException(TARGET_NAMES_FILTER_MUST_BE_EMPTY);
      }
      // A borrowing definition reads the SOURCE KPI's name column (validated on the source), not its own.
      if (focusNamesFromKpi === null && (!kpi.hasNameOverride || !(kpi.nameOverrideLabel ?? '').trim())) {
        throw new BadRequestException(TARGET_NAMES_NEEDS_NAME_COLUMN);
      }
      // The names are matched against products = combinations of the product (dimension) columns; with none, nothing
      // can ever match (same rule as PRODUCT_COUNT).
      if (profile.dimensions.length === 0) throw new BadRequestException(TARGET_NAMES_NEEDS_PRODUCT_COLUMNS);
    }

    const order = dto.order === undefined || dto.order === null ? 0 : Number(dto.order);
    if (!Number.isInteger(order)) throw new BadRequestException('order must be a whole number.');
    if (dto.enabled !== undefined && typeof dto.enabled !== 'boolean') throw new BadRequestException('enabled must be true/false.');

    return {
      kpiCode,
      measure,
      filter: productSource === 'TARGET_NAMES' ? {} : fv.filter,
      productSource,
      focusNamesFromKpi,
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
      productSource: v.productSource,
      focusNamesFromKpi: v.focusNamesFromKpi,
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
    // FOCUS-NAMES-FROM-KPI: a definition other KPIs borrow names from must stay an enabled, own-names TARGET_NAMES
    // definition under the same code — otherwise refuse (the borrowers would silently lose their products).
    if (v.kpiCode !== before.kpiCode || !v.enabled || v.productSource !== 'TARGET_NAMES' || v.focusNamesFromKpi !== null) {
      await this.assertNoBorrowers(clientId, before.kpiCode, before.id);
    }
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
          productSource: v.productSource,
          focusNamesFromKpi: v.focusNamesFromKpi,
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

  /** FOCUS-NAMES-FROM-KPI: refuse when an ENABLED definition (other than `selfId`) borrows `kpiCode`'s focus names. */
  private async assertNoBorrowers(clientId: string, kpiCode: string, selfId: string): Promise<void> {
    const borrowers = await this.prisma.salesKpiDefinition.findMany({
      where: { clientId, enabled: true, productSource: 'TARGET_NAMES', focusNamesFromKpi: kpiCode, id: { not: selfId } },
      select: { kpiCode: true },
      orderBy: { kpiCode: 'asc' },
    });
    if (borrowers.length > 0) throw new ConflictException(FOCUS_NAMES_FROM_HAS_DEPENDENTS(kpiCode, borrowers.map((b) => b.kpiCode)));
  }

  /** DELETE = disable (ownership released to the manual upload). Idempotent. */
  async disable(user: JwtPayload, id: string): Promise<SalesKpiDefinitionDto> {
    const clientId = user.clientId;
    const before = await this.prisma.salesKpiDefinition.findFirst({ where: { id, clientId } });
    if (!before) throw new NotFoundException('KPI definition not found');
    if (before.enabled) await this.assertNoBorrowers(clientId, before.kpiCode, before.id);
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
   * (+ Σ product counts for a PRODUCT_COUNT draft) over in-scope roster outlets + outletsNonZero (on the draft's measure). Also: anyOf/noneOf entries that match no line of the import
   * (unmatchedEntries) and anyOf entries covered by another entry (redundantEntries).
   */
  async test(user: JwtPayload, req: SalesKpiTestRequest): Promise<SalesKpiTestResult> {
    const clientId = user.clientId;
    if (!req || typeof req !== 'object' || !req.definition) throw new BadRequestException('importId and definition are required.');
    // FOCUS-FROM-TARGETS: a TARGET_NAMES draft has no product list of its own — its products come per outlet from each
    // month's target file, which the month screen's reconciliation checks (and shows the per-name results of).
    if (productSourceOf(req.definition.productSource) === 'TARGET_NAMES') throw new BadRequestException(TARGET_NAMES_TEST_MESSAGE);
    const imp = await resolveReadyImport(this.prisma, clientId, String(req.importId ?? ''));
    const profile = await this.profile(clientId);
    const measure = req.definition.measure as SalesKpiMeasure;
    if (!SALES_KPI_MEASURES.includes(measure)) throw new BadRequestException(MEASURE_ERROR);
    const fv = validateAndNormalizeFilter(req.definition.filter ?? {}, profile.dimensions.map((d) => d.key));
    if (fv.errors.length > 0) throw new BadRequestException(fv.errors.join(' '));

    // Indexes must point into the REQUEST's lists, so evaluate entries per original index (normalised copies).
    const rawAny = Array.isArray(req.definition.filter?.anyOf) ? req.definition.filter.anyOf : [];
    const rawNone = Array.isArray(req.definition.filter?.noneOf) ? req.definition.filter.noneOf : [];
    const anyHit = rawAny.map(() => false);
    const noneHit = rawNone.map(() => false);

    const draftCode = typeof req.definition.kpiCode === 'string' ? req.definition.kpiCode.trim() : '';
    // L4 / APPLIES-TO: the tester shows what apply would write, so the target KPI's own scope applies here too.
    const kpiScope = draftCode ? ((await kpiScopesOf(this.prisma, clientId, [draftCode])).get(draftCode) ?? null) : null;
    const own = toLite({ kpiCode: draftCode, measure, filter: {}, outletTypes: [], programs: [] }, kpiScope);
    const scope = {
      outletTypes: strList(req.definition.outletTypes, 'outletTypes'),
      programs: strList(req.definition.programs, 'programs'),
      kpiOutletType: own.kpiOutletType,
      kpiScope: own.kpiScope,
    };
    // Both measures over the SAME set, so the author sees ₹ and cases together (§6.2a "Duplicate as cases KPI").
    // A PRODUCT_COUNT draft adds a third (index 2) so the per-product net maps are only built when they are shown.
    const defs: KpiDefLite[] = [
      { kpiCode: 'AMOUNT', measure: 'AMOUNT', filter: fv.filter, ...scope },
      { kpiCode: 'QUANTITY', measure: 'QUANTITY', filter: fv.filter, ...scope },
    ];
    if (measure === 'PRODUCT_COUNT') defs.push({ kpiCode: 'PRODUCT_COUNT', measure: 'PRODUCT_COUNT', filter: fv.filter, ...scope });
    const measureIdx = measure === 'AMOUNT' ? 0 : measure === 'QUANTITY' ? 1 : 2;
    const roster = await loadRosterMeta(this.prisma, clientId);
    const index = rosterIndexOf(roster); // M6: file code → CURRENT roster outlet
    // Roster-only imports: outlets added since processing have no lines here — reported like preview / apply (audit A L2).
    const outletsNotIncluded = outletsMissingFromProcessing(processedRosterSet(imp.processedRosterCodes), index);

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
    // Roster-only aggregates (2026-11-23): a roster-only import's aggregates hold only programme outlets' products, so
    // "matches no line of the file" also checks the file's frozen product combos (every valid line; top
    // SALES_IMPORT_MAX_DIMENSION_COMBOS by |₹|) — the same answer as before whenever the file has ≤ that many combos.
    // Totals are unchanged (they only ever counted roster outlets). Legacy imports: no frozen combos are read.
    if (anyHit.includes(false) || noneHit.includes(false)) {
      for (const r of await frozenImportCombos(this.prisma, clientId, imp.id)) {
        const dims = r.dims as Record<string, string>;
        rawAny.forEach((e, i) => {
          if (!anyHit[i] && entryMatches(dims, e)) anyHit[i] = true;
        });
        rawNone.forEach((e, i) => {
          if (!noneHit[i] && entryMatches(dims, e)) noneHit[i] = true;
        });
      }
    }

    let matchedLines = 0;
    const months: SalesKpiTestResult['months'] = [];
    for (const month of [...perMonth.keys()].sort()) {
      const acc = perMonth.get(month)!;
      matchedLines += acc.matchedLines;
      // Same rule as preview / apply (real-DB finding 2 / audit L2): totals are sums of the per-outlet STORED values,
      // and "non-zero" is judged on the stored (rounded) value.
      let paise = 0n;
      let thousandths = 0n;
      let products = 0n;
      let nonZero = 0;
      for (const code of acc.outletCodes()) {
        const units = defs.map((d, i) => storedUnits(acc.rawSum(code, i), d.measure));
        paise += units[0];
        thousandths += units[1];
        if (units.length > 2) products += units[2];
        if (units[measureIdx] !== 0n) nonZero++;
      }
      months.push({
        month,
        totalAmountRupees: unitsToNumber(paise, 'AMOUNT'),
        totalQuantity: unitsToNumber(thousandths, 'QUANTITY'),
        ...(measure === 'PRODUCT_COUNT' ? { totalProducts: unitsToNumber(products, 'PRODUCT_COUNT') } : {}),
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
      ...(outletsNotIncluded !== null ? { outletsNotIncluded } : {}),
    };
  }
}

