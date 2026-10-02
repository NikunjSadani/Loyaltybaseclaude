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

import { Injectable } from '@nestjs/common';
import { CreditAwardType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
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
import type { ComputePreview, ComputePreviewRow } from './points-compute.types';
import type { PointsRule } from '@prisma/client';
import { UploadRowDto, UploadRowStatus } from '../credits/dto/credits.dto';

/** The reserved non-KPI key inside a targetValues/kpiValues JSON (custom display names). */
const NAMES_KEY = '__names';

@Injectable()
export class PointsComputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pointsEngine: PointsEngineService,
    private readonly tenantSettings: TenantSettingsService,
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

    // Resolve CreditField display NAMES for the output buckets. REQUIRED for the credits-upload export
    // to round-trip: the existing credits parser matches value columns by CreditField.name, not id
    // (points-compute-export.helper). One batched query (no N+1).
    const fieldIds = [...new Set(rows.map((r) => r.fieldId).filter((x): x is string => !!x))];
    if (fieldIds.length > 0) {
      const fields = await this.prisma.creditField.findMany({
        where: { clientId, id: { in: fieldIds } },
        select: { id: true, name: true },
      });
      const nameById = new Map(fields.map((f) => [f.id, f.name]));
      for (const r of rows) if (r.fieldId) r.fieldName = nameById.get(r.fieldId) ?? undefined;
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
