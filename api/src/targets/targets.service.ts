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
  GoneException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, type StoredObjectStream } from '../storage/storage.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  TargetHistoryQueryDto,
} from './dto/targets.dto';
import {
  parseTargetUploadBuffer,
  targetUploadRowsEcho,
  currentMonthKey,
  isMonthLocked,
  kpiCodeKeys,
  KpiDefLike,
  NAMES_KEY,
  TemplateFormatError,
  findNumericFocusNames,
  labelKey,
  nameColumnHeader,
  type NumericFocusName,
} from './targets.helpers';

/**
 * The 400 for an upload the shared parser could not use: the parser's own specific, actionable message (template
 * shape / KPI columns) when it gave one; the generic message only for a file that cannot be read as xlsx at all.
 */
export function uploadParseError(e: unknown): BadRequestException {
  if (e instanceof TemplateFormatError) return new BadRequestException(`${e.message}. Nothing was saved.`);
  return new BadRequestException('Invalid or corrupted xlsx file');
}
import { SQL_NOW_UTC } from '../sales-import/sql-time';
import { targetUploadFocusCheck } from '../sales-import/kpi/focus-upload-check';
import { focusNamesKpiOf } from '../sales-import/kpi/focus-products';
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

/**
 * What a target upload will NOT apply as typed — each must be explicitly acknowledged before a confirmed apply
 * (owner rule 2026-11-25, "no silent failure"). Plain-words labels are used in the 400 that names missing ones.
 */
export const TARGET_UPLOAD_ACK_CATEGORIES = {
  REJECTED_ROWS:  'rows that will not be saved (rejected)',
  OVERWRITE:      'existing outlet-month targets that will be replaced',
  LOCKED_MONTHS:  'outlet-month targets in past (locked) months that will not be saved',
  BLANK_ROWS:     'blank rows that will not be saved',
  IGNORED_VALUES: "values ignored because the KPI doesn't apply to the outlet",
} as const;
export type TargetUploadAckCategory = keyof typeof TARGET_UPLOAD_ACK_CATEGORIES;

/**
 * AuditLog.entityType of an apply ATTEMPT that got as far as a batch (entityId = the TargetUploadBatch id), written once
 * with its outcome: metadata.status 'APPLIED' (in the same transaction as the targets) or 'FAILED' (nothing written).
 */
export const TARGET_UPLOAD_AUDIT_ENTITY = 'TARGET_UPLOAD';
/** AuditLog.entityType of a REFUSED apply (nothing written; entityId = the preview token nonce, else 'no-preview'). */
export const TARGET_UPLOAD_REFUSED_AUDIT_ENTITY = 'TARGET_UPLOAD_REFUSED';
/** AuditLog.entityType of an apply whose outcome could not be confirmed (the DB could not be re-read after an error). */
export const TARGET_UPLOAD_UNCONFIRMED_AUDIT_ENTITY = 'TARGET_UPLOAD_UNCONFIRMED';

/**
 * Why an apply was refused (recorded on the TARGET_UPLOAD_REFUSED audit row). ALREADY_APPLIED / ACK_CHANGED can also be
 * decided INSIDE the apply transaction (a concurrent apply) — still a refusal, never a "failed" upload.
 */
export type TargetUploadRefusal =
  | 'NO_PREVIEW'
  | 'MALFORMED_TOKEN'
  | 'INVALID_TOKEN'
  | 'EXPIRED'
  | 'DIFFERENT_FILE'
  | 'STORAGE_UNAVAILABLE'
  | 'ALREADY_APPLIED'
  | 'ACK_MISSING'
  | 'ACK_CHANGED';

/** One acknowledged not-applied category as sent with "Confirm & apply" (bound to the count + the exact items). */
export interface TargetUploadAck {
  category: string;
  count: number;
  fingerprint: string;
}

/** One category NOT applied as typed (preview + apply responses). */
export interface TargetUploadNotApplied {
  category: TargetUploadAckCategory;
  count: number;
  /** sha256 (16 hex) over the category, count and sorted item keys — what an acknowledgement binds to. */
  fingerprint: string;
  /** The first few item keys ("Row 7 — OUT123", "OUT123 · 2026-12"), for the screen. */
  sample: string[];
}

/** Thrown inside the apply transaction to roll it back with a specific (refusal-type) outcome. */
class TargetUploadAbort extends Error {
  constructor(readonly reason: 'ALREADY_APPLIED' | 'ACK_CHANGED', readonly error: HttpException) {
    super(error.message);
  }
}

/** One target value (or per-outlet custom KPI name) a target upload changes — a target_change_history row. */
export interface TargetChange {
  outletCode: string;
  month: string;
  kpiCode: string;
  /** 'VALUE' = the target number; 'NAME' = the per-outlet custom KPI name (`__names`). */
  field: 'VALUE' | 'NAME';
  oldValue: unknown;
  newValue: unknown;
  changeType: 'CREATED' | 'UPDATED' | 'DELETED';
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pick = (o: Record<string, unknown> | undefined, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o![k]]));

/**
 * What a target upload will change, per value (pure; the apply calls it inside its transaction with the values read
 * under the tenant lock). The stored map after the write mirrors the write statement exactly: the uploaded map
 * REPLACES the stored one, except the carried (out-of-scope) codes — their stored values and custom names are kept.
 * Unchanged values produce NO row. `stored` is keyed "<month>|<outletCode>" (absent = no stored row yet).
 */
export function targetChangesFor(
  writes: ReadonlyArray<{ month: string; outletCode: string; kpiMap: Record<string, unknown>; carry: readonly string[] }>,
  stored: ReadonlyMap<string, Record<string, unknown>>,
): TargetChange[] {
  const out: TargetChange[] = [];
  for (const w of writes) out.push(...targetChangesForWrite(w, stored.get(`${w.month}|${w.outletCode}`)));
  return out;
}

/**
 * targetChangesFor for ONE outlet-month write against its stored map (undefined = no stored row). Empty = the write
 * would leave every stored value and custom name exactly as it is (the upload preview's UNCHANGED outlet-months).
 */
export function targetChangesForWrite(
  w: { month: string; outletCode: string; kpiMap: Record<string, unknown>; carry: readonly string[] },
  stored: Record<string, unknown> | undefined,
): TargetChange[] {
  const out: TargetChange[] = [];
  {
    const old = stored ?? {};
    const next: Record<string, unknown> = { ...pick(old, w.carry), ...w.kpiMap };
    const oldNames = (old[NAMES_KEY] ?? {}) as Record<string, unknown>;
    const carriedNames = pick(oldNames, w.carry);
    if (Object.keys(carriedNames).length > 0) {
      next[NAMES_KEY] = { ...carriedNames, ...((w.kpiMap[NAMES_KEY] ?? {}) as Record<string, unknown>) };
    }
    const nextNames = (next[NAMES_KEY] ?? {}) as Record<string, unknown>;
    const diff = (field: 'VALUE' | 'NAME', a: Record<string, unknown>, b: Record<string, unknown>, codes: string[]) => {
      for (const kpiCode of codes) {
        const has = (o: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(o, kpiCode) && o[kpiCode] !== null;
        const o = has(a) ? a[kpiCode] : undefined;
        const n = has(b) ? b[kpiCode] : undefined;
        if (o === undefined && n === undefined) continue;
        if (o !== undefined && n !== undefined && sameValue(o, n)) continue;
        out.push({
          outletCode: w.outletCode, month: w.month, kpiCode, field,
          oldValue: o ?? null, newValue: n ?? null,
          changeType: o === undefined ? 'CREATED' : n === undefined ? 'DELETED' : 'UPDATED',
        });
      }
    };
    diff('VALUE', old, next, [...new Set([...kpiCodeKeys(old), ...kpiCodeKeys(next)])].sort());
    diff('NAME', oldNames, nextNames, [...new Set([...Object.keys(oldNames), ...Object.keys(nextNames)])].sort());
  }
  return out;
}

/**
 * The real current instant (UTC, Prisma DateTime-comparable) — unlike the SQL transaction-start
 * clock, NOT frozen at the transaction start.
 */
const SQL_CLOCK_UTC = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;
/** Private-bucket folder of the kept upload files: `target-uploads/<clientId>/<batchId>/…`. */
export const TARGET_UPLOAD_FILE_PREFIX = 'target-uploads/';

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

  private readonly logger = new Logger(TargetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesNotifications: SalesNotificationsService,
    // @Global TenantModule provides it in the app; @Optional so unit-test modules that only provide
    // Prisma keep compiling (falls back to a local instance over the same Prisma — fresh reads).
    @Optional() private readonly tenantSettings?: TenantSettingsService,
    // @Global StorageModule provides it in the app. A confirmed apply REQUIRES it (keeps the file); @Optional only
    // so unit-test modules that never confirm keep compiling.
    @Optional() private readonly storage?: StorageService,
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
    const { code, label, unit, isPrimary, hasNameOverride, nameOverrideLabel, order, rollup, enabled, achievementOnly } =
      dto;
    // APPLIES-TO scope (plan §4; E1 generalised). Each facet: omitted = unchanged (create → []).
    // `outletTypes` wins over the legacy single `outletType` (null/'' = all types). An UPDATE whose
    // resulting scope equals the STORED scope is a no-op and is NOT re-validated (so relabelling never
    // fails because an outlet type was disabled / a program renamed after the KPI was scoped); on a
    // change only the CHANGED facets are validated. The legacy column is dual-written.
    await this.assertNoLabelCollision(user.clientId, dto);
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
            achievementOnly: achievementOnly ?? false,
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
            ...(achievementOnly !== undefined ? { achievementOnly } : {}),
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
   * Owner 2026-11-26: a KPI's per-outlet NAME column header (nameOverrideLabel) must not equal ANY KPI label of the
   * tenant (case / space insensitive) — otherwise the template shows the same header twice and only column ORDER says
   * which is the target (Bajaj prod: "Focus Brand 1" twice). Checked when this save leaves the KPI with a name column;
   * the reverse (a label equal to another KPI's name header) is refused too. Nothing is saved on a refusal.
   */
  private async assertNoLabelCollision(clientId: string, dto: UpsertKpiDefDto): Promise<void> {
    const all = ((await this.prisma.kpiDef.findMany({
      where: { clientId },
      select: { code: true, label: true, hasNameOverride: true, nameOverrideLabel: true },
    })) ?? []) as Array<{ code: string; label: string; hasNameOverride: boolean; nameOverrideLabel: string | null }>;
    const stored = all.find((k) => k.code === dto.code);
    const others = all.filter((k) => k.code !== dto.code);
    const label = dto.label ?? stored?.label ?? '';
    const hasName = dto.hasNameOverride ?? stored?.hasNameOverride ?? false;
    const nameLabel = dto.nameOverrideLabel !== undefined ? dto.nameOverrideLabel : (stored?.nameOverrideLabel ?? null);
    if (hasName && nameLabel && nameLabel.trim() !== '') {
      const clash = labelKey(nameLabel) === labelKey(label)
        ? { label, code: dto.code }
        : others.find((k) => labelKey(k.label) === labelKey(nameLabel));
      if (clash) {
        throw new BadRequestException(
          `The name column label "${nameLabel.trim()}" is the same as the label of KPI ${clash.code === dto.code ? 'itself' : `"${clash.code}"`} ` +
            `("${clash.label.trim()}"), so the target template would show that header twice. Use a different name column ` +
            `label, e.g. "${label.trim()} Name". Nothing was saved.`,
        );
      }
    }
    const nameOf = others.find((k) => k.hasNameOverride && k.nameOverrideLabel && labelKey(k.nameOverrideLabel) === labelKey(label));
    if (nameOf) {
      throw new BadRequestException(
        `The label "${label.trim()}" is already the name column label of KPI "${nameOf.code}", so the target template ` +
          'would show that header twice. Use a different label, or change that KPI\'s name column label first. Nothing was saved.',
      );
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
  // OWNER DECISION 2026-11-25 — APPROVED FOR ALL CLIENTS incl. Deoleo (scope decided ONLY in confirmRequired below):
  // an upload is PREVIEWED first and applied only on "Confirm & apply".
  //   1. POST ?preview=1 → previewTargetUpload: parse + validate + classify, NOTHING written. Returns a SERVER-SIGNED
  //      previewToken — HMAC-SHA256 keyed by the API's existing JWT_SECRET (no new env var), bound to tenant + user +
  //      sha256(file bytes) + expiry (PREVIEW_TTL_MS) — and, per not-applied category, its count + a fingerprint of the
  //      exact items + a few sample keys.
  //   2. POST ?confirmToken=…&ack=CATEGORY:count:fingerprint,… with the SAME file → uploadTargets. REFUSED (and audited
  //      as TARGET_UPLOAD_REFUSED with the reason) on: no preview, an invalid / other user's token, an expired preview, a
  //      different file, file storage unavailable, a preview already applied, a missing acknowledgement (400), or an
  //      acknowledgement whose count / items no longer match what the server recomputes now (412 → re-preview).
  //   3. Apply: a PENDING batch row (server-generated id) → the file is kept → ONE transaction writes every target, flips
  //      the batch to APPLIED and writes the TARGET_UPLOAD audit row with the counts ACTUALLY written. Any failure rolls
  //      the whole write back → batch FAILED + a FAILED audit row (nothing written) → the same preview can be retried
  //      (a fresh batch each attempt). "Already applied" is only ever said of a preview whose apply really committed.
  // Both preview and apply share prepareTargetUpload — the parsing / validation / past-month lock rules exist ONCE.

  /**
   * THE scope decision of "preview → confirm is required" (owner 2026-11-25: ALL tenants, incl. Deoleo). To limit it to
   * some tenants, change this ONE line (e.g. `return ['<clientId>', …].includes(clientId)`); a tenant outside the scope
   * then applies an upload directly (same validation, same all-or-nothing write, audited as 'target-upload-direct').
   */
  static confirmRequired(_clientId: string): boolean {
    return true;
  }

  /** How long a preview can be confirmed (then: pick the file again). */
  static readonly PREVIEW_TTL_MS = 30 * 60 * 1000;
  /** The single apply transaction's ceiling (thousands of outlets × months write in one go). */
  private static readonly APPLY_TX_TIMEOUT_MS = 5 * 60 * 1000;
  /** A PENDING batch older than this did not finish (its transaction was rolled back — nothing from it was saved). */
  private static readonly PENDING_STALE_MS = 15 * 60 * 1000;
  /** previewToken: "<sha256 hex of the file>.<32-hex nonce>.<expiry epoch ms>.<HMAC-SHA256 hex>". */
  private static readonly TOKEN_RE = /^([a-f0-9]{64})\.([a-f0-9]{32})\.(\d{13})\.([a-f0-9]{64})$/;
  /** How many overwritten outlet-months are read back to find "old → new" examples (cheap, bounded). */
  private static readonly OVERWRITE_SAMPLE = 50;
  private static readonly OVERWRITE_EXAMPLES_MAX = 5;
  /** Sample keys shown per not-applied category (the full set is bound by the fingerprint). */
  private static readonly NOT_APPLIED_SAMPLE = 5;

  private static sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  private static tokenSig(clientId: string, userId: string, fileSha: string, nonce: string, exp: string): string {
    const secret = process.env.JWT_SECRET; // the app refuses to boot without it (jwt.strategy)
    if (!secret) throw new Error('JWT_SECRET is not set — cannot sign the target-upload preview.');
    return createHmac('sha256', secret)
      .update(`target-upload-confirm:v1\n${JSON.stringify([clientId, userId, fileSha, nonce, exp])}`)
      .digest('hex');
  }

  private static issuePreviewToken(user: JwtPayload, fileSha: string): { token: string; expiresAt: string } {
    const nonce = randomBytes(16).toString('hex');
    const exp = String(Date.now() + TargetsService.PREVIEW_TTL_MS);
    const sig = TargetsService.tokenSig(user.clientId, user.sub, fileSha, nonce, exp);
    return { token: `${fileSha}.${nonce}.${exp}.${sig}`, expiresAt: new Date(Number(exp)).toISOString() };
  }

  /** Verify a confirm token against THIS caller (tenant + user) and THIS file. */
  private static checkPreviewToken(
    user: JwtPayload,
    token: string,
    fileSha: string,
  ): { ok: true; nonce: string } | { ok: false; reason: 'MALFORMED_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED' | 'DIFFERENT_FILE'; nonce?: string } {
    const m = typeof token === 'string' ? TargetsService.TOKEN_RE.exec(token) : null;
    if (!m) return { ok: false, reason: 'MALFORMED_TOKEN' };
    const [, tokSha, nonce, exp, sig] = m;
    const expected = Buffer.from(TargetsService.tokenSig(user.clientId, user.sub, tokSha, nonce, exp), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return { ok: false, reason: 'INVALID_TOKEN' };
    if (Number(exp) < Date.now()) return { ok: false, reason: 'EXPIRED', nonce };
    if (tokSha !== fileSha) return { ok: false, reason: 'DIFFERENT_FILE', nonce };
    return { ok: true, nonce };
  }

  /** `ack` query param → acknowledgements: "CATEGORY:count:fingerprint" comma-separated (anything else never matches). */
  static parseAckParam(ack: unknown): TargetUploadAck[] {
    return (typeof ack === 'string' ? ack.slice(0, 2000) : '')
      .split(',')
      .filter(Boolean)
      .slice(0, 20) // 5 categories exist; anything beyond is noise (it never matches)
      .map((part) => {
        const [category, count, fingerprint] = part.split(':');
        return { category, count: count === undefined || count === '' ? NaN : Number(count), fingerprint: fingerprint ?? '' };
      });
  }

  /**
   * Record a REFUSED apply attempt (owner rule: nothing refused is silent — it is shown AND recorded), then throw the
   * refusal. A failure to write the record is logged; it never replaces the refusal the admin sees.
   */
  private async refuseUpload(
    user: JwtPayload,
    reason: TargetUploadRefusal,
    error: HttpException,
    details: Record<string, unknown> = {},
  ): Promise<never> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'REJECT',
          entityType: TARGET_UPLOAD_REFUSED_AUDIT_ENTITY,
          entityId: typeof details.tokenNonce === 'string' ? details.tokenNonce : 'no-preview',
          actorId: user.sub,
          metadata: {
            clientId: user.clientId,
            change: 'target-upload-refused',
            reason,
            status: error.getStatus(),
            message: error.message,
            ...details,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.logger.error(`Could not record the refused target upload (${reason}): ${(e as Error)?.message ?? e}`);
    }
    throw error;
  }

  /** The APPLIED batch of a preview token (its audit row says APPLIED), or null — the double-apply guard. */
  private async appliedBatchForToken(
    db: Pick<Prisma.TransactionClient, 'auditLog'>,
    clientId: string,
    tokenNonce: string,
  ): Promise<{ entityId: string; createdAt: Date } | null> {
    const row = await db.auditLog.findFirst({
      where: {
        entityType: TARGET_UPLOAD_AUDIT_ENTITY,
        AND: [
          { metadata: { path: ['tokenNonce'], equals: tokenNonce } },
          { metadata: { path: ['status'], equals: 'APPLIED' } },
          { metadata: { path: ['clientId'], equals: clientId } },
        ],
      },
      select: { entityId: true, createdAt: true },
    });
    return row ?? null;
  }

  private static alreadyAppliedMessage(prior: { entityId: string; createdAt: Date }): string {
    const when = prior.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    return `This preview was already applied on ${when} IST (upload ${prior.entityId.slice(-8)}) — it was not applied again. ` +
      'Check the targets with Download Final Targets or in Upload history. To upload this file again, pick it again for a new preview.';
  }

  /** Max numeric focus names written out in the refusal message (the full list is in `details.items`). */
  static readonly NUMERIC_FOCUS_MESSAGE_LIMIT = 10;

  /**
   * Refuses the file (400, nothing saved) when any FOCUS product name part — the per-outlet names of a KPI whose Sales
   * Import products come from the target file (own names, or names another KPI borrows) — is only a number. The message
   * names the columns and the first few outlets; `details.items` carries EVERY one (the screen offers it as a download).
   * A tenant with no such Sales Import KPI (Deoleo) reads nothing extra unless the file has names, and is never refused.
   */
  private async refuseNumericFocusNames(
    clientId: string,
    acceptedTargets: ReturnType<typeof parseTargetUploadBuffer>['acceptedTargets'],
    kpiRows: ReadonlyArray<{ code: string; label: string; hasNameOverride: boolean; nameOverrideLabel: string | null }>,
  ): Promise<void> {
    const anyNames = Object.values(acceptedTargets).some((outlets) =>
      Object.values(outlets).some((m) => m[NAMES_KEY] && Object.keys(m[NAMES_KEY] as object).length > 0));
    if (!anyNames) return;
    const defs = await this.prisma.salesKpiDefinition.findMany({
      where: { clientId, enabled: true, productSource: 'TARGET_NAMES' },
      select: { kpiCode: true, productSource: true, focusNamesFromKpi: true, enabled: true },
    });
    const codes = new Set(
      (defs ?? [])
        .filter((d) => d.enabled !== false && d.productSource === 'TARGET_NAMES')
        .map((d) => focusNamesKpiOf({ kpiCode: d.kpiCode, focusNamesFromKpi: d.focusNamesFromKpi ?? undefined })),
    );
    const kpiOf = new Map(kpiRows.map((k) => [k.code, k]));
    const columnOf = (code: string) => {
      const k = kpiOf.get(code);
      // The header the file shows for the names (the template's nameColumnHeader; "<label> Name" when they collide).
      return (k && nameColumnHeader(k)) || `${k?.label ?? code} Name`;
    };
    const found: NumericFocusName[] = findNumericFocusNames(acceptedTargets, codes, columnOf);
    if (found.length === 0) return;
    const columns = [...new Set(found.map((f) => f.column))];
    const lim = TargetsService.NUMERIC_FOCUS_MESSAGE_LIMIT;
    const shown = found.slice(0, lim).map((f) => `${f.outletCode} (${f.month}) "${f.column}": "${f.value}" in "${f.name}"`);
    const more = found.length > lim ? `; and ${(found.length - lim).toLocaleString('en-IN')} more` : '';
    throw new BadRequestException({
      message:
        `Focus brand names must be product names, not numbers — check ${columns.length === 1 ? 'column' : 'columns'} ` +
        `${columns.map((c) => `"${c}"`).join(', ')}. ${found.length.toLocaleString('en-IN')} ` +
        `${found.length === 1 ? 'name has' : 'names have'} a number where a product should be: ${shown.join('; ')}${more}. ` +
        'Fix the target file and upload it again. Nothing was saved.',
      details: { code: 'NUMERIC_FOCUS_NAMES', total: found.length, columns, items: found },
    });
  }

  /**
   * The shared parse + validate step of a target upload (preview AND apply). Reads only; writes nothing.
   */
  private async prepareTargetUpload(user: JwtPayload, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    // ── Fetch KPIs ────────────────────────────────────────────────────────────
    const allKpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
    });

    if (allKpiRows.length === 0) {
      throw new BadRequestException(
        'No enabled KPIs found. Seed KPIs first via POST /v1/admin/kpis/seed-defaults.',
      );
    }
    // ACHIEVEMENT-ONLY KPIs (KpiDef.achievementOnly, e.g. Bajaj BSC/FB1/FB2 CASES filled by Sales Import) take no
    // targets: they are not template columns, not required in the file, and their stored values (if any) are carried
    // over untouched by every write. No such KPI (Deoleo, every tenant by default) → kpiRows = allKpiRows, unchanged.
    const achievementOnlyRows = allKpiRows.filter((k) => k.achievementOnly);
    const kpiRows = achievementOnlyRows.length > 0 ? allKpiRows.filter((k) => !k.achievementOnly) : allKpiRows;
    if (kpiRows.length === 0) {
      throw new BadRequestException(
        'Every enabled KPI is marked "achievement only" (no targets), so there are no targets to upload.',
      );
    }
    const achievementOnlyCodes = achievementOnlyRows.map((k) => k.code);

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
    const excludedKpis: KpiDefLike[] = achievementOnlyRows.map((k) => ({
      code: k.code,
      label: k.label,
      isPrimary: k.isPrimary,
      // Its "<KPI> Name" column (an older template) is read only to refuse typed names — never stored.
      hasNameOverride: k.hasNameOverride,
      nameOverrideLabel: k.nameOverrideLabel ?? null,
      order: k.order,
      enabled: k.enabled,
    }));
    const parseOpts = {
      ...(parseScope ? { scope: parseScope } : {}),
      ...(excludedKpis.length > 0 ? { excludedKpis } : {}),
    };
    let parseResult: ReturnType<typeof parseTargetUploadBuffer>;
    try {
      parseResult = Object.keys(parseOpts).length > 0
        ? parseTargetUploadBuffer(file.buffer, kpis, knownOutletCodes, parseOpts)
        : parseTargetUploadBuffer(file.buffer, kpis, knownOutletCodes);
    } catch (e) {
      throw uploadParseError(e);
    }

    // NO SILENT FAILURE: a number under an achievement-only KPI's column, or a name under its "<KPI> Name" column (an
    // older template), would be dropped — refuse the file and name exactly which columns, rather than save the rest
    // and quietly lose what was typed.
    const typed: string[] = [];
    for (const k of achievementOnlyRows) {
      const v = parseResult.summary.excludedValues?.[k.code] ?? 0;
      const n = parseResult.summary.excludedNames?.[k.code] ?? 0;
      if (v > 0) typed.push(`"${k.label}" (${v.toLocaleString('en-IN')} value${v === 1 ? '' : 's'})`);
      if (n > 0) typed.push(`"${k.nameOverrideLabel ?? `${k.label} Name`}" (${n.toLocaleString('en-IN')} name${n === 1 ? '' : 's'})`);
    }
    if (typed.length > 0) {
      throw new BadRequestException(
        `This file has entries under ${typed.join(', ')}, but ${typed.length === 1 ? 'that column belongs' : 'those columns belong'} ` +
          'to an achievement-only KPI (filled by Sales Import — targets and target names are not uploaded for it). ' +
          'Clear those columns or download the current template, then upload again. Nothing was saved.',
      );
    }

    // NO SILENT FAILURE (owner 2026-11-26): a focus product name with a NUMBER in it ("1011.2697 & ADHO500" — a ₹ figure
    // typed into the name) can never match a product; Sales Import would list it as "not found" on every outlet.
    await this.refuseNumericFocusNames(user.clientId, parseResult.acceptedTargets, kpiRows);

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

    const carryFor = (outletCode: string): string[] => {
      const scoped = parseScope ? parseScope.outOfScopeCodes(outletCode) : [];
      return achievementOnlyCodes.length > 0 ? [...scoped, ...achievementOnlyCodes.filter((c) => !scoped.includes(c))] : scoped;
    };

    // One write per (outletCode, writable month) with ≥1 non-blank value — the candidate rows apply upserts (an
    // outlet-month whose stored values would not change is classified UNCHANGED and not rewritten).
    const writes: TargetUploadWrite[] = [];
    // Accepted outlet-months with values in a LOCKED (past) month — not written ("<outlet> · <month>").
    const lockedKeys: string[] = [];
    for (const [month, outletMap] of Object.entries(parseResult.acceptedTargets)) {
      const locked = isMonthLocked(month, currentMonth); // past month — not editable
      for (const [outletCode, kpiMap] of Object.entries(outletMap)) {
        if (Object.keys(kpiMap).length === 0) continue; // safety: skip fully-blank
        if (locked) {
          lockedKeys.push(`${outletCode} · ${month}`);
          continue;
        }
        writes.push({
          month,
          outletCode,
          outletName: outletMeta.get(outletCode)?.name ?? outletCode,
          kpiMap,
          // Owner decision (audit #3): a re-upload NEVER deletes stored values of KPIs that are out of scope
          // for this outlet (their cells were ignored by the parser). Only a scope-enforced tenant has any.
          // Achievement-only codes are always carried (never in the file), after the scope codes (stable order).
          carry: carryFor(outletCode),
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
      lockedKeys,
      kpiLabels: new Map(kpiRows.map((k) => [k.code, k.label])),
    };
  }

  /**
   * NO SILENT FAILURE (owner rule 2026-11-25): every category of the file that will NOT be applied as typed — only the
   * present ones — with its count, a FINGERPRINT of exactly which items (sha256 over the sorted keys) and a few sample
   * keys. The preview shows one required "I understand…" box per entry; a confirmed apply must send back every entry's
   * category + count + fingerprint, and the server recomputes them at apply time (a mismatch → 412, re-preview).
   */
  private static notApplied(
    p: Awaited<ReturnType<TargetsService['prepareTargetUpload']>>,
    overwriteKeys: readonly string[],
  ): TargetUploadNotApplied[] {
    const rows = p.parseResult.rows;
    const rowKey = (r: { rowIndex: number; outletCode?: string }) =>
      `Row ${r.rowIndex}${r.outletCode ? ` — ${r.outletCode}` : ''}`;
    const rejected = rows.filter((r) => r.status === 'rejected_outlet' || r.status === 'rejected_kpi').map(rowKey);
    const blank = rows.filter((r) => r.status === 'skipped_blank').map(rowKey);
    const ignored = p.scopeEnforced
      ? rows.filter((r) => /Ignored value\(s\)/.test(r.remarks ?? '')).map((r) => `${rowKey(r)} (${r.remarks})`)
      : [];
    const item = (category: TargetUploadAckCategory, count: number, keys: readonly string[]): TargetUploadNotApplied => ({
      category,
      count,
      fingerprint: createHash('sha256')
        .update(`${category}\n${count}\n${[...keys].sort().join('\n')}`)
        .digest('hex')
        .slice(0, 16),
      sample: keys.slice(0, TargetsService.NOT_APPLIED_SAMPLE),
    });
    const all = [
      item('REJECTED_ROWS',  p.parseResult.summary.rejected, rejected),
      item('OVERWRITE',      overwriteKeys.length, overwriteKeys),
      item('LOCKED_MONTHS',  p.lockedKeys.length, p.lockedKeys),
      item('BLANK_ROWS',     blank.length, blank),
      item('IGNORED_VALUES', p.scopeEnforced ? p.parseResult.summary.ignoredOutOfScope : 0, ignored),
    ];
    return all.filter((c) => c.count > 0);
  }

  /**
   * Compare the acknowledgements sent with the not-applied categories recomputed NOW. Exact match required:
   * a category's count or items changed, or one appeared / disappeared → 412 (the screen re-previews and re-shows the
   * boxes); a present category simply not ticked → 400 naming it. null = all acknowledged.
   */
  private static checkAcks(
    current: readonly TargetUploadNotApplied[],
    acks: readonly TargetUploadAck[],
  ): { reason: 'ACK_MISSING' | 'ACK_CHANGED'; error: HttpException } | null {
    const ackBy = new Map(acks.map((a) => [a.category, a]));
    const curBy = new Map(current.map((c) => [c.category as string, c]));
    const label = (c: string) => TARGET_UPLOAD_ACK_CATEGORIES[c as TargetUploadAckCategory] ?? c;
    const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-IN') : '?');
    const changed: string[] = [];
    for (const c of current) {
      const a = ackBy.get(c.category);
      if (a && (a.count !== c.count || a.fingerprint !== c.fingerprint)) {
        changed.push(
          a.count === c.count
            ? `${label(c.category)}: still ${fmt(c.count)}, but not the same ones you confirmed`
            : `${label(c.category)}: now ${fmt(c.count)} (you confirmed ${fmt(a.count)})`,
        );
      }
    }
    for (const a of acks) {
      if (!curBy.has(a.category)) changed.push(`${label(a.category)}: now none (you confirmed ${fmt(a.count)})`);
    }
    if (changed.length > 0) {
      return {
        reason: 'ACK_CHANGED',
        error: new PreconditionFailedException(
          `What will not be applied has changed since the preview — ${changed.join('; ')}. Nothing was saved. ` +
            'Check the up-to-date preview and confirm again.',
        ),
      };
    }
    const missing = current.filter((c) => !ackBy.has(c.category));
    if (missing.length > 0) {
      return {
        reason: 'ACK_MISSING',
        error: new BadRequestException(
          `Please confirm what will not be applied before applying: ${missing
            .map((c) => `${c.count.toLocaleString('en-IN')} ${TARGET_UPLOAD_ACK_CATEGORIES[c.category]} (${c.category})`)
            .join('; ')}. Nothing was saved.`,
        ),
      };
    }
    return null;
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
      // Owner 2026-11-26: name columns read from the OLD duplicate-header layout — said in words (absent otherwise).
      ...(TargetsService.legacyLayoutNotes(p).length > 0 ? { layoutNotes: TargetsService.legacyLayoutNotes(p) } : {}),
    };
  }

  /** "Read column F as Focus Brand 1 names (old template layout)." — one line per KPI, every month block's column. */
  static legacyLayoutNotes(p: { parseResult: { summary: { legacyNameColumns?: Array<{ kpiCode: string; label: string; column: string }> } } }): string[] {
    const byKpi = new Map<string, { label: string; columns: string[] }>();
    for (const c of p.parseResult.summary.legacyNameColumns ?? []) {
      const e = byKpi.get(c.kpiCode) ?? { label: c.label, columns: [] };
      if (!e.columns.includes(c.column)) e.columns.push(c.column);
      byKpi.set(c.kpiCode, e);
    }
    return [...byKpi.values()].map((e) =>
      `Read column${e.columns.length === 1 ? '' : 's'} ${e.columns.join(', ')} as ${e.label} names (old template layout).`);
  }

  /**
   * NEW vs OVERWRITTEN vs UNCHANGED split of the upload's writes, against the targets stored NOW (read through `db` — the
   * apply reads it INSIDE its transaction). One read per month (outlet codes + stored values).
   *  - NEW        — no stored row for the outlet-month;
   *  - OVERWRITE  — a stored row where at least one value / custom name actually changes (`targetChangesForWrite`);
   *  - UNCHANGED  — a stored row the write would leave exactly as it is: NOT counted as an overwrite, needs no
   *                 acknowledgement, and is NOT rewritten (`toWrite` excludes it), so it truly has no effect.
   * `overwriteKeys` lists every overwritten "<outlet> · <month>" (the OVERWRITE fingerprint is over exactly these);
   * `sample` keeps the first OVERWRITE_SAMPLE overwritten writes for the example read.
   */
  private async classifyTargetWrites(
    db: Pick<Prisma.TransactionClient, 'outletTarget'>,
    clientId: string,
    writes: readonly TargetUploadWrite[],
  ) {
    const byMonth = new Map<string, TargetUploadWrite[]>();
    for (const w of writes) {
      const list = byMonth.get(w.month) ?? [];
      list.push(w);
      byMonth.set(w.month, list);
    }
    const perMonth: Array<{ month: string; newCount: number; overwriteCount: number; unchangedCount: number }> = [];
    const sample: TargetUploadWrite[] = [];
    const overwriteKeys: string[] = [];
    const unchangedKeys: string[] = [];
    /** The writes apply performs: NEW + OVERWRITE (an UNCHANGED outlet-month is left alone). */
    const toWrite: TargetUploadWrite[] = [];
    /**
     * UNCHANGED outlet-months whose stored outletName differs from the file's: apply refreshes ONLY that name (no
     * targetValues / batchId / updatedAt change, no history row, no notification, not an overwrite).
     */
    const nameOnly: TargetUploadWrite[] = [];
    /** `${month}|${outletCode}` → stored targetValues. */
    const storedValues = new Map<string, Record<string, unknown>>();
    let newCount = 0;
    let overwriteCount = 0;
    let unchangedCount = 0;
    for (const month of [...byMonth.keys()].sort()) {
      const stored = await db.outletTarget.findMany({
        where: { clientId, month },
        select: { outletCode: true, outletName: true, targetValues: true },
      });
      const storedNames = new Map<string, unknown>();
      for (const r of (stored ?? []) as Array<{ outletCode: string; outletName?: unknown; targetValues?: unknown }>) {
        storedValues.set(`${month}|${r.outletCode}`, (r.targetValues ?? {}) as Record<string, unknown>);
        storedNames.set(r.outletCode, r.outletName);
      }
      let n = 0;
      let o = 0;
      let u = 0;
      for (const w of byMonth.get(month)!) {
        const old = storedValues.get(`${month}|${w.outletCode}`);
        if (old === undefined) {
          n++;
          toWrite.push(w);
        } else if (targetChangesForWrite(w, old).length > 0) {
          o++;
          toWrite.push(w);
          overwriteKeys.push(`${w.outletCode} · ${month}`);
          if (sample.length < TargetsService.OVERWRITE_SAMPLE) sample.push(w);
        } else {
          u++;
          unchangedKeys.push(`${w.outletCode} · ${month}`);
          const storedName = storedNames.get(w.outletCode);
          if (typeof storedName === 'string' && storedName !== w.outletName) nameOnly.push(w);
        }
      }
      perMonth.push({ month, newCount: n, overwriteCount: o, unchangedCount: u });
      newCount += n;
      overwriteCount += o;
      unchangedCount += u;
    }
    return {
      newCount, overwriteCount, unchangedCount, perMonth, sample, overwriteKeys, unchangedKeys, toWrite, nameOnly, storedValues,
    };
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
   * notifications). The returned `previewToken` (server-signed, expires at `previewExpiresAt`) is what
   * "Confirm & apply" sends back with the same file.
   */
  async previewTargetUpload(user: JwtPayload, file: Express.Multer.File) {
    const p = await this.prepareTargetUpload(user, file);
    const cls = await this.classifyTargetWrites(this.prisma, user.clientId, p.writes);
    const overwriteExamples = await this.overwriteExamples(user.clientId, cls.sample, p.kpiLabels);
    const focusCheck = await targetUploadFocusCheck(
      this.prisma,
      user.clientId,
      p.parseResult.acceptedTargets,
      p.writableMonths,
    );
    const { token, expiresAt } = TargetsService.issuePreviewToken(user, TargetsService.sha256(file.buffer));
    return {
      preview: true as const,
      previewToken: token,
      previewExpiresAt: expiresAt,
      ...TargetsService.uploadSummary(p),
      // What apply WOULD write if confirmed now: NEW + OVERWRITE outlet-months (UNCHANGED ones are not rewritten).
      willSaveCount:  cls.toWrite.length,
      newCount:       cls.newCount,
      overwriteCount: cls.overwriteCount,
      // Outlet-months already holding exactly these values — shown as "unchanged (no effect)", no acknowledgement.
      unchangedCount: cls.unchangedCount,
      unchangedSample: cls.unchangedKeys.slice(0, TargetsService.NOT_APPLIED_SAMPLE),
      // Of unchangedCount: the ones whose stored outlet NAME will be refreshed from the file (values untouched).
      ...(cls.nameOnly.length > 0 ? { outletNameUpdatedCount: cls.nameOnly.length } : {}),
      perMonth:       cls.perMonth,
      overwriteExamples,
      // How many overwritten outlet-months were compared to find the examples (the examples are a sample).
      overwriteExamplesSampled: cls.sample.length,
      // Every category NOT applied as typed — each must be acknowledged on confirm (absent categories omitted).
      notApplied: TargetsService.notApplied(p, cls.overwriteKeys),
      ...targetUploadRowsEcho(p.parseResult.rows),
      focusCheck,
    };
  }

  /**
   * APPLY a previewed target upload (the only way targets are written from a file for a confirmRequired tenant).
   *
   * Blank cell → omitted key (not stored as 0). Numbers are stored verbatim. Upsert on (clientId, outletCode, month).
   * `opts.confirmToken` (from previewTargetUpload) must be this caller's, unexpired, for these exact bytes, and not
   * already applied. `opts.acknowledged` must match every not-applied category recomputed now (count + fingerprint).
   * Every refusal is audited (TARGET_UPLOAD_REFUSED) and writes nothing.
   */
  async uploadTargets(
    user: JwtPayload,
    file: Express.Multer.File,
    opts?: { confirmToken?: string; acknowledged?: readonly TargetUploadAck[] },
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const fileSha256 = TargetsService.sha256(file.buffer);
    const fileFacts = { fileName: file.originalname ?? null, fileSize: file.buffer.length, fileSha256 };

    let tokenNonce: string | undefined;
    if (opts?.confirmToken === undefined) {
      if (TargetsService.confirmRequired(user.clientId)) {
        return this.refuseUpload(
          user,
          'NO_PREVIEW',
          new BadRequestException(
            'Preview the file first: pick it on the Targets upload page, read the preview, then press Confirm & apply. Nothing was saved.',
          ),
          fileFacts,
        );
      }
    } else {
      const t = TargetsService.checkPreviewToken(user, opts.confirmToken, fileSha256);
      if (!t.ok) {
        const details = { ...fileFacts, ...(t.nonce ? { tokenNonce: t.nonce } : {}) };
        if (t.reason === 'EXPIRED') {
          return this.refuseUpload(user, 'EXPIRED', new GoneException(
            `This preview has expired (a preview can be confirmed for ${TargetsService.PREVIEW_TTL_MS / 60000} minutes). Nothing was saved. Check the file again to get a fresh preview.`,
          ), details);
        }
        if (t.reason === 'DIFFERENT_FILE') {
          return this.refuseUpload(user, 'DIFFERENT_FILE', new ConflictException(
            'This file is not the one you previewed (it was changed or replaced). Nothing was saved. Pick the file again to preview it.',
          ), details);
        }
        if (t.reason === 'MALFORMED_TOKEN') {
          return this.refuseUpload(user, 'MALFORMED_TOKEN', new BadRequestException(
            'This confirmation is not in the expected format (it was cut short or edited). Nothing was saved. Pick the file again to preview it.',
          ), { ...details, tokenLength: typeof opts.confirmToken === 'string' ? opts.confirmToken.length : null });
        }
        return this.refuseUpload(user, 'INVALID_TOKEN', new BadRequestException(
          'This confirmation is not valid for your account (it was not issued to you, or it was altered). Nothing was saved. Pick the file again to preview it.',
        ), details);
      }
      tokenNonce = t.nonce;
      if (!this.storage) {
        return this.refuseUpload(user, 'STORAGE_UNAVAILABLE', new ServiceUnavailableException(
          'File storage is not available, so the upload cannot be kept on record. Nothing was saved. Try again later.',
        ), { ...fileFacts, tokenNonce });
      }
      const prior = await this.appliedBatchForToken(this.prisma, user.clientId, tokenNonce);
      if (prior) {
        return this.refuseUpload(user, 'ALREADY_APPLIED', new ConflictException(TargetsService.alreadyAppliedMessage(prior)), {
          ...fileFacts,
          tokenNonce,
          appliedBatchId: prior.entityId,
        });
      }
    }

    const p = await this.prepareTargetUpload(user, file);
    // Classified against the stored targets now (re-done inside the apply transaction for the final split).
    const cls = await this.classifyTargetWrites(this.prisma, user.clientId, p.writes);
    const notApplied = TargetsService.notApplied(p, cls.overwriteKeys);
    const acknowledged = [...(opts?.acknowledged ?? [])];

    // NO SILENT FAILURE: a confirmed apply must acknowledge exactly what will not be applied as typed, NOW.
    if (tokenNonce) {
      const bad = TargetsService.checkAcks(notApplied, acknowledged);
      if (bad) {
        return this.refuseUpload(user, bad.reason, bad.error, {
          ...fileFacts,
          tokenNonce,
          acknowledged,
          notApplied: notApplied.map(({ category, count, fingerprint }) => ({ category, count, fingerprint })),
        });
      }
    }

    return this.applyTargetUpload(user, file, p, notApplied, acknowledged, tokenNonce, fileFacts);
  }

  /**
   * The write: PENDING batch → keep the file → ONE transaction (tenant upload lock, double-apply re-check, final
   * new/overwrite split, every target, batch APPLIED, TARGET_UPLOAD audit with the counts written). On any failure the
   * transaction rolls back (nothing written) → batch FAILED + FAILED audit row → a truthful, retryable error.
   */
  private async applyTargetUpload(
    user: JwtPayload,
    file: Express.Multer.File,
    p: Awaited<ReturnType<TargetsService['prepareTargetUpload']>>,
    notApplied: TargetUploadNotApplied[],
    acknowledged: TargetUploadAck[],
    tokenNonce: string | undefined,
    fileFacts: { fileName: string | null; fileSize: number; fileSha256: string },
  ) {
    const batch = await this.prisma.targetUploadBatch.create({
      data: {
        clientId:      user.clientId,
        uploadedById:  user.sub,
        month:         p.batchMonth,
        totalRows:     p.parseResult.summary.total,
        acceptedCount: p.parseResult.summary.accepted,
        rejectedCount: p.parseResult.summary.rejected,
        status:        'PENDING',
      },
    });

    const baseMeta: Record<string, unknown> = {
      clientId:            user.clientId,
      change:              tokenNonce ? 'target-upload-confirm' : 'target-upload-direct',
      tokenNonce:          tokenNonce ?? null,
      months:              p.writableMonths,
      skippedLockedMonths: p.lockedMonths,
      ...fileFacts,
      fileKey:             null,
      totalRows:           p.parseResult.summary.total,
      acceptedCount:       p.parseResult.summary.accepted,
      rejectedCount:       p.parseResult.summary.rejected,
      acknowledged,
      notApplied,
    };

    // Keep the confirmed file FIRST (private bucket, tenant + batch scoped): if it cannot be stored nothing is written.
    let fileKey: string | undefined;
    if (tokenNonce) {
      fileKey = this.storage!.generateKey(
        `${TARGET_UPLOAD_FILE_PREFIX}${user.clientId}/${batch.id}`,
        file.originalname || 'targets.xlsx',
      );
      try {
        await this.storage!.uploadFile(
          file.buffer,
          fileKey,
          file.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      } catch (e) {
        await this.markFailedIfPending(user, batch.id, baseMeta, 'STORAGE_FAILED', e);
        throw new ServiceUnavailableException(
          'The file could not be stored, so nothing was saved. Press Confirm & apply again to retry.',
        );
      }
      baseMeta.fileKey = fileKey;
    }

    const overwriteAcked = notApplied.find((c) => c.category === 'OVERWRITE');
    let final: {
      newCount: number;
      overwriteCount: number;
      unchangedCount?: number;
      perMonth: Array<{ month: string; newCount: number; overwriteCount: number; unchangedCount?: number }>;
      historyRowCount?: number;
      writtenOutletCodes?: string[];
      outletNameUpdatedCount?: number;
    };
    try {
      final = await this.prisma.$transaction(
        async (tx) => {
          // Serialise target uploads of a tenant: the double-apply re-check and the new/overwrite split below are exact.
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`target-upload:${user.clientId}`}, 0))`);
          if (tokenNonce) {
            const prior = await this.appliedBatchForToken(tx, user.clientId, tokenNonce);
            if (prior) throw new TargetUploadAbort('ALREADY_APPLIED', new ConflictException(TargetsService.alreadyAppliedMessage(prior)));
          }
          // The split AND the stored values (for the change history) come from ONE read per month, under the lock.
          const cls = await this.classifyTargetWrites(tx, user.clientId, p.writes);
          if (tokenNonce) {
            const nowOverwrite = TargetsService.notApplied(p, cls.overwriteKeys).find((c) => c.category === 'OVERWRITE');
            if ((nowOverwrite?.fingerprint ?? null) !== (overwriteAcked?.fingerprint ?? null)) {
              throw new TargetUploadAbort('ACK_CHANGED', new PreconditionFailedException(
                `Existing targets changed while applying (now ${cls.overwriteCount.toLocaleString('en-IN')} would be replaced, you confirmed ` +
                  `${(overwriteAcked?.count ?? 0).toLocaleString('en-IN')}). Nothing was saved. Check the up-to-date preview and confirm again.`,
              ));
            }
          }
          // Multi-row statements (WRITE_CHUNK rows each) — ≤ ~80 statements for 6,500 outlets × 12 months. Only NEW +
          // OVERWRITE outlet-months (decided under the lock): an UNCHANGED one keeps its row, batchId and updatedAt.
          for (const stmt of this.targetWriteStatements(user.clientId, batch.id, cls.toWrite)) await tx.$executeRaw(stmt);
          // UNCHANGED values but a different outlet name in the file: refresh ONLY "outletName" (raw SQL, so updatedAt —
          // Sales Import's "targets changed" signal — batchId and targetValues stay as they are; no history, no notify).
          for (let i = 0; i < cls.nameOnly.length; i += TargetsService.WRITE_CHUNK) {
            const chunk = cls.nameOnly.slice(i, i + TargetsService.WRITE_CHUNK);
            await tx.$executeRaw(Prisma.sql`
              UPDATE "outlet_targets" AS t SET "outletName" = v.name
              FROM unnest(${chunk.map((w) => w.outletCode)}::text[], ${chunk.map((w) => w.month)}::text[],
                          ${chunk.map((w) => w.outletName)}::text[]) AS v(code, month, name)
              WHERE t."clientId" = ${user.clientId} AND t."outletCode" = v.code AND t."month" = v.month`);
          }
          const savedCount = cls.toWrite.length;
          // TARGET CHANGE HISTORY (owner 2026-11-25): one row per value that ACTUALLY changed, in this same transaction.
          const changes = targetChangesFor(cls.toWrite, cls.storedValues);
          for (const stmt of this.historyStatements(user.clientId, batch.id, user.sub, changes)) await tx.$executeRaw(stmt);
          await tx.targetUploadBatch.update({ where: { id: batch.id }, data: { status: 'APPLIED' } });
          await tx.auditLog.create({
            data: {
              action: 'CREATE',
              entityType: TARGET_UPLOAD_AUDIT_ENTITY,
              entityId: batch.id,
              actorId: user.sub,
              metadata: {
                ...baseMeta,
                status:         'APPLIED',
                savedCount,
                newCount:       cls.newCount,
                overwriteCount: cls.overwriteCount,
                unchangedCount: cls.unchangedCount,
                ...(cls.nameOnly.length > 0 ? { outletNameUpdatedCount: cls.nameOnly.length } : {}),
                perMonth:       cls.perMonth,
                historyRowCount: changes.length,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          return {
            newCount: cls.newCount, overwriteCount: cls.overwriteCount, unchangedCount: cls.unchangedCount,
            perMonth: cls.perMonth, historyRowCount: changes.length,
            writtenOutletCodes: cls.toWrite.map((w) => w.outletCode),
            outletNameUpdatedCount: cls.nameOnly.length,
          };
        },
        { maxWait: 10_000, timeout: TargetsService.APPLY_TX_TIMEOUT_MS },
      );
    } catch (e) {
      // A refusal decided INSIDE the transaction (rolled back, nothing written): not a failed save — it is recorded as a
      // refusal, and the attempt's PENDING batch + kept file are removed so the history never shows a "failed" upload.
      if (e instanceof TargetUploadAbort) {
        await this.discardRefusedAttempt(batch.id, fileKey);
        return this.refuseUpload(user, e.reason, e.error, {
          ...fileFacts,
          tokenNonce,
          discardedBatchId: batch.id,
          decidedInsideTransaction: true,
        });
      }
      // The commit may have landed with its reply lost — the DB is the truth; an unreadable DB is UNKNOWN, never "not saved".
      const state = await this.applyOutcome(batch.id);
      if (state.kind === 'APPLIED') {
        final = state;
      } else if (state.kind === 'PENDING' && (await this.markFailedIfPending(user, batch.id, baseMeta, 'WRITE_FAILED', e))) {
        throw new InternalServerErrorException(
          'Saving the targets failed, so NOTHING from this file was saved (the whole file is saved together or not at all). ' +
            `Press Confirm & apply again to retry. If it keeps failing, contact Gifsy support (reference ${batch.id.slice(-8)}).`,
        );
      } else {
        await this.recordUnconfirmedApply(user, batch.id, baseMeta, e);
        throw new ServiceUnavailableException(
          "We couldn't confirm whether the targets were saved. Refresh the page and check Upload history (or Download " +
            `Final Targets) before retrying — retrying is safe: an upload is never applied twice (reference ${batch.id.slice(-8)}).`,
        );
      }
    }

    // Notify the assigned rep (XSR) + their manager (SO) for every outlet that got a target. Tenant-scoped; the targets
    // are already saved, so a notification failure never turns this into an error — it is reported on the response.
    let notificationWarning: string | undefined;
    try {
      // Only outlets whose targets were actually written (an UNCHANGED outlet-month got no new target). The rare
      // lost-reply recovery path does not know the split → every outlet in the file, as before.
      const notified = final.writtenOutletCodes ?? p.writes.map((w) => w.outletCode);
      if (notified.length > 0) await this.salesNotifications.targetsUploaded(user.clientId, [...new Set(notified)]);
    } catch (e) {
      this.logger.error(`targetsUploaded notification failed for batch ${batch.id}: ${(e as Error)?.message ?? e}`);
      notificationWarning = 'The targets were saved, but the sales team could not be notified about them.';
    }

    // FOCUS-FROM-TARGETS §7: early, NON-blocking check of the focus product names this upload wrote (never throws;
    // `checked: false` for a tenant without a "from the target file" Sales Import KPI). The month preview re-checks.
    const focusCheck = await targetUploadFocusCheck(
      this.prisma,
      user.clientId,
      p.parseResult.acceptedTargets,
      p.writableMonths,
    );

    return {
      batchId:       batch.id,
      status:        'APPLIED' as const,
      ...TargetsService.uploadSummary(p),
      // The GROUND TRUTH of what was persisted (in ONE transaction): one OutletTarget row per NEW or CHANGED (outlet,
      // writable-month). `acceptedCount` can be higher (LOCKED past-month rows, UNCHANGED outlet-months).
      savedCount:     final.newCount + final.overwriteCount,
      // Of savedCount: outlet-months created vs existing ones replaced (split read inside the write transaction).
      newCount:       final.newCount,
      overwriteCount: final.overwriteCount,
      // Already held exactly these values — not rewritten (no effect).
      unchangedCount: final.unchangedCount ?? 0,
      // Of unchangedCount: outlet-months whose stored outlet NAME was refreshed from the file (values untouched).
      ...((final.outletNameUpdatedCount ?? 0) > 0 ? { outletNameUpdatedCount: final.outletNameUpdatedCount } : {}),
      perMonth:       final.perMonth,
      // What was NOT applied as typed (the done screen lists it), + what the admin acknowledged (confirm path).
      notApplied,
      ...(tokenNonce ? { acknowledged } : {}),
      ...(notificationWarning ? { notificationWarning } : {}),
      // Memory-safety (2026-11-13): only the rejected rows + the ignored-value warning rows come back
      // (each capped at 500, slimmed to row/outlet/status/remarks) — not every parsed row with its values.
      ...targetUploadRowsEcho(p.parseResult.rows),
      focusCheck,
    };
  }

  /**
   * After a failed transaction, what does the DB say? APPLIED (its commit landed, reply lost — with the written split),
   * PENDING (rolled back: nothing written), or UNKNOWN (the re-read itself failed — we must not claim either).
   */
  private async applyOutcome(
    batchId: string,
  ): Promise<
    | { kind: 'APPLIED'; newCount: number; overwriteCount: number; unchangedCount: number; perMonth: Array<{ month: string; newCount: number; overwriteCount: number }> }
    | { kind: 'PENDING' }
    | { kind: 'UNKNOWN' }
  > {
    try {
      const b = await this.prisma.targetUploadBatch.findFirst({ where: { id: batchId }, select: { status: true } });
      if (!b) return { kind: 'UNKNOWN' };
      if (b.status === 'PENDING') return { kind: 'PENDING' };
      if (b.status !== 'APPLIED') return { kind: 'UNKNOWN' };
      const a = await this.prisma.auditLog.findFirst({
        where: { entityType: TARGET_UPLOAD_AUDIT_ENTITY, entityId: batchId },
        select: { metadata: true },
      });
      const m = (a?.metadata ?? {}) as Record<string, unknown>;
      return {
        kind: 'APPLIED',
        newCount: Number(m.newCount ?? 0),
        overwriteCount: Number(m.overwriteCount ?? 0),
        unchangedCount: Number(m.unchangedCount ?? 0),
        perMonth: (m.perMonth as Array<{ month: string; newCount: number; overwriteCount: number }>) ?? [],
      };
    } catch {
      return { kind: 'UNKNOWN' };
    }
  }

  /**
   * Batch → FAILED ONLY while it is still PENDING (a conditional update — never over an APPLIED commit that landed after
   * our read), + a FAILED TARGET_UPLOAD audit row (nothing written). true = marked; false = not PENDING any more / the
   * update itself failed (the caller then reports UNKNOWN).
   */
  private async markFailedIfPending(
    user: JwtPayload,
    batchId: string,
    baseMeta: Record<string, unknown>,
    reason: string,
    cause: unknown,
  ): Promise<boolean> {
    let marked = false;
    try {
      const r = await this.prisma.targetUploadBatch.updateMany({
        where: { id: batchId, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      marked = (r?.count ?? 0) === 1;
    } catch (e) {
      this.logger.error(`Could not mark target upload ${batchId} FAILED: ${(e as Error)?.message ?? e}`);
      return false;
    }
    if (!marked) return false;
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: TARGET_UPLOAD_AUDIT_ENTITY,
          entityId: batchId,
          actorId: user.sub,
          metadata: {
            ...baseMeta,
            status:         'FAILED',
            failureReason:  reason,
            error:          TargetsService.errorText(cause),
            savedCount:     0,
            newCount:       0,
            overwriteCount: 0,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.logger.error(`Could not record the failed target upload ${batchId}: ${(e as Error)?.message ?? e}`);
    }
    return true;
  }

  /** Record (best-effort, + error log) that an apply's outcome could not be confirmed. The batch row is left as it is. */
  private async recordUnconfirmedApply(user: JwtPayload, batchId: string, baseMeta: Record<string, unknown>, cause: unknown) {
    this.logger.error(`Target upload ${batchId}: outcome UNKNOWN after a failed transaction — ${TargetsService.errorText(cause)}`);
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: TARGET_UPLOAD_UNCONFIRMED_AUDIT_ENTITY,
          entityId: batchId,
          actorId: user.sub,
          metadata: {
            ...baseMeta,
            status: 'UNKNOWN',
            error:  TargetsService.errorText(cause),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.logger.error(`Could not record the unconfirmed target upload ${batchId}: ${(e as Error)?.message ?? e}`);
    }
  }

  /** A refused-in-transaction attempt: drop its PENDING batch row (nothing references it) and its kept file. */
  private async discardRefusedAttempt(batchId: string, fileKey: string | undefined) {
    try {
      await this.prisma.targetUploadBatch.deleteMany({ where: { id: batchId, status: 'PENDING' } });
    } catch (e) {
      this.logger.error(`Could not remove the refused target upload batch ${batchId}: ${(e as Error)?.message ?? e}`);
    }
    if (fileKey && this.storage) {
      try {
        await this.storage.deleteFile(fileKey);
      } catch (e) {
        this.logger.error(`Could not remove the kept file of refused target upload ${batchId}: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  private static errorText(cause: unknown): string {
    const err = cause as { code?: unknown; message?: unknown; name?: unknown };
    return `${typeof err?.code === 'string' ? `${err.code}: ` : ''}${String(err?.message ?? err?.name ?? cause).slice(0, 300)}`;
  }

  /** Rows per multi-row INSERT … ON CONFLICT statement (≈ 7 bound params per row, far under Postgres's 65,535). */
  static readonly WRITE_CHUNK = 1000;
  /** Change-history rows per INSERT … SELECT unnest(…) statement (8 array params, whatever the row count). */
  static readonly HISTORY_CHUNK = 10_000;

  /**
   * The change-history rows as INSERT … SELECT FROM unnest(arrays) statements (HISTORY_CHUNK rows each, 8 bound
   * arrays per statement), stamped with the real write time.
   */
  private historyStatements(clientId: string, batchId: string, userId: string, changes: readonly TargetChange[]): Prisma.Sql[] {
    const out: Prisma.Sql[] = [];
    for (let i = 0; i < changes.length; i += TargetsService.HISTORY_CHUNK) {
      const part = changes.slice(i, i + TargetsService.HISTORY_CHUNK);
      const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
      out.push(Prisma.sql`
        INSERT INTO "target_change_history"
          ("id","clientId","outletCode","month","kpiCode","field","oldValue","newValue","changeType","batchId","changedById","changedAt")
        SELECT t.id, ${clientId}, t.o, t.m, t.k, t.f, t.ov::jsonb, t.nv::jsonb, t.ct::"TargetChangeType", ${batchId}, ${userId}, ${SQL_CLOCK_UTC}
        FROM unnest(
          ${part.map(() => randomUUID())}::text[], ${part.map((c) => c.outletCode)}::text[], ${part.map((c) => c.month)}::text[],
          ${part.map((c) => c.kpiCode)}::text[], ${part.map((c) => c.field)}::text[], ${part.map((c) => json(c.oldValue))}::text[],
          ${part.map((c) => json(c.newValue))}::text[], ${part.map((c) => c.changeType)}::text[]
        ) AS t(id, o, m, k, f, ov, nv, ct)`);
    }
    return out;
  }

  /**
   * The upload's writes as MULTI-ROW statements (WRITE_CHUNK rows each), run in order inside the apply transaction.
   * Rows with the same carry-over set share a statement (most tenants: one set = no carry). Each row's updatedAt is the
   * real write time — clock_timestamp(), not now() (frozen at the transaction start): Sales Import's "targets changed
   * since the last apply" reads MAX(updatedAt) of the month's rows (FOCUS-FROM-TARGETS).
   */
  private targetWriteStatements(clientId: string, batchId: string, writes: readonly TargetUploadWrite[]): Prisma.Sql[] {
    const groups = new Map<string, TargetUploadWrite[]>();
    for (const w of writes) {
      const key = JSON.stringify(w.carry); // same order for the same outlet scope (kpiRows order)
      const list = groups.get(key) ?? [];
      list.push(w);
      groups.set(key, list);
    }
    const col = Prisma.sql`"outlet_targets"."targetValues"`;
    const out: Prisma.Sql[] = [];
    for (const list of groups.values()) {
      const carry = list[0].carry;
      // Carry over the out-of-scope stored codes inside the statement (scope-enforced tenants only).
      const valuesExpr = carry.length > 0
        ? TargetsService.carryOverSql(col, Prisma.sql`EXCLUDED."targetValues"`, carry, true)
        : Prisma.sql`EXCLUDED."targetValues"`;
      for (let i = 0; i < list.length; i += TargetsService.WRITE_CHUNK) {
        const rows = list.slice(i, i + TargetsService.WRITE_CHUNK).map(
          (w) => Prisma.sql`(${randomUUID()}, ${clientId}, ${w.outletCode}, ${w.outletName}, ${w.month},
                    ${JSON.stringify(w.kpiMap)}::jsonb, ${batchId}, ${SQL_CLOCK_UTC}, ${SQL_CLOCK_UTC})`,
        );
        out.push(Prisma.sql`
          INSERT INTO "outlet_targets"
            ("id","clientId","outletCode","outletName","month","targetValues","batchId","createdAt","updatedAt")
          VALUES ${Prisma.join(rows)}
          ON CONFLICT ("clientId","outletCode","month") DO UPDATE SET
            "targetValues" = ${valuesExpr},
            "outletName"   = EXCLUDED."outletName",
            "batchId"      = EXCLUDED."batchId",
            "updatedAt"    = ${SQL_CLOCK_UTC}`);
      }
    }
    return out;
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
    } catch (e) {
      throw uploadParseError(e);
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

  /** Newest uploads shown in the Upload history (the list is for reading, not an export). */
  private static readonly HISTORY_LIMIT = 100;

  /**
   * Upload history (newest first, tenant-scoped, at most HISTORY_LIMIT): the batch rows + who uploaded (name) + the
   * confirmed-apply audit details (months, new vs overwritten, acknowledged, whether the file is kept). Batches from
   * before the confirm step — or applied directly by a script — have no audit row: `fileKept: false`.
   */
  async listBatches(user: JwtPayload, q: ListBatchesQueryDto) {
    // Keyset paging (newest first): `before` = the id of the last row of the previous page (this tenant's only).
    let cursor: { createdAt: Date; id: string } | null = null;
    if (q.before) {
      cursor = await this.prisma.targetUploadBatch.findFirst({
        where: { id: q.before, clientId: user.clientId },
        select: { createdAt: true, id: true },
      });
      if (!cursor) throw new BadRequestException('That page of the upload history is no longer available — reload the page.');
    }
    const page = await this.prisma.targetUploadBatch.findMany({
      where: {
        clientId: user.clientId,
        ...(q.month ? { month: q.month } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TargetsService.HISTORY_LIMIT + 1,
    });
    const hasMore = page.length > TargetsService.HISTORY_LIMIT;
    const batches = hasMore ? page.slice(0, TargetsService.HISTORY_LIMIT) : page;
    const envelope = (items: unknown[]) => ({
      items,
      pageSize: TargetsService.HISTORY_LIMIT,
      hasMore,
      nextCursor: hasMore ? batches[batches.length - 1].id : null,
    });
    if (batches.length === 0) return envelope([]);
    const [audits, users] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entityType: TARGET_UPLOAD_AUDIT_ENTITY, entityId: { in: batches.map((b) => b.id) } },
        select: { entityId: true, metadata: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(batches.map((b) => b.uploadedById))] } },
        select: { id: true, name: true, clientId: true },
      }),
    ]);
    // Only an audit row that belongs to THIS tenant counts (defence in depth — ids are already tenant-scoped).
    const auditBy = new Map(
      (audits ?? [])
        .map((a) => [a.entityId, (a.metadata ?? {}) as Record<string, unknown>] as const)
        .filter(([, m]) => m.clientId === user.clientId),
    );
    // A tenant user's own name; an operator from another tenant (Gifsy staff working in this tenant) is not named.
    const nameBy = new Map((users ?? []).map((u) => [u.id, u.clientId === user.clientId ? u.name : 'Gifsy team']));
    const now = Date.now();
    return envelope(batches.map((b) => {
      const m = auditBy.get(b.id);
      const outcome = TargetsService.batchOutcome(b.status, (m?.status as string | undefined) ?? null, b.createdAt, now);
      return {
        ...b,
        outcome,
        failureReason:  outcome === 'FAILED' ? ((m?.failureReason as string | undefined) ?? null) : null,
        uploadedByName: nameBy.get(b.uploadedById) ?? null,
        months:         (m?.months as string[] | undefined) ?? null,
        fileName:       (m?.fileName as string | undefined) ?? null,
        fileSize:       (m?.fileSize as number | undefined) ?? null,
        savedCount:     (m?.savedCount as number | undefined) ?? null,
        newCount:       (m?.newCount as number | undefined) ?? null,
        overwriteCount: (m?.overwriteCount as number | undefined) ?? null,
        acknowledged:   (m?.acknowledged as string[] | undefined) ?? null,
        notApplied:     (m?.notApplied as unknown[] | undefined) ?? null,
        fileKept:       typeof m?.fileKey === 'string' && outcome === 'APPLIED',
      };
    }));
  }

  /**
   * What an upload-history row truthfully says happened:
   *   APPLIED          — saved (status APPLIED; 'COMPLETED' = uploads from before the confirm step).
   *   FAILED           — this attempt saved NOTHING (one all-or-nothing transaction; its audit row says FAILED).
   *   LEGACY_FAILED    — an older upload (chunked writes, no audit row) that stopped part-way: may be partly saved.
   *   IN_PROGRESS      — PENDING and recent: being saved now.
   *   ABANDONED        — PENDING and stale: it never finished, so its transaction was rolled back — nothing saved.
   */
  static batchOutcome(
    status: string,
    auditStatus: string | null,
    createdAt: Date,
    now: number,
  ): 'APPLIED' | 'FAILED' | 'LEGACY_FAILED' | 'IN_PROGRESS' | 'ABANDONED' {
    if (status === 'APPLIED' || status === 'COMPLETED') return 'APPLIED';
    if (status === 'PENDING') {
      return now - new Date(createdAt).getTime() > TargetsService.PENDING_STALE_MS ? 'ABANDONED' : 'IN_PROGRESS';
    }
    return auditStatus === 'FAILED' ? 'FAILED' : 'LEGACY_FAILED';
  }

  /**
   * Stream the kept file of a confirmed upload. Tenant-scoped: the batch must be the caller's tenant's, the audit row
   * must name that tenant, and the key must sit under that tenant's folder — anything else is a bare 404.
   */
  async openBatchFile(
    user: JwtPayload,
    batchId: string,
  ): Promise<StoredObjectStream & { fileName: string }> {
    const notKept = () => new NotFoundException('The file of this upload was not kept.');
    const batch = await this.prisma.targetUploadBatch.findFirst({
      where: { id: batchId, clientId: user.clientId },
      select: { id: true },
    });
    if (!batch) throw new NotFoundException('Upload not found');
    const audit = await this.prisma.auditLog.findFirst({
      where: { entityType: TARGET_UPLOAD_AUDIT_ENTITY, entityId: batch.id },
      select: { metadata: true },
    });
    const m = (audit?.metadata ?? {}) as Record<string, unknown>;
    const key = m.fileKey;
    if (
      m.clientId !== user.clientId ||
      typeof key !== 'string' ||
      !key.startsWith(`${TARGET_UPLOAD_FILE_PREFIX}${user.clientId}/${batch.id}/`) ||
      !this.storage
    ) {
      throw notKept();
    }
    const obj = await this.storage.openBoundedObject(key);
    if (!obj) throw notKept();
    return { ...obj, fileName: typeof m.fileName === 'string' && m.fileName ? m.fileName : `targets-${batch.id}.xlsx` };
  }

  // ─── Target change history (owner 2026-11-25, all clients) ─────────────────

  static readonly TARGET_HISTORY_PAGE = 100;

  /**
   * One outlet's target changes, newest first, in keyset pages of TARGET_HISTORY_PAGE (?before=<nextCursor>), tenant-
   * scoped. Each row: month, KPI (+ label), field, old → new, change type, who (a tenant user's name; another tenant's
   * operator = "Gifsy team"), when, and the upload (batch id + whether its file is kept). `trackingSince` = the tenant's
   * first recorded change (null = none yet) — changes before it were made before history tracking started.
   */
  async listTargetHistory(user: JwtPayload, q: TargetHistoryQueryDto) {
    const clientId = user.clientId;
    let cursor: { changedAt: Date; id: string } | null = null;
    if (q.before) {
      cursor = await this.prisma.targetChangeHistory.findFirst({
        where: { id: q.before, clientId },
        select: { changedAt: true, id: true },
      });
      if (!cursor) throw new BadRequestException('That page of the target history is no longer available — reload the page.');
    }
    const page = await this.prisma.targetChangeHistory.findMany({
      where: {
        clientId,
        outletCode: q.outletCode,
        ...(q.month ? { month: q.month } : {}),
        ...(q.kpiCode ? { kpiCode: q.kpiCode } : {}),
        ...(cursor
          ? { OR: [{ changedAt: { lt: cursor.changedAt } }, { changedAt: cursor.changedAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: TargetsService.TARGET_HISTORY_PAGE + 1,
    });
    const hasMore = page.length > TargetsService.TARGET_HISTORY_PAGE;
    const rows = hasMore ? page.slice(0, TargetsService.TARGET_HISTORY_PAGE) : page;
    const [first, kpis, users, kept] = await Promise.all([
      this.prisma.targetChangeHistory.findFirst({ where: { clientId }, orderBy: { changedAt: 'asc' }, select: { changedAt: true } }),
      this.prisma.kpiDef.findMany({ where: { clientId }, select: { code: true, label: true } }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.changedById).filter((x): x is string => !!x))] } },
        select: { id: true, name: true, clientId: true },
      }),
      this.keptUploadFiles(clientId, [...new Set(rows.map((r) => r.batchId).filter((x): x is string => !!x))]),
    ]);
    const label = new Map((kpis ?? []).map((k) => [k.code, k.label]));
    const nameBy = new Map((users ?? []).map((u) => [u.id, u.clientId === clientId ? u.name : 'Gifsy team']));
    return {
      items: rows.map((r) => ({
        id:            r.id,
        outletCode:    r.outletCode,
        month:         r.month,
        kpiCode:       r.kpiCode,
        kpiLabel:      label.get(r.kpiCode) ?? r.kpiCode,
        field:         r.field,
        oldValue:      r.oldValue,
        newValue:      r.newValue,
        changeType:    r.changeType,
        batchId:       r.batchId,
        batchFileKept: !!r.batchId && kept.has(r.batchId),
        changedByName: r.changedById ? nameBy.get(r.changedById) ?? null : null,
        changedAt:     r.changedAt,
      })),
      pageSize:      TargetsService.TARGET_HISTORY_PAGE,
      hasMore,
      nextCursor:    hasMore ? rows[rows.length - 1].id : null,
      trackingSince: first?.changedAt ?? null,
    };
  }

  /** Of these batch ids, the APPLIED uploads of THIS tenant whose file is kept (the "upload" link). */
  private async keptUploadFiles(clientId: string, batchIds: string[]): Promise<Set<string>> {
    if (batchIds.length === 0) return new Set();
    const audits = await this.prisma.auditLog.findMany({
      where: { entityType: TARGET_UPLOAD_AUDIT_ENTITY, entityId: { in: batchIds } },
      select: { entityId: true, metadata: true },
    });
    const out = new Set<string>();
    for (const a of audits ?? []) {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      if (m.clientId === clientId && m.status === 'APPLIED' && typeof m.fileKey === 'string') out.add(a.entityId);
    }
    return out;
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
