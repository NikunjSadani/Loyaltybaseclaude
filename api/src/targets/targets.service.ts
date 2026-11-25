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
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  SALES_IMPORT_BATCH_STATUS,
  achievementHeaderLabels,
  importerOwnedKpiCodes,
  lockSalesMonth,
  ownedSubsetSql,
} from '../common/sales-kpi-ownership';
import {
  ListKpisQueryDto,
  UpsertKpiDefDto,
  ListBatchesQueryDto,
  ListTargetsQueryDto,
  ListAchievementBatchesQueryDto,
  ListAchievementsQueryDto,
  PaceQueryDto,
} from './dto/targets.dto';
import {
  parseTargetUploadBuffer,
  targetUploadRowsEcho,
  currentMonthKey,
  isMonthLocked,
  kpiCodeKeys,
  KpiDefLike,
} from './targets.helpers';
import { SQL_NOW_UTC } from '../sales-import/sql-time';
import { targetUploadFocusCheck } from '../sales-import/kpi/focus-upload-check';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import {
  AppliesTo,
  APPLIES_TO_FACETS,
  AppliesToFacet,
  KpiScopeLike,
  appliesToOutlet,
  emptyAppliesTo,
  isUnscoped,
  kpiAppliesTo,
  legacyOutletTypeOf,
  normalizeAppliesTo,
} from '../common/applies-to/applies-to';
import { appliesToOutletWhere } from '../common/applies-to/applies-to.prisma';

/**
 * APPLIES-TO (plan D1/D2): does this tenant's KPI set need scope ENFORCEMENT on templates /
 * uploads / pace? Whenever ANY KPI carries a non-empty scope — including the legacy single
 * outlet type (OWNER DECISION 2026-11-12: a legacy single-type KPI is a REAL scope, enforced
 * everywhere). Only a tenant whose KPIs are ALL unscoped (Deoleo) keeps EXACTLY the pre-APPLIES-TO
 * behaviour (byte-identical template, no out-of-scope ignoring, no `ignoredOutOfScope` key).
 */
export function kpiScopeEnforced(kpis: ReadonlyArray<KpiScopeLike>): boolean {
  return kpis.some((k) => !isUnscoped(kpiAppliesTo(k)));
}

/** One outlet-month a target upload writes: the uploaded KPI map + the stored KPI codes it must carry over. */
interface TargetUploadWrite {
  month: string;
  outletCode: string;
  outletName: string;
  kpiMap: Record<string, unknown>;
  carry: string[];
}

/** One scope-option value: settings-list entry or a live-only outlet value (APPLIES-TO §6). */
export interface ScopeOptionValue {
  value: string;
  inSettings: boolean;
}

/** GET /v1/admin/kpis/scope-options response (WP-C codes against this exact shape). */
export interface KpiScopeOptions {
  outletTypes: { code: string; label: string }[];
  programs: ScopeOptionValue[];
  subPrograms: ScopeOptionValue[];
}

/**
 * Merge a tenant settings list with the distinct LIVE outlet values (ci). Settings entries come
 * first in settings order (settings spelling, inSettings:true); live-only values follow, sorted,
 * each in its most common live spelling (ties → alphabetical), inSettings:false.
 */
export function mergeScopeOptions(
  settingsList: ReadonlyArray<string>,
  live: ReadonlyArray<{ value: string | null; count: number }>,
): ScopeOptionValue[] {
  const out: ScopeOptionValue[] = [];
  const seen = new Set<string>();
  for (const raw of settingsList) {
    const v = (raw ?? '').trim();
    if (!v || seen.has(v.toUpperCase())) continue;
    seen.add(v.toUpperCase());
    out.push({ value: v, inSettings: true });
  }
  const best = new Map<string, { value: string; count: number }>();
  for (const l of live) {
    const v = (l.value ?? '').trim();
    if (!v) continue;
    const key = v.toUpperCase();
    if (seen.has(key)) continue;
    const cur = best.get(key);
    if (!cur || l.count > cur.count || (l.count === cur.count && v < cur.value)) best.set(key, { value: v, count: l.count });
  }
  const liveOnly = [...best.values()].map((b) => b.value).sort((a, b) => a.localeCompare(b));
  for (const v of liveOnly) out.push({ value: v, inSettings: false });
  return out;
}

/** Live, addressable outlet universe for the scope-count (mirrors program-health / visibility universes). */
const LIVE_OUTLET_WHERE = (clientId: string): Prisma.OutletWhereInput => ({
  clientId,
  deletedAt: null,
  deactivatedAt: null,
  // notIn drops NULL rows (Prisma/SQL NULL semantics) → OR-in the null case (pending outlets).
  OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
});

const sameCiSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  const A = new Set(a.map((x) => x.trim().toUpperCase()));
  const B = new Set(b.map((x) => x.trim().toUpperCase()));
  return A.size === B.size && [...A].every((x) => B.has(x));
};

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
  /** Batch size for chunked upload persistence — keeps each $transaction([...]) well
   *  under the 5s interactive-transaction timeout even for thousands of outlet rows. */
  private static readonly UPLOAD_CHUNK = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesNotifications: SalesNotificationsService,
    // @Global TenantModule provides it in the app; @Optional so unit-test modules that only provide
    // Prisma keep compiling (falls back to a local instance over the same Prisma — fresh reads).
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  private settingsService(): TenantSettingsService {
    return this.tenantSettings ?? new TenantSettingsService(this.prisma);
  }

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
    const { code, label, unit, isPrimary, hasNameOverride, nameOverrideLabel, order, rollup, enabled } =
      dto;
    // APPLIES-TO scope (plan §4; E1 generalised). Each facet: omitted = unchanged (create → []).
    // `outletTypes` wins over the legacy single `outletType` (null/'' = all types). An UPDATE whose
    // resulting scope equals the STORED scope is a no-op and is NOT re-validated (so relabelling never
    // fails because an outlet type was disabled / a program renamed after the KPI was scoped); on a
    // change only the CHANGED facets are validated. The legacy column is dual-written.
    const scope = await this.resolveKpiScopeWrite(user.clientId, code, dto);
    const scopeData = scope?.write;

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

        const row = await tx.kpiDef.upsert({
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
            rollup: rollup ?? 'SUM',
            enabled: enabled ?? true,
            outletType: scopeData?.outletType ?? null,
            ...(scopeData
              ? { outletTypes: scopeData.outletTypes, programs: scopeData.programs, subPrograms: scopeData.subPrograms }
              : {}),
          },
          update: {
            label,
            ...(unit !== undefined ? { unit } : {}),
            ...(isPrimary !== undefined ? { isPrimary } : {}),
            ...(hasNameOverride !== undefined ? { hasNameOverride } : {}),
            ...(nameOverrideLabel !== undefined ? { nameOverrideLabel } : {}),
            ...(order !== undefined ? { order } : {}),
            ...(rollup !== undefined ? { rollup } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
            ...(scopeData ? scopeData : {}),
          },
        });

        // AuditLog ONLY when the scope actually changed (never for a no-op resend / label edit).
        if (scope?.audit) {
          await tx.auditLog.create({
            data: {
              action: scope.audit.before ? 'UPDATE' : 'CREATE',
              entityType: 'KPI_DEF',
              entityId: row.id,
              actorId: user.sub,
              oldValues: (scope.audit.before ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
              newValues: scope.audit.after as unknown as Prisma.InputJsonValue,
              metadata: { clientId: user.clientId, kpiCode: code, change: 'kpi-scope' },
            },
          });
        }
        return row;
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

  /**
   * APPLIES-TO write resolution for upsertKpi. Returns undefined when no scope field was sent or the
   * resulting scope equals the stored one (no-op: nothing validated, nothing written, no audit).
   * Otherwise validates the CHANGED facets, canonicalises them and returns the 4-column write + the
   * audit payload (audit only when the scope differs from what was stored / a non-empty create).
   */
  private async resolveKpiScopeWrite(
    clientId: string,
    code: string,
    dto: UpsertKpiDefDto,
  ): Promise<
    | {
        write: { outletType: string | null; outletTypes: string[]; programs: string[]; subPrograms: string[] };
        audit: { before: AppliesTo | null; after: AppliesTo } | null;
      }
    | undefined
  > {
    const touched =
      dto.outletTypes !== undefined ||
      dto.programs !== undefined ||
      dto.subPrograms !== undefined ||
      dto.outletType !== undefined;
    if (!touched) return undefined;

    const current = await this.prisma.kpiDef.findFirst({
      where: { clientId, code },
      select: { outletType: true, outletTypes: true, programs: true, subPrograms: true },
    });
    const before = current ? kpiAppliesTo(current) : emptyAppliesTo();

    const legacyTypes =
      dto.outletType === undefined
        ? undefined
        : (dto.outletType ?? '').trim() === ''
          ? []
          : [dto.outletType as string];
    const requested = normalizeAppliesTo({
      outletTypes: dto.outletTypes ?? legacyTypes ?? before.outletTypes,
      programs: dto.programs ?? before.programs,
      subPrograms: dto.subPrograms ?? before.subPrograms,
    });

    const changed = APPLIES_TO_FACETS.filter((f) => !sameCiSet(requested[f], before[f]));
    if (current && changed.length === 0) return undefined; // unchanged resend → no-op, not re-validated

    const after: AppliesTo = { ...before };
    for (const f of changed) after[f] = await this.canonicalScopeFacet(clientId, f, requested[f]);
    // Facets not changed keep their stored values (already canonical when written).
    const write = {
      outletType: legacyOutletTypeOf(after),
      outletTypes: after.outletTypes,
      programs: after.programs,
      subPrograms: after.subPrograms,
    };
    const scopeChanged = current ? changed.length > 0 : !isUnscoped(after);
    return { write, audit: scopeChanged ? { before: current ? before : null, after } : null };
  }

  /**
   * Validate + canonicalise one scope facet (plan §4, D8). Empty → []. outletTypes ⊆ the tenant's
   * ENABLED, active outlet type codes (canonical code). programs / subPrograms ⊆ (settings list ∪
   * distinct live outlet values), ci, canonicalised to the settings spelling (fallback: the most
   * common live spelling). Anything else → 400 listing the allowed values.
   */
  private async canonicalScopeFacet(clientId: string, facet: AppliesToFacet, values: string[]): Promise<string[]> {
    if (values.length === 0) return [];
    let allowed: string[];
    let label: string;
    if (facet === 'outletTypes') {
      allowed = await this.enabledOutletTypeCodes(clientId);
      label = 'outlet type';
    } else {
      const opts = await this.programFacetOptions(clientId, facet);
      allowed = opts.map((o) => o.value);
      label = facet === 'programs' ? 'program' : 'sub-program';
    }
    const byKey = new Map(allowed.map((a) => [a.trim().toUpperCase(), a]));
    const out: string[] = [];
    const bad: string[] = [];
    for (const v of values) {
      const hit = byKey.get(v.trim().toUpperCase());
      if (hit === undefined) bad.push(v);
      else if (!out.includes(hit)) out.push(hit);
    }
    if (bad.length > 0) {
      throw new BadRequestException(
        `${facet}: ${bad.map((b) => `"${b}"`).join(', ')} ${bad.length === 1 ? 'is not a known' : 'are not known'} ${label}${bad.length === 1 ? '' : 's'} for this tenant` +
          (allowed.length ? ` (allowed: ${allowed.join(', ')}).` : ` (no ${label}s are configured).`) +
          ` Leave it empty for a KPI that applies to every ${label}.`,
      );
    }
    return out;
  }

  /** The tenant's ENABLED, active outlet type codes (the E1 validation set). */
  private async enabledOutletTypeCodes(clientId: string): Promise<string[]> {
    const rows = await this.prisma.outletTypeClientConfig.findMany({
      where: { clientId, isEnabled: true, outletType: { isActive: true } },
      select: { outletType: { select: { code: true } } },
    });
    return rows.map((r) => r.outletType.code);
  }

  /**
   * programs ↔ settings `outletPrograms` ∪ live Outlet.programName; subPrograms ↔ settings
   * `outletCategories` ∪ live Outlet.programCategory (non-deleted outlets of the tenant).
   */
  private async programFacetOptions(
    clientId: string,
    facet: 'programs' | 'subPrograms',
  ): Promise<ScopeOptionValue[]> {
    const settings = await this.settingsService().getEffectiveSettings(clientId, { fresh: true });
    const settingsList = facet === 'programs' ? settings.outletPrograms : settings.outletCategories;
    const live =
      facet === 'programs'
        ? (
            await this.prisma.outlet.groupBy({
              by: ['programName'],
              where: { clientId, deletedAt: null, programName: { not: null } },
              _count: { _all: true },
            })
          ).map((g) => ({ value: g.programName, count: g._count._all }))
        : (
            await this.prisma.outlet.groupBy({
              by: ['programCategory'],
              where: { clientId, deletedAt: null, programCategory: { not: null } },
              _count: { _all: true },
            })
          ).map((g) => ({ value: g.programCategory, count: g._count._all }));
    return mergeScopeOptions(settingsList ?? [], live);
  }

  // ─── KpiDef: scope options + matching-outlet count (APPLIES-TO §6) ─────────

  /** GET /v1/admin/kpis/scope-options — the KPI form's three multi-select option lists. */
  async scopeOptions(user: JwtPayload): Promise<KpiScopeOptions> {
    const [types, programs, subPrograms] = await Promise.all([
      this.settingsService().getOutletTypes(user.clientId),
      this.programFacetOptions(user.clientId, 'programs'),
      this.programFacetOptions(user.clientId, 'subPrograms'),
    ]);
    return {
      outletTypes: types.map((t) => ({ code: t.code, label: t.label })),
      programs,
      subPrograms,
    };
  }

  /**
   * GET /v1/admin/kpis/scope-count?outletTypes=A&outletTypes=B&programs=..&subPrograms=.. (REPEATED
   * params — never comma-split, so a value may contain a comma) — how many LIVE outlets
   * (non-deleted, not deactivated, not NOT_INTERESTED / PARKED — the dashboard universe; NEVER an
   * `isActive` proxy, which would drop every KYC-pending outlet) the given scope matches. Empty = all.
   */
  async scopeCount(
    user: JwtPayload,
    q: { outletTypes?: string | string[]; programs?: string | string[]; subPrograms?: string | string[] },
  ): Promise<{ count: number }> {
    // The DTO already arrays a single param; tolerate a bare string too (direct service callers).
    const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const scope = normalizeAppliesTo({
      outletTypes: list(q.outletTypes),
      programs: list(q.programs),
      subPrograms: list(q.subPrograms),
    });
    const count = await this.prisma.outlet.count({
      where: { AND: [LIVE_OUTLET_WHERE(user.clientId), appliesToOutletWhere(scope)] },
    });
    return { count };
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

  // ─── APPLIES-TO scope hooks for templates / uploads (D1/D2) ──────────────────

  /** code → effective KPI scope, for the scope-enforced (kpiScopeEnforced) paths only. */
  private static kpiScopeMap(kpiRows: ReadonlyArray<KpiScopeLike & { code: string }>): Map<string, AppliesTo> {
    return new Map(kpiRows.map((k) => [k.code, kpiAppliesTo(k)]));
  }

  // Template + final-targets / sales-data downloads are export kinds (exports/kinds/batch2/targets.kinds.ts),
  // streamed in pages or prepared on the Downloads page — see the Downloads page design.

  // ─── Target upload ──────────────────────────────────────────────────────────
  //
  // OWNER DECISION 2026-11-25 (all tenants): the admin screen PREVIEWS first, then applies on "Confirm & apply".
  //   1. POST /admin/targets/upload?preview=1  → previewTargetUpload: parse + validate + classify, NOTHING written.
  //      Returns `previewToken` = "<sha256 of the file bytes>.<random nonce>".
  //   2. POST /admin/targets/upload?confirmToken=<token> with the SAME file → uploadTargets: the bytes must hash to the
  //      token's hash (else 409 — a different/edited file), the file is re-validated against the CURRENT roster/KPIs
  //      (the response is the ground truth of what was written), and the batch row is created with the deterministic
  //      id `tgtup_<nonce>` BEFORE any target is written — a second apply of the same preview (double-click, retry)
  //      hits the primary key and is refused with 409, so one preview can be applied at most once.
  // Both paths share prepareTargetUpload — the parsing / validation / past-month lock rules exist ONCE.
  // A POST without either param applies directly, exactly as before (scripts / e2e harness keep working).

  /** previewToken / confirmToken: "<sha256 hex of the file bytes>.<32-hex nonce>". */
  private static readonly TOKEN_RE = /^([a-f0-9]{64})\.([a-f0-9]{32})$/;
  /** How many overwritten outlet-months are read back to find "old → new" examples (cheap, bounded). */
  private static readonly OVERWRITE_SAMPLE = 50;
  private static readonly OVERWRITE_EXAMPLES_MAX = 5;

  /**
   * The shared parse + validate step of a target upload (preview AND apply). Reads only; writes nothing.
   */
  private async prepareTargetUpload(user: JwtPayload, file: Express.Multer.File) {
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

    // ── Fetch all non-deleted outlet codes ────────────────────────────────────
    // Targets can be uploaded for any outlet regardless of KYC/active state
    // (only soft-deleted are excluded).
    // APPLIES-TO D1: the scope facets are only read for a scope-enforced tenant (else the query is unchanged).
    const scopeEnforced = kpiScopeEnforced(kpiRows);
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: {
        outletCode: true,
        name: true,
        outletType: { select: { code: true } },
        ...(scopeEnforced ? { programName: true, programCategory: true } : {}),
      },
    });
    const parseScope = scopeEnforced ? this.parseScope(kpiRows, outlets) : undefined;

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
      parseResult = parseScope
        ? parseTargetUploadBuffer(file.buffer, kpis, knownOutletCodes, { scope: parseScope })
        : parseTargetUploadBuffer(file.buffer, kpis, knownOutletCodes);
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

    // One write per (outletCode, writable month) with ≥1 non-blank value — exactly the rows apply upserts.
    const writes: TargetUploadWrite[] = [];
    for (const [month, outletMap] of Object.entries(parseResult.acceptedTargets)) {
      if (isMonthLocked(month, currentMonth)) continue; // past month — not editable
      for (const [outletCode, kpiMap] of Object.entries(outletMap)) {
        if (Object.keys(kpiMap).length === 0) continue; // safety: skip fully-blank
        writes.push({
          month,
          outletCode,
          outletName: outletMeta.get(outletCode)?.name ?? outletCode,
          kpiMap: kpiMap as Record<string, unknown>,
          // Owner decision (audit #3): a re-upload NEVER deletes stored values of KPIs that are out of scope
          // for this outlet (their cells were ignored by the parser). Only a scope-enforced tenant has any.
          carry: parseScope ? parseScope.outOfScopeCodes(outletCode) : [],
        });
      }
    }

    return {
      scopeEnforced,
      parseResult,
      sortedMonths,
      lockedMonths,
      writableMonths,
      batchMonth,
      writes,
      kpiLabels: new Map(kpiRows.map((k) => [k.code, k.label])),
    };
  }

  /** The response fields shared by preview and apply (same shape the screen already renders). */
  private static uploadSummary(p: Awaited<ReturnType<TargetsService['prepareTargetUpload']>>) {
    return {
      month:         p.batchMonth,
      monthsInBatch: p.sortedMonths,
      writableMonths: p.writableMonths,
      // Past months present in the file that are skipped (locked, not editable).
      skippedLockedMonths: p.lockedMonths,
      totalRows:     p.parseResult.summary.total,
      acceptedCount: p.parseResult.summary.accepted,
      rejectedCount: p.parseResult.summary.rejected,
      // APPLIES-TO D1: numeric values dropped as out of the KPI's scope — present ONLY for a tenant
      // with a scoped KPI (an all-unscoped tenant's response stays byte-identical).
      ...(p.scopeEnforced ? { ignoredOutOfScope: p.parseResult.summary.ignoredOutOfScope } : {}),
    };
  }

  /**
   * NEW vs OVERWRITTEN split of the upload's writes, against the targets stored NOW. One key-only read per month
   * (outlet codes only, no values). `overwritten` keeps the first OVERWRITE_SAMPLE keys for the example read.
   */
  private async classifyTargetWrites(clientId: string, writes: readonly TargetUploadWrite[]) {
    const byMonth = new Map<string, TargetUploadWrite[]>();
    for (const w of writes) {
      const list = byMonth.get(w.month) ?? [];
      list.push(w);
      byMonth.set(w.month, list);
    }
    const perMonth: Array<{ month: string; newCount: number; overwriteCount: number }> = [];
    const sample: TargetUploadWrite[] = [];
    let newCount = 0;
    let overwriteCount = 0;
    for (const month of [...byMonth.keys()].sort()) {
      const stored = await this.prisma.outletTarget.findMany({
        where: { clientId, month },
        select: { outletCode: true },
      });
      const existing = new Set((stored ?? []).map((r) => r.outletCode));
      let n = 0;
      let o = 0;
      for (const w of byMonth.get(month)!) {
        if (existing.has(w.outletCode)) {
          o++;
          if (sample.length < TargetsService.OVERWRITE_SAMPLE) sample.push(w);
        } else n++;
      }
      perMonth.push({ month, newCount: n, overwriteCount: o });
      newCount += n;
      overwriteCount += o;
    }
    return { newCount, overwriteCount, perMonth, sample };
  }

  /**
   * Up to OVERWRITE_EXAMPLES_MAX "old → new" examples among the sampled overwritten outlet-months. The new value is
   * what apply would store: the uploaded map, plus the carried-over (out-of-scope) stored codes. A KPI stored today
   * but absent from the file shows as "→ removed" (the upload replaces the outlet-month's values).
   */
  private async overwriteExamples(
    clientId: string,
    sample: readonly TargetUploadWrite[],
    kpiLabels: ReadonlyMap<string, string>,
  ) {
    const byMonth = new Map<string, TargetUploadWrite[]>();
    for (const w of sample) byMonth.set(w.month, [...(byMonth.get(w.month) ?? []), w]);
    const examples: Array<{
      outletCode: string;
      outletName: string;
      month: string;
      changes: Array<{ kpiCode: string; label: string; from: unknown; to: unknown }>;
    }> = [];
    for (const month of [...byMonth.keys()].sort()) {
      const ws = byMonth.get(month)!;
      const rows = await this.prisma.outletTarget.findMany({
        where: { clientId, month, outletCode: { in: ws.map((w) => w.outletCode) } },
        select: { outletCode: true, targetValues: true },
      });
      const storedBy = new Map((rows ?? []).map((r) => [r.outletCode, (r.targetValues ?? {}) as Record<string, unknown>]));
      for (const w of ws) {
        if (examples.length >= TargetsService.OVERWRITE_EXAMPLES_MAX) return examples;
        const old = storedBy.get(w.outletCode);
        if (!old) continue;
        const next: Record<string, unknown> = { ...w.kpiMap };
        for (const c of w.carry) if (c in old) next[c] = old[c];
        const codes = [...new Set([...kpiCodeKeys(old), ...kpiCodeKeys(next)])];
        const changes = codes
          .filter((c) => old[c] !== next[c])
          .map((c) => ({ kpiCode: c, label: kpiLabels.get(c) ?? c, from: old[c] ?? null, to: next[c] ?? null }));
        if (changes.length > 0) examples.push({ outletCode: w.outletCode, outletName: w.outletName, month, changes });
      }
    }
    return examples;
  }

  /**
   * PREVIEW a target upload: the same parse + validation as apply, plus how many outlet-months would be NEWLY created
   * vs OVERWRITTEN (per month) and a few old → new examples. Writes NOTHING (no batch row, no targets, no
   * notifications). The returned `previewToken` is what "Confirm & apply" sends back with the same file.
   */
  async previewTargetUpload(user: JwtPayload, file: Express.Multer.File) {
    const p = await this.prepareTargetUpload(user, file);
    const cls = await this.classifyTargetWrites(user.clientId, p.writes);
    const overwriteExamples = await this.overwriteExamples(user.clientId, cls.sample, p.kpiLabels);
    const focusCheck = await targetUploadFocusCheck(
      this.prisma,
      user.clientId,
      p.parseResult.acceptedTargets as Record<string, Record<string, unknown>>,
      p.writableMonths,
    );
    return {
      preview: true as const,
      previewToken: `${createHash('sha256').update(file.buffer).digest('hex')}.${randomBytes(16).toString('hex')}`,
      ...TargetsService.uploadSummary(p),
      // What apply WOULD write if confirmed now (one upsert per outlet × writable month with ≥1 value).
      willSaveCount:  p.writes.length,
      newCount:       cls.newCount,
      overwriteCount: cls.overwriteCount,
      perMonth:       cls.perMonth,
      overwriteExamples,
      // How many overwritten outlet-months were compared to find the examples (the examples are a sample).
      overwriteExamplesSampled: cls.sample.length,
      ...targetUploadRowsEcho(p.parseResult.rows),
      focusCheck,
    };
  }

  /**
   * Parse and store targets from an uploaded .xlsx file.
   *
   * Blank cell → omitted key (not stored as 0). Numbers are stored verbatim.
   * Uses upsert on (clientId, outletCode, month) so re-uploads are idempotent.
   * Tracks totals on a TargetUploadBatch row.
   *
   * `opts.confirmToken` (from previewTargetUpload): the file must be the previewed one, and a token applies ONCE.
   */
  async uploadTargets(user: JwtPayload, file: Express.Multer.File, opts?: { confirmToken?: string }) {
    if (!file) throw new BadRequestException('No file uploaded');

    let batchId: string | undefined;
    if (opts?.confirmToken !== undefined) {
      const m = TargetsService.TOKEN_RE.exec(opts.confirmToken);
      if (!m) throw new BadRequestException('Invalid confirmation token. Pick the file again to preview it.');
      if (createHash('sha256').update(file.buffer).digest('hex') !== m[1]) {
        throw new ConflictException(
          'This file is not the one you previewed (it was changed or replaced). Nothing was saved. Pick the file again to preview it.',
        );
      }
      batchId = `tgtup_${m[2]}`;
    }

    const p = await this.prepareTargetUpload(user, file);
    // Classified against the stored targets just before the write (the final, real split — the preview may differ
    // if targets were changed in between).
    const cls = await this.classifyTargetWrites(user.clientId, p.writes);

    // ── Persist ────────────────────────────────────────────────────────────────
    // The outlet roster is now EVERY non-deleted outlet (not just active), so an
    // upload can carry thousands of rows. A single interactive $transaction with one
    // awaited upsert per row blows the 5s interactive-transaction timeout at that
    // scale (Prisma: "query cannot be executed on an expired transaction"). Instead
    // create the batch row, then run the per-row upserts in CHUNKED batched
    // transactions ($transaction([...])) so each round-trip stays well under the
    // timeout and the write scales to thousands of outlets. Re-upload stays
    // idempotent (upsert semantics preserved).
    let batch: { id: string };
    try {
      batch = await this.prisma.targetUploadBatch.create({
        data: {
          ...(batchId ? { id: batchId } : {}),
          clientId:     user.clientId,
          uploadedById: user.sub,
          month:        p.batchMonth,
          totalRows:    p.parseResult.summary.total,
          acceptedCount: p.parseResult.summary.accepted,
          rejectedCount: p.parseResult.summary.rejected,
          status: 'COMPLETED',
        },
      });
    } catch (e) {
      // Double-apply guard: the deterministic batch id of a preview token already exists → this preview was applied.
      if (batchId && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'These targets were already applied from this preview — nothing was saved twice. Use Download Final Targets to check them.',
        );
      }
      throw e;
    }

    // Build one OutletTarget upsert per (outletCode, month) with non-blank values. Each op is a THUNK built when its
    // chunk runs, so every row's updatedAt is stamped at its chunk's write time (not when the list was built): Sales
    // Import's "targets changed since the last apply" reads MAX(updatedAt) of the month's rows (FOCUS-FROM-TARGETS).
    const targetOps: Array<() => Prisma.PrismaPromise<unknown>> = [];
    for (const { month, outletCode, outletName, kpiMap, carry } of p.writes) {
      // Carry over the out-of-scope stored codes inside the statement (scope-enforced tenants only).
      if (carry.length > 0) {
        const col = Prisma.sql`"outlet_targets"."targetValues"`;
        targetOps.push(() =>
          this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "outlet_targets"
              ("id","clientId","outletCode","outletName","month","targetValues","batchId","createdAt","updatedAt")
            VALUES (${randomUUID()}, ${user.clientId}, ${outletCode}, ${outletName}, ${month},
                    ${JSON.stringify(kpiMap)}::jsonb, ${batch.id}, ${SQL_NOW_UTC}, ${SQL_NOW_UTC})
            ON CONFLICT ("clientId","outletCode","month") DO UPDATE SET
              "targetValues" = ${TargetsService.carryOverSql(col, Prisma.sql`EXCLUDED."targetValues"`, carry, true)},
              "outletName"   = EXCLUDED."outletName",
              "batchId"      = EXCLUDED."batchId",
              "updatedAt"    = ${SQL_NOW_UTC}`),
        );
        continue;
      }

      targetOps.push(() =>
        this.prisma.outletTarget.upsert({
          where: {
            clientId_outletCode_month: { clientId: user.clientId, outletCode, month },
          },
          create: {
            clientId:     user.clientId,
            outletCode,
            outletName,
            month,
            targetValues: kpiMap as unknown as Prisma.InputJsonValue,
            batchId:      batch.id,
          },
          update: {
            targetValues: kpiMap as unknown as Prisma.InputJsonValue,
            outletName,
            batchId:      batch.id,
            updatedAt:    new Date(),
          },
        }),
      );
    }

    try {
      for (let i = 0; i < targetOps.length; i += TargetsService.UPLOAD_CHUNK) {
        await this.prisma.$transaction(targetOps.slice(i, i + TargetsService.UPLOAD_CHUNK).map((op) => op()));
      }
    } catch (e) {
      // Earlier chunks may already be saved — never leave the batch claiming COMPLETED (best-effort; rethrow the cause).
      await this.prisma.targetUploadBatch
        .update({ where: { id: batch.id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw e;
    }

    // Notify the assigned rep (XSR) + their manager (SO) for every outlet that got a
    // target this upload. Fire-and-forget + tenant-scoped; never blocks the upload.
    const notifiedCodes = new Set(p.writes.map((w) => w.outletCode));
    await this.salesNotifications.targetsUploaded(user.clientId, [...notifiedCodes]);

    // FOCUS-FROM-TARGETS §7: early, NON-blocking check of the focus product names this upload wrote (never throws;
    // `checked: false` for a tenant without a "from the target file" Sales Import KPI). The month preview re-checks.
    const focusCheck = await targetUploadFocusCheck(
      this.prisma,
      user.clientId,
      p.parseResult.acceptedTargets as Record<string, Record<string, unknown>>,
      p.writableMonths,
    );

    return {
      batchId:       batch.id,
      ...TargetsService.uploadSummary(p),
      // The GROUND TRUTH of what was actually persisted this upload: one OutletTarget
      // upsert per (outlet, writable-month) with ≥1 non-blank KPI. This is the number
      // the confirmation message reports — `acceptedCount` can be higher because it
      // counts parse-valid rows for LOCKED past months too, which are not written.
      savedCount:    targetOps.length,
      // Of savedCount: outlet-months created vs existing ones replaced (split read just before the write).
      newCount:       cls.newCount,
      overwriteCount: cls.overwriteCount,
      perMonth:       cls.perMonth,
      // Memory-safety (2026-11-13): only the rejected rows + the ignored-value warning rows come back
      // (each capped at 500, slimmed to row/outlet/status/remarks) — not every parsed row with its values.
      ...targetUploadRowsEcho(p.parseResult.rows),
      focusCheck,
    };
  }

  /** D1 parser hook: outletCode × KPI code → in the KPI's scope (by the outlet's CURRENT facets). */
  private parseScope(
    kpiRows: ReadonlyArray<KpiScopeLike & { code: string }>,
    outlets: ReadonlyArray<{ outletCode: string; outletType: { code: string }; programName?: string | null; programCategory?: string | null }>,
  ): {
    isInScope: (outletCode: string, kpiCode: string) => boolean;
    outOfScopeCodes: (outletCode: string) => string[];
  } {
    const scopes = TargetsService.kpiScopeMap(kpiRows);
    const facets = new Map(
      outlets.map((o) => [
        o.outletCode,
        { outletType: o.outletType.code, program: o.programName ?? null, subProgram: o.programCategory ?? null },
      ]),
    );
    const isInScope = (outletCode: string, kpiCode: string) => {
      const sc = scopes.get(kpiCode);
      const f = facets.get(outletCode);
      return !sc || !f || appliesToOutlet(sc, f);
    };
    return {
      isInScope,
      // Owner decision (audit #3): the KPI codes whose STORED values a re-upload must carry over untouched
      // for this outlet — every enabled KPI that is out of scope for it (the parser ignores those cells).
      outOfScopeCodes: (outletCode) => kpiRows.map((k) => k.code).filter((c) => !isInScope(outletCode, c)),
    };
  }

  /**
   * ON CONFLICT value expression for a manual re-upload that must PRESERVE some stored keys (`carry`):
   * the stored subset for those keys, overlaid by the uploaded values. For targets, per-outlet custom
   * names (`__names`) of carried KPIs are preserved the same way (merged under the uploaded names).
   * Computed inside the statement (no read-then-write window).
   */
  private static carryOverSql(
    column: Prisma.Sql,
    incoming: Prisma.Sql,
    carry: readonly string[],
    withNames: boolean,
  ): Prisma.Sql {
    // `'__names'` is a SQL literal (= NAMES_KEY) — a bound param would leave `->` ambiguous (text vs int).
    const base = Prisma.sql`(${ownedSubsetSql(column, carry)} || ${incoming})`;
    if (!withNames) return base;
    const carriedNames = ownedSubsetSql(Prisma.sql`COALESCE(${column}->'__names', '{}'::jsonb)`, carry);
    return Prisma.sql`CASE WHEN ${carriedNames} = '{}'::jsonb THEN ${base}
      ELSE ${base} || jsonb_build_object('__names', ${carriedNames} || COALESCE(${incoming}->'__names', '{}'::jsonb)) END`;
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

    // ── Fetch all non-deleted outlet codes ────────────────────────────────────
    // Achievements can be uploaded for any outlet regardless of KYC/active state
    // (only soft-deleted are excluded).
    // APPLIES-TO D1: the scope facets are only read for a scope-enforced tenant (else the query is unchanged).
    const scopeEnforced = kpiScopeEnforced(kpiRows);
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: {
        outletCode: true,
        name: true,
        outletType: { select: { code: true } },
        ...(scopeEnforced ? { programName: true, programCategory: true } : {}),
      },
    });
    const parseScope = scopeEnforced ? this.parseScope(kpiRows, outlets) : undefined;

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

    // Sales Import source ownership (§7.4). Importer-owned KPI columns are NOT accepted here: they are
    // dropped from the parse (unknown labels are already skipped by the parser) and reported back.
    // A tenant with no SalesKpiDefinition (Deoleo, every tenant today) → [] → the existing path, unchanged.
    const owned = await importerOwnedKpiCodes(this.prisma, user.clientId);
    let parseKpis = kpis;
    let skippedImporterOwnedKpis: string[] | undefined;
    if (owned.length > 0) {
      parseKpis = kpis.filter((k) => !owned.includes(k.code));
      if (parseKpis.length === 0) {
        throw new BadRequestException(
          'Every enabled KPI is fed by Sales Import, so there is nothing to upload manually.',
        );
      }
      const headerLabels = achievementHeaderLabels(file.buffer);
      skippedImporterOwnedKpis = kpis
        .filter((k) => owned.includes(k.code) && headerLabels.has(k.label.toLowerCase().trim()))
        .map((k) => k.code);
    }

    let parseResult: ReturnType<typeof parseTargetUploadBuffer>;
    try {
      parseResult = parseScope
        ? parseTargetUploadBuffer(file.buffer, parseKpis, knownOutletCodes, { scope: parseScope })
        : parseTargetUploadBuffer(file.buffer, parseKpis, knownOutletCodes);
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

    // ── Persist ────────────────────────────────────────────────────────────────
    // Same scale concern as uploadTargets: the roster is now every non-deleted
    // outlet, so one interactive $transaction with an await-per-row upsert blows the
    // 5s timeout. Create the batch row, then run the upserts in CHUNKED batched
    // transactions. Re-upload stays idempotent.
    const batch = await this.prisma.salesUploadBatch.create({
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

    // Build one OutletSalesRecord upsert per (outletCode, month) with non-blank values.
    const salesOps: Prisma.PrismaPromise<unknown>[] = [];
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

        // Sales Import ownership: the row's importer-owned keys SURVIVE the manual rewrite. The carry-over
        // is done inside the statement (no read-then-write window vs a concurrent apply). Never runs for a
        // tenant without owned KPIs.
        // Owner decision (audit #3): stored values of KPIs OUT OF SCOPE for this outlet survive the same
        // way (their cells were ignored by the parser). Only a scope-enforced tenant has such codes.
        const oos = parseScope ? parseScope.outOfScopeCodes(outletCode) : [];
        if (owned.length > 0 || oos.length > 0) {
          const carry = [...new Set([...owned, ...oos])];
          salesOps.push(
            this.prisma.$executeRaw(Prisma.sql`
              INSERT INTO "outlet_sales_records"
                ("id","clientId","outletCode","outletName","month","kpiValues","batchId","createdAt","updatedAt")
              VALUES (${randomUUID()}, ${user.clientId}, ${outletCode}, ${meta?.name ?? outletCode}, ${month},
                      ${JSON.stringify(kpiMap)}::jsonb, ${batch.id}, ${SQL_NOW_UTC}, ${SQL_NOW_UTC})
              ON CONFLICT ("clientId","outletCode","month") DO UPDATE SET
                "kpiValues"  = ${TargetsService.carryOverSql(Prisma.sql`"outlet_sales_records"."kpiValues"`, Prisma.sql`EXCLUDED."kpiValues"`, carry, false)},
                "outletName" = EXCLUDED."outletName",
                "batchId"    = EXCLUDED."batchId",
                "updatedAt"  = ${SQL_NOW_UTC}`),
          );
          continue;
        }

        salesOps.push(
          this.prisma.outletSalesRecord.upsert({
            where: {
              clientId_outletCode_month: { clientId: user.clientId, outletCode, month },
            },
            create: {
              clientId:   user.clientId,
              outletCode,
              outletName: meta?.name ?? outletCode,
              month,
              kpiValues:  kpiMap as unknown as Prisma.InputJsonValue,
              batchId:    batch.id,
            },
            update: {
              kpiValues:  kpiMap as unknown as Prisma.InputJsonValue,
              outletName: meta?.name ?? outletCode,
              batchId:    batch.id,
              updatedAt:  new Date(),
            },
          }),
        );
      }
    }

    for (let i = 0; i < salesOps.length; i += TargetsService.UPLOAD_CHUNK) {
      await this.prisma.$transaction(salesOps.slice(i, i + TargetsService.UPLOAD_CHUNK));
    }

    return {
      batchId:       batch.id,
      month:         batchMonth,
      monthsInBatch: sortedMonths,
      totalRows,
      acceptedCount,
      rejectedCount,
      // APPLIES-TO D1: numeric values dropped as out of the KPI's scope — present ONLY for a tenant
      // with a scoped KPI (an all-unscoped tenant's response stays byte-identical).
      ...(scopeEnforced ? { ignoredOutOfScope: parseResult.summary.ignoredOutOfScope } : {}),
      // Memory-safety (2026-11-13): only the rejected rows + the ignored-value warning rows come back
      // (each capped at 500, slimmed to row/outlet/status/remarks) — not every parsed row with its values.
      ...targetUploadRowsEcho(parseResult.rows),
      // Additive, ONLY for tenants with importer-owned KPIs (absent otherwise → Deoleo response unchanged).
      ...(skippedImporterOwnedKpis !== undefined ? { skippedImporterOwnedKpis } : {}),
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

    // Sales Import (§7.4): an importer batch is managed by Sales Import only (no tenant without the
    // feature can have one — Deoleo never does).
    if (batch.status === SALES_IMPORT_BATCH_STATUS) {
      throw new ConflictException('This batch was written by Sales Import; manage it there.');
    }

    // Owned-tenant branch: deleting a MANUAL batch must not take importer-owned values with it (the
    // schema cascade would delete whole rows). Never runs for a tenant without owned KPIs.
    const owned = await importerOwnedKpiCodes(this.prisma, user.clientId);

    // APPLIES-TO (OWNER DECISION, audit #3): deleting a batch must NOT remove stored values of KPIs that are OUT OF
    // SCOPE for the row's outlet (the same rule as a re-upload). Only a scope-enforced tenant reaches this branch;
    // an all-unscoped tenant (Deoleo) keeps the exact pre-scope paths below.
    const carryScope = await this.outOfScopeCarryScope(user.clientId);
    if (carryScope) {
      const removedRecords = await this.deleteManualBatchKeepingCarried(user.clientId, id, owned, carryScope);
      return { deleted: true, id, removedRecords };
    }

    if (owned.length > 0) {
      // L4: report the rows ACTUALLY removed (rows that kept importer-owned values were re-pointed, not deleted).
      const removedRecords = await this.deleteManualBatchKeepingOwned(user.clientId, id, owned);
      return { deleted: true, id, removedRecords };
    }

    await this.prisma.salesUploadBatch.delete({ where: { id } });
    return { deleted: true, id, removedRecords: batch.acceptedCount };
  }

  /**
   * One transaction, per month of the batch's rows (advisory-locked with the same key as a Sales Import apply /
   * close, in sorted order): rows of this batch that carry an importer-owned key keep ONLY their owned keys and
   * are re-pointed to that month's latest SALES_IMPORT batch; then the batch is deleted and the cascade removes
   * the rows that held only manual data. A month with no SALES_IMPORT batch has never been applied, so its
   * owned-key values are themselves manual data (written before the KPI became importer-owned) → they go too.
   */
  private async deleteManualBatchKeepingOwned(clientId: string, batchId: string, owned: string[]): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const monthRows = await tx.outletSalesRecord.findMany({
          where: { clientId, batchId },
          select: { month: true },
          distinct: ['month'],
        });
        const months = monthRows.map((r) => r.month).sort();
        for (const month of months) {
          await lockSalesMonth(tx, clientId, month);
        }
        for (const month of months) {
          const importerBatch = await tx.salesUploadBatch.findFirst({
            where: { clientId, month, status: SALES_IMPORT_BATCH_STATUS },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          });
          if (!importerBatch) continue;
          await tx.$executeRaw(Prisma.sql`
            UPDATE "outlet_sales_records"
               SET "kpiValues" = ${ownedSubsetSql(Prisma.sql`"kpiValues"`, owned)},
                   "batchId"   = ${importerBatch.id},
                   "updatedAt" = ${SQL_NOW_UTC}
             WHERE "clientId" = ${clientId} AND "batchId" = ${batchId} AND "month" = ${month}
               AND "kpiValues" ?| ${owned}::text[]`);
        }
        // What the cascade below removes = the rows still pointing at this batch after the re-pointing above.
        const removed = await tx.outletSalesRecord.count({ where: { clientId, batchId } });
        await tx.salesUploadBatch.delete({ where: { id: batchId } });
        return removed;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  /**
   * The per-outlet out-of-scope KPI codes (same predicate as the upload carry-over: enabled KPIs × the outlet's
   * CURRENT facets), or `null` for a tenant with no scoped KPI (→ the caller keeps its pre-scope path).
   */
  private async outOfScopeCarryScope(
    clientId: string,
  ): Promise<{ outOfScopeCodes: (outletCode: string) => string[] } | null> {
    const kpiRows = await this.prisma.kpiDef.findMany({ where: { clientId, enabled: true } });
    if (!kpiScopeEnforced(kpiRows)) return null;
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId, deletedAt: null },
      select: { outletCode: true, outletType: { select: { code: true } }, programName: true, programCategory: true },
    });
    return this.parseScope(kpiRows, outlets);
  }

  /**
   * Scope-enforced variant of the batch delete (one transaction; months advisory-locked like the owned path). Per
   * row of the batch, the keys that SURVIVE are:
   *   • importer-owned keys — only when the month has a SALES_IMPORT batch (exactly the owned-path rule), held by
   *     that importer batch;
   *   • keys of KPIs OUT OF SCOPE for the row's outlet (never owned) — always, held by the latest OTHER batch of the
   *     same month, else the latest other batch of the tenant (any status — a Sales Import apply keeps non-owned
   *     keys and the row's batchId). If the tenant has NO other batch, there is nowhere to keep them → 409 and
   *     nothing changes (the owner rule forbids deleting them).
   * A row with surviving keys keeps ONLY those keys and is re-pointed; every other row goes with the batch cascade.
   * Rows are updated per (holder × surviving-key set) group — a handful of statements, not one per row.
   */
  private async deleteManualBatchKeepingCarried(
    clientId: string,
    batchId: string,
    owned: string[],
    scope: { outOfScopeCodes: (outletCode: string) => string[] },
  ): Promise<number> {
    const ownedSet = new Set(owned);
    return this.prisma.$transaction(
      async (tx) => {
        const monthRows = await tx.outletSalesRecord.findMany({
          where: { clientId, batchId },
          select: { month: true },
          distinct: ['month'],
        });
        const months = monthRows.map((r) => r.month).sort();
        for (const month of months) {
          await lockSalesMonth(tx, clientId, month);
        }
        let tenantFallback: { id: string } | null | undefined;
        for (const month of months) {
          const importerBatch =
            owned.length > 0
              ? await tx.salesUploadBatch.findFirst({
                  where: { clientId, month, status: SALES_IMPORT_BATCH_STATUS },
                  orderBy: { createdAt: 'desc' },
                  select: { id: true },
                })
              : null;
          let monthHolder: { id: string } | null | undefined;
          const holderForCarried = async (): Promise<string> => {
            if (monthHolder === undefined) {
              monthHolder = await tx.salesUploadBatch.findFirst({
                where: { clientId, month, id: { not: batchId } },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              });
            }
            if (monthHolder) return monthHolder.id;
            if (tenantFallback === undefined) {
              tenantFallback = await tx.salesUploadBatch.findFirst({
                where: { clientId, id: { not: batchId } },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              });
            }
            if (tenantFallback) return tenantFallback.id;
            throw new ConflictException(
              'This upload batch is the only one left holding values for KPIs that do not apply to some of its outlets. ' +
                'Those values are kept by design, so this batch cannot be deleted.',
            );
          };

          const rows = await tx.outletSalesRecord.findMany({
            where: { clientId, batchId, month },
            select: { outletCode: true, kpiValues: true },
          });
          const groups = new Map<string, { holder: string; keep: string[]; codes: string[] }>();
          for (const r of rows) {
            const keys = new Set(kpiCodeKeys((r.kpiValues ?? {}) as Record<string, unknown>));
            const keepOwned = importerBatch ? owned.filter((k) => keys.has(k)) : [];
            const keepOos = scope.outOfScopeCodes(r.outletCode).filter((k) => keys.has(k) && !ownedSet.has(k));
            if (keepOwned.length === 0 && keepOos.length === 0) continue;
            const holder = keepOwned.length > 0 ? importerBatch!.id : await holderForCarried();
            const keep = [...keepOwned, ...keepOos].sort();
            const gk = `${holder}|${keep.join(',')}`;
            const g = groups.get(gk) ?? { holder, keep, codes: [] };
            g.codes.push(r.outletCode);
            groups.set(gk, g);
          }
          for (const g of groups.values()) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE "outlet_sales_records"
                 SET "kpiValues" = ${ownedSubsetSql(Prisma.sql`"kpiValues"`, g.keep)},
                     "batchId"   = ${g.holder},
                     "updatedAt" = ${SQL_NOW_UTC}
               WHERE "clientId" = ${clientId} AND "batchId" = ${batchId} AND "month" = ${month}
                 AND "outletCode" = ANY(${g.codes}::text[])`);
          }
        }
        const removed = await tx.outletSalesRecord.count({ where: { clientId, batchId } });
        await tx.salesUploadBatch.delete({ where: { id: batchId } });
        return removed;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
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

    // Fetch both sides in parallel — they may not have identical outlet sets. The KPI scopes ride
    // along so out-of-scope (outlet, KPI) pairs are EXCLUDED (OWNER DECISION 2026-11-12: every
    // aggregate reader agrees — pace, sales screens, leaderboard, points compute give the same
    // totals). Raw data EXPORTS still dump stored values (D3).
    const [targetRows, achievementRows, kpiScopeRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: whereBase,
        select: { outletCode: true, outletName: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { outletCode: true, kpiValues: true },
      }),
      this.prisma.kpiDef.findMany({
        where: { clientId: user.clientId, enabled: true },
        select: { code: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
      }),
    ]);
    // Only a tenant with a scoped KPI is filtered (all-unscoped tenant, e.g. Deoleo: response unchanged).
    const paceScopes = kpiScopeEnforced(kpiScopeRows ?? []) ? TargetsService.kpiScopeMap(kpiScopeRows) : null;

    // Index by outletCode
    const targetIndex = new Map(targetRows.map((r) => [r.outletCode, r]));
    const achievementIndex = new Map(achievementRows.map((r) => [r.outletCode, r]));

    // Union of outlet codes from both sides
    const allOutletCodes = new Set([
      ...targetIndex.keys(),
      ...achievementIndex.keys(),
    ]);

    // outletType resolves from the AUTHORITATIVE Outlet.outletType.code (Phase 1 root-fix), NOT the
    // stale OutletTarget.outletType snapshot. Scoped to only the codes present in this month's result.
    const outletTypeRows = allOutletCodes.size
      ? await this.prisma.outlet.findMany({
          where: {
            clientId: user.clientId,
            outletCode: { in: [...allOutletCodes] },
            deletedAt: null,
          },
          select: {
            outletCode: true,
            outletType: { select: { code: true } },
            ...(paceScopes ? { programName: true, programCategory: true } : {}),
          },
        })
      : [];
    const outletTypeByCode = new Map(outletTypeRows.map((o) => [o.outletCode, o.outletType?.code]));
    const outletFacetsByCode = new Map(
      outletTypeRows.map((o) => {
        const r = o as typeof o & { programName?: string | null; programCategory?: string | null };
        return [
          o.outletCode,
          { outletType: o.outletType?.code ?? null, program: r.programName ?? null, subProgram: r.programCategory ?? null },
        ];
      }),
    );

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
      const facets = outletFacetsByCode.get(outletCode);

      for (const code of allKpiCodes) {
        // APPLIES-TO: a stored value for a KPI that does not apply to this outlet (by its CURRENT
        // facets) is not part of the outlet's pace. A deleted / unknown outlet (no facets) is kept.
        const sc = paceScopes?.get(code);
        if (sc && facets && !appliesToOutlet(sc, facets)) continue;

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
        outletType: outletTypeByCode.get(outletCode) ?? '',
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
