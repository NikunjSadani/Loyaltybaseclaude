/**
 * PointsComputeService — Points Compute Engine, Wave 1 (read-only compute + preview).
 *
 * Loads the raw per-outlet achievement + target + segment inputs for a (clientId × period),
 * resolves each outlet's effective PUBLISHED rule (PointsEngineService.getActiveForAttachment),
 * runs the PURE evaluator (points-engine.helper), and produces a ComputePreview: one row per
 * (outlet × active input-KPI) with status (OK | SKIP | ERROR | NO_RULE), points, and a one-line
 * explanation from the trace.
 *
 * ⚠️ READ-ONLY in Wave 1 — this service NEVER writes: no CreditBatch create, no wallet/ledger
 * touch. Its OK rows map 1:1 onto the existing credits `UploadRowDto` (mapPreviewToUploadRows)
 * so the preview can be exported into the existing credits-upload flow after offline approval
 * (Wave 2). See POINTS-COMPUTE-ENGINE-DESIGN.md §6 (integration) + §11 (Wave 1).
 *
 * INPUT JOIN (mirrors TargetsService.getPace, targets.service.ts): outlets + OutletSalesRecord
 * (achievements) + OutletTarget (targets) are each loaded in ONE query per source and mapped by
 * outletCode (NO N+1). A blank cell is an OMITTED key, never 0 (trap #1) — the evaluator's
 * per-input nullAs policy decides what an absent value means. Outlets are scoped exactly like
 * targets/getPace (clientId + deletedAt:null) — NOT `isActive:true` (that would wrongly shrink
 * the universe; trap #1). Rule resolution reuses the TESTED getActiveForAttachment, MEMOIZED per
 * (program × programCategory × kpiCode) so distinct segment combos — not outlets — bound the
 * query count.
 */

import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreditAwardType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { CreditsService } from '../credits/credits.service';
import { PointsEngineService } from './points-engine.service';
import { evaluateRule, validateRule } from './points-engine.helper';
import type {
  AwardType,
  EvalContext,
  PipelineNode,
  PointsRuleConfig,
  RoundingSpec,
  RuleAttachment,
  RuleInput,
  RuleStatus,
} from './points-engine.types';
import type { ComputeCommitResult, ComputePreview, ComputePreviewRow } from './points-compute.types';
import type { PointsRule } from '@prisma/client';
import { UploadRowDto, UploadRowStatus } from '../credits/dto/credits.dto';

/** The reserved non-KPI key inside a targetValues/kpiValues JSON (custom display names). */
const NAMES_KEY = '__names';

/** CreditBatch.sourceKind tag for batches created by the direct-credit path (idempotency + provenance). */
const POINTS_ENGINE_SOURCE = 'POINTS_ENGINE';

@Injectable()
export class PointsComputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pointsEngine: PointsEngineService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly credits: CreditsService,
  ) {}

  /**
   * Compute a read-only preview for a (tenant × period). No writes.
   *
   * Tenant scope: compute is inherently SINGLE-tenant (every input source is keyed by clientId),
   * so it runs against `user.clientId` — the assumed tenant for an operator working in a brand,
   * the pinned tenant for a CLIENT_ADMIN. tenantScope()/platformWide() cannot widen this to "all
   * tenants": there is no cross-tenant compute, and an UN-assumed GIFSY_ADMIN (clientId 'gifsy',
   * which owns no tenant business data) simply gets an empty preview. This matches how every other
   * tenant-scoped service (targets/credits) loads by user.clientId directly.
   */
  async previewCompute(
    user: JwtPayload,
    opts: { period: string; program?: string | null; kpiCode?: string | null },
  ): Promise<ComputePreview> {
    const clientId = user.clientId;
    const period = opts.period;
    const programFilter = opts.program?.trim() || null;
    const kpiFilter = opts.kpiCode?.trim() || null;

    // The period month maps to its first calendar day for the rule effective-window test
    // (effectiveFrom <= periodDate <= effectiveTo). effectiveFrom/To are @db.Date business days;
    // using the month's first day means a rule effective from the 1st covers the whole month.
    const periodDate = new Date(`${period}-01T00:00:00.000Z`);

    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    const engineDisabled = !settings.pointsEngine.enabled;

    // ── 1. Determine the active input-KPI attachments to compute ────────────────────────────
    // An explicit kpiCode filter pins the run to exactly that KPI (so outlets with no rule for it
    // still surface as NO_RULE). Otherwise the KPIs = the distinct kpiCode of every PUBLISHED rule
    // effective in the period — a single query, deduped in JS.
    let activeKpiCodes: string[];
    if (kpiFilter) {
      activeKpiCodes = [kpiFilter];
    } else {
      const ruleRows = await this.prisma.pointsRule.findMany({
        where: {
          clientId,
          status: 'published',
          effectiveFrom: { lte: periodDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodDate } }],
        },
        select: { kpiCode: true },
      });
      activeKpiCodes = [...new Set(ruleRows.map((r) => r.kpiCode))];
    }

    const emptyPreview: ComputePreview = {
      clientId,
      period,
      filter: { program: programFilter, kpiCode: kpiFilter },
      counts: { total: 0, ok: 0, skip: 0, error: 0, noRule: 0 },
      totalPoints: 0,
      rows: [],
      engineDisabled,
      ruleVersionsUsed: [],
    };
    if (activeKpiCodes.length === 0) return emptyPreview;

    // ── 2. Load inputs (one query per source; map by outletCode; NO N+1) ────────────────────
    const [outlets, salesRows, targetRows] = await Promise.all([
      this.prisma.outlet.findMany({
        where: {
          clientId,
          deletedAt: null,
          ...(programFilter ? { programName: programFilter } : {}),
        },
        select: {
          outletCode: true,
          name: true,
          programName: true,
          programCategory: true,
          outletType: { select: { code: true } },
        },
        orderBy: { outletCode: 'asc' },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: { clientId, month: period },
        select: { outletCode: true, kpiValues: true },
      }),
      this.prisma.outletTarget.findMany({
        where: { clientId, month: period },
        select: { outletCode: true, targetValues: true },
      }),
    ]);

    const salesByCode = new Map(
      salesRows.map((r) => [r.outletCode, normalizeValues(r.kpiValues)]),
    );
    const targetsByCode = new Map(
      targetRows.map((r) => [r.outletCode, normalizeValues(r.targetValues)]),
    );
    // Outlet type per code — needed to resolve the LIVE CreditField classification per outlet (below).
    const outletTypeByCode = new Map(
      outlets.map((o) => [o.outletCode, o.outletType?.code ?? null]),
    );

    // ── 3. Resolve + evaluate per (outlet × active KPI) ─────────────────────────────────────
    // Memoize rule resolution by (program × programCategory × kpiCode): distinct segment combos,
    // not outlet count, bound the getActiveForAttachment calls — so this stays N+1-free at scale.
    const ruleCache = new Map<string, PointsRule | null>();
    const resolveRule = async (
      program: string | null,
      programCategory: string | null,
      kpiCode: string,
    ): Promise<PointsRule | null> => {
      const key = `${program ?? ''}||${programCategory ?? ''}||${kpiCode}`;
      if (ruleCache.has(key)) return ruleCache.get(key) ?? null;
      const rule = await this.pointsEngine.getActiveForAttachment(
        clientId,
        program,
        programCategory,
        kpiCode,
        periodDate,
      );
      ruleCache.set(key, rule);
      return rule;
    };

    const rows: ComputePreviewRow[] = [];
    const ruleVersions = new Map<string, { ruleId: string; version: number }>();

    for (const outlet of outlets) {
      const program = outlet.programName ?? null;
      const programCategory = outlet.programCategory ?? null;
      const achievements = salesByCode.get(outlet.outletCode) ?? {};
      const targets = targetsByCode.get(outlet.outletCode) ?? {};
      const segment = {
        program,
        programCategory,
        outletType: outlet.outletType?.code ?? null,
      };

      for (const kpiCode of activeKpiCodes) {
        const achievement = toNumOrNull(achievements[kpiCode]);
        const target = toNumOrNull(targets[kpiCode]);

        const base = {
          outletCode: outlet.outletCode,
          outletName: outlet.name,
          program,
          programCategory,
          kpiCode,
          achievement,
          target,
        };

        const rule = await resolveRule(program, programCategory, kpiCode);
        if (!rule) {
          rows.push({ ...base, status: 'NO_RULE', reason: 'No active rule for this attachment.' });
          continue;
        }

        ruleVersions.set(`${rule.ruleId}@${rule.version}`, {
          ruleId: rule.ruleId,
          version: rule.version,
        });

        const config = rowToConfig(rule);
        const awardType = config.output?.awardType;
        const fieldId = config.output?.fieldId;

        // Validate-on-load (defensive): a published row could predate a validator tightening, or
        // carry malformed JSON. An invalid rule yields an ERROR row rather than crediting garbage.
        const errors = validateRule(config);
        if (errors.length > 0) {
          rows.push({
            ...base,
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            awardType,
            fieldId,
            status: 'ERROR',
            reason: `Invalid rule: ${errors.join('; ')}`,
          });
          continue;
        }

        const ctx: EvalContext = {
          achievements,
          targets,
          segment,
          meta: { outletCode: outlet.outletCode, period },
        };
        const outcome = evaluateRule(config, ctx);

        if (outcome.status === 'OK') {
          rows.push({
            ...base,
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            awardType,
            fieldId,
            status: 'OK',
            points: outcome.points,
            explanation: explainTrace(outcome.trace, outcome.points),
          });
        } else if (outcome.status === 'SKIP') {
          rows.push({
            ...base,
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            awardType,
            fieldId,
            status: 'SKIP',
            reason: outcome.reason,
          });
        } else {
          rows.push({
            ...base,
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            awardType,
            fieldId,
            status: 'ERROR',
            reason: outcome.errors.join('; '),
          });
        }
      }
    }

    // ── 3b. Reconcile every OK row against the LIVE output CreditField config ───────────────────
    // The credits-upload file the operator re-uploads does NOT state an award type — the existing
    // parser RE-DERIVES POINTS-vs-PAYOUT (and skips) from the live `CreditField.outletTypeAwards`
    // keyed by each outlet's TYPE, at upload time (credits-payouts-parser.ts). So an OK points row
    // is only safe to export if its output field is, right now, an ACTIVE field classified POINTS for
    // THAT outlet's type. Otherwise, on re-upload, the row would be either:
    //   • silently dropped  — field inactive/unknown (parser matches active fields by NAME), or NA
    //     for the outlet type (parser SKIPs) → points vanish with no error; or
    //   • ×100'd into rupees — field PAYOUT for the outlet type (parser does rupeesToPaise) → a
    //     500-point award becomes a ₹500 payout.
    // We demote any such OK row to ERROR here so (a) the preview is HONEST and (b) the export can only
    // ever contain correctly-classified whole-points cells. We also reject non-POINTS rule outputs:
    // PAYOUT-award rules need the paise-correct credit path that lands in Wave 2.
    // fieldName (the parser matches value columns by CreditField.name, not id) is resolved in the same
    // batched query (no N+1).
    const fieldIds = [...new Set(rows.map((r) => r.fieldId).filter((x): x is string => !!x))];
    if (fieldIds.length > 0) {
      const fields = await this.prisma.creditField.findMany({
        where: { clientId, id: { in: fieldIds } },
        select: { id: true, name: true, isActive: true, outletTypeAwards: true },
      });
      const fieldById = new Map(fields.map((f) => [f.id, f]));
      for (const r of rows) {
        if (!r.fieldId) continue;
        const field = fieldById.get(r.fieldId);
        r.fieldName = field?.name ?? undefined;
        if (r.status !== 'OK') continue;
        if (r.awardType !== 'POINTS') {
          demoteToError(
            r,
            `This rule credits a ${r.awardType ?? 'non-POINTS'} bucket; the compute preview supports whole POINTS only (PAYOUT crediting lands in Wave 2).`,
          );
        } else if (!field) {
          demoteToError(r, 'Output credit field no longer exists in this tenant — cannot credit.');
        } else if (!field.isActive) {
          demoteToError(
            r,
            `Output credit field "${field.name}" is inactive — it would be ignored on upload. Re-activate it or point the rule at an active field.`,
          );
        } else {
          const type = outletTypeByCode.get(r.outletCode) ?? null;
          const cls = classForType(field.outletTypeAwards, type);
          if (cls !== 'POINTS') {
            demoteToError(
              r,
              `Credit field "${field.name}" is ${cls} for outlet type "${type ?? '—'}", not POINTS — on upload it would ${
                cls === 'PAYOUT' ? 'be credited as a ₹ payout (×100), not points' : 'be skipped'
              }. Reclassify the field for this outlet type or point the rule at a POINTS field.`,
            );
          }
        }
      }
    } else {
      // No output fieldIds at all → any OK row is mis-configured (no bucket to credit into).
      for (const r of rows) {
        if (r.status === 'OK') demoteToError(r, 'Rule has no output credit field — cannot credit.');
      }
    }

    // ── 4. Aggregate ────────────────────────────────────────────────────────────────────────
    const counts = { total: rows.length, ok: 0, skip: 0, error: 0, noRule: 0 };
    let totalPoints = 0;
    for (const r of rows) {
      switch (r.status) {
        case 'OK':
          counts.ok++;
          totalPoints += r.points ?? 0;
          break;
        case 'SKIP':
          counts.skip++;
          break;
        case 'ERROR':
          counts.error++;
          break;
        case 'NO_RULE':
          counts.noRule++;
          break;
      }
    }

    return {
      clientId,
      period,
      filter: { program: programFilter, kpiCode: kpiFilter },
      counts,
      totalPoints,
      rows,
      engineDisabled,
      ruleVersionsUsed: [...ruleVersions.values()],
    };
  }

  /**
   * Wave 2 DIRECT-CREDIT commit: compute a run and create a PENDING_CONFIRM CreditBatch from its OK
   * rows through the EXISTING credits rail (so safety caps, confirm-to-credit, and maker-checker
   * reversal/clawback are all reused unchanged — this method performs NO wallet write itself; money
   * moves only when the operator confirms the batch via the existing confirmBatch flow).
   *
   * Double-gated: the per-tenant engine must be ENABLED and GIFSY must have turned ON directCreditEnabled
   * (a tenant admin cannot self-enable the in-portal credit path — §12 #4-revised/#8). The commit route
   * additionally requires the same `credits:upload` entitlement as a manual batch upload (controller).
   *
   * Idempotent: a deterministic sourceKey over the committable content means a re-submit of the identical
   * run returns the existing batch instead of creating a second one (no double-credit). A genuinely
   * different result (corrected data) yields a new key → a new batch; other engine batches for the same
   * period are surfaced (non-blocking) so the UI can warn about double-sourcing.
   */
  async commitCompute(
    user: JwtPayload,
    opts: { period: string; program?: string | null; kpiCode?: string | null; expectedKey?: string | null },
  ): Promise<ComputeCommitResult> {
    // MONEY GATE read UNCACHED + fail-closed: a Gifsy "turn it off" must take effect immediately across
    // the fleet (the 5-min per-instance settings cache would leave a revoked capability live on stale
    // instances — the same hazard the project reads visibility/kycGstin uncached for).
    const flags = await this.tenantSettings.getPointsEngineFlagsUncached(user.clientId);
    if (!flags.enabled) {
      throw new ForbiddenException('The points engine is disabled for this tenant.');
    }
    if (!flags.directCreditEnabled) {
      throw new ForbiddenException(
        'In-portal direct crediting is not enabled for this tenant — Gifsy must turn it on, or use Export for offline upload.',
      );
    }

    const preview = await this.previewCompute(user, opts);
    const uploadRows = PointsComputeService.mapPreviewToUploadRows(preview); // OK rows only, whole points
    if (uploadRows.length === 0) {
      throw new BadRequestException(
        'This run has no creditable rows (all outlets were skipped, errored, or had no rule).',
      );
    }

    // Every committable row is POINTS (Wave 1 demotes any PAYOUT-award / mis-classified row to ERROR, so
    // it never reaches here) → the batch is pure points; no payout paise. Keep ONLY rows that will actually
    // credit (amount > 0 — confirmBatch skips 0-point rows), so the batch + header match what is credited.
    const creditableRows = uploadRows.filter((r) => r.amount > 0);
    if (creditableRows.length === 0) {
      throw new BadRequestException('This run computed 0 points for every outlet — nothing to credit.');
    }

    // Idempotency key over the actual committed content (clientId + period + filter + rule versions + the
    // creditable rows). previewCompute is read-only, so recomputing for the key is cheap + deterministic.
    const sourceKey = computeSourceKey(user.clientId, preview, creditableRows);

    // TOCTOU guard: if the caller passed the key they reviewed and the fresh compute no longer matches
    // (achievements/targets edited or a rule republished since review), refuse — never credit a run that
    // diverged from what was approved. The operator re-previews to see + approve the new result.
    if (opts.expectedKey && opts.expectedKey !== sourceKey) {
      throw new ConflictException(
        'The computation changed since you last previewed it (achievements, targets, or a rule were updated). Re-preview and review the new result before crediting.',
      );
    }

    const totalPoints = creditableRows.reduce((sum, r) => sum + r.amount, 0);
    const totalOutlets = new Set(creditableRows.map((r) => r.outletId)).size;
    // CreditBatch.totalPoints is a 32-bit Int; fail CLOSED with a clear error rather than let the DB abort
    // the whole commit on overflow for an (implausibly) huge run.
    if (totalPoints > 2_147_483_647) {
      throw new BadRequestException(
        'This run totals more points than a single batch can hold — narrow it by program or KPI and credit in parts.',
      );
    }

    const existingBefore = await this.prisma.creditBatch.findFirst({
      where: { clientId: user.clientId, sourceKey },
      select: { id: true },
    });

    const batch = await this.credits.createBatch(
      user,
      {
        period: preview.period,
        totalOutlets,
        totalPoints,
        totalPayoutPaise: 0,
        rows: creditableRows,
      } as never,
      { kind: POINTS_ENGINE_SOURCE, key: sourceKey },
    );

    const priorPointsEngineBatchesThisPeriod = await this.prisma.creditBatch.count({
      where: {
        clientId: user.clientId,
        period: preview.period,
        sourceKind: POINTS_ENGINE_SOURCE,
        id: { not: batch.id },
      },
    });

    return {
      batchId: batch.id,
      batchCode: batch.batchCode,
      status: batch.status,
      period: batch.period,
      totalPoints: batch.totalPoints,
      totalOutlets: batch.totalOutlets,
      counts: preview.counts,
      sourceKey,
      idempotentHit: !!existingBefore,
      priorPointsEngineBatchesThisPeriod,
    };
  }

  /**
   * Pure mapping of a preview's OK rows → the existing credits `UploadRowDto[]`, for the
   * export/Wave-2 re-upload path. POINTS amounts are WHOLE (a count, never ×100). fieldName carries
   * the resolved CreditField.name (previewCompute populates it) so the row round-trips through the
   * existing credits upload, which keys value columns by field name. Only OK rows carry points.
   */
  static mapPreviewToUploadRows(preview: ComputePreview): UploadRowDto[] {
    const out: UploadRowDto[] = [];
    let rowNum = 1;
    for (const row of preview.rows) {
      if (row.status !== 'OK') continue;
      const dto = new UploadRowDto();
      dto.rowNum = rowNum++;
      dto.outletId = row.outletCode;
      dto.outletName = row.outletName ?? '';
      dto.fieldId = row.fieldId ?? '';
      dto.fieldName = row.fieldName ?? '';
      // Whole points (no ×100). PAYOUT-output rules would need paise handling at the Wave-2
      // credit boundary; Wave 1 is points-focused and the evaluator guarantees a whole integer.
      dto.amount = Math.round(row.points ?? 0);
      dto.narration = '';
      dto.awardType = (row.awardType ?? 'POINTS') as CreditAwardType;
      dto.status = UploadRowStatus.OK;
      dto.errors = [];
      out.push(dto);
    }
    return out;
  }
}

// ─── pure helpers ───────────────────────────────────────────────────────────────────────────

/** Reconstruct a PointsRuleConfig from a stored PointsRule row (Date → YYYY-MM-DD; Json casts). */
function rowToConfig(row: PointsRule): PointsRuleConfig {
  return {
    ruleId: row.ruleId,
    tenantId: row.clientId,
    version: row.version,
    status: row.status as RuleStatus,
    effectiveFrom: formatDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? formatDate(row.effectiveTo) : null,
    attachsTo: row.attachsTo as unknown as RuleAttachment,
    evaluationBasis: row.evaluationBasis as 'PERIOD_AGGREGATE',
    output: row.output as unknown as { awardType: AwardType; fieldId: string },
    rounding: row.rounding as unknown as RoundingSpec,
    inputs: row.inputs as unknown as RuleInput[],
    pipeline: row.pipeline as unknown as PipelineNode[],
  };
}

/** @db.Date → YYYY-MM-DD. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Coerce a stored kpiValues/targetValues Json into the evaluator's Record<string, number|null>,
 * dropping the reserved `__names` key (display names, not a KPI value). A blank cell is already an
 * OMITTED key upstream, so absent stays absent here — the evaluator's nullAs policy decides its
 * meaning (never silently 0).
 */
function normalizeValues(v: unknown): Record<string, number | null> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const src = v as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  for (const [k, val] of Object.entries(src)) {
    if (k === NAMES_KEY) continue;
    out[k] = toNumOrNull(val);
  }
  return out;
}

/**
 * In-place demotion of an OK row to ERROR (the output field can't safely take whole points). Clears
 * points + explanation so it is never summed, exported, or shown as a credit. Mirrors the parser's
 * effective outcome (dropped / mis-credited) as an explicit, honest ERROR in the preview.
 */
function demoteToError(r: ComputePreviewRow, reason: string): void {
  r.status = 'ERROR';
  r.reason = reason;
  r.points = undefined;
  r.explanation = undefined;
}

/**
 * Resolve a CreditField's award class for an outlet type EXACTLY as the credits parser does:
 * `outletTypeAwards[type] ?? 'NA'` (credits-payouts-parser.ts). A null/unknown type, or a malformed
 * map, collapses to NA (which the parser SKIPs) — never silently POINTS.
 */
function classForType(awards: unknown, type: string | null): 'POINTS' | 'PAYOUT' | 'NA' {
  if (!type || awards === null || typeof awards !== 'object' || Array.isArray(awards)) return 'NA';
  const v = (awards as Record<string, unknown>)[type];
  return v === 'POINTS' || v === 'PAYOUT' ? v : 'NA';
}

/**
 * Deterministic idempotency key for a direct-credit commit: a sha256 over the tenant, period, filter,
 * the rule versions used, AND the committable rows (outlet × field × whole points, sorted). Two commits
 * of the SAME result collide (→ the first batch is returned, no double-credit); a genuinely different
 * result (corrected achievements, a republished rule version, a changed filter) yields a new key → a new,
 * intentional batch. The row set is folded in so re-running after a data correction is NOT silently
 * deduped against the stale batch. Scoped to the clientId so keys can never collide across tenants.
 */
function computeSourceKey(
  clientId: string,
  preview: ComputePreview,
  uploadRows: UploadRowDto[],
): string {
  const rows = uploadRows
    .map((r) => `${r.outletId}|${r.fieldId}|${r.amount}`)
    .sort();
  const versions = preview.ruleVersionsUsed
    .map((v) => `${v.ruleId}@${v.version}`)
    .sort();
  const payload = JSON.stringify({
    clientId,
    period: preview.period,
    filter: { program: preview.filter?.program ?? null, kpiCode: preview.filter?.kpiCode ?? null },
    versions,
    rows,
  });
  return `pe_${createHash('sha256').update(payload).digest('hex')}`;
}

/** A finite number, else null (the evaluator's "absent" that triggers each input's nullAs). */
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One-line explanation of the math from the evaluator trace (for the preview report). */
function explainTrace(
  trace: Array<{ detail: string }>,
  points: number,
): string {
  if (!trace || trace.length === 0) return `${points} pts`;
  return `${trace.map((s) => s.detail).join(' → ')} → ${points} pts`;
}
