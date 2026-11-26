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

import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ExportRefusedException } from '../exports/export-kinds';
import { createHash } from 'node:crypto';
import { CreditAwardType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { CreditsService } from '../credits/credits.service';
import { PointsEngineService } from './points-engine.service';
import { evaluateRule, isVisibilityInput, ruleWarnings, validateRule } from './points-engine.helper';
import { isQuarterBasis, parseQuarter, quarterStartDate } from './points-engine.quarter';
import type {
  AwardType,
  EvalContext,
  EvaluationBasis,
  QuarterMonthValues,
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
import type { AppliesToOutletFacets } from '../common/applies-to/applies-to';
import { kpiOutletPredicate } from '../sales/outlet-kpi-scope.helper';
import { TenantService } from '../tenant/tenant.service';
import {
  loadVisibilityInputs,
  summarizeVisibility,
  visibilityContext,
  visibilityFactsFor,
  type VisibilityInputData,
} from './points-engine-visibility.loader';

/** The reserved non-KPI key inside a targetValues/kpiValues JSON (custom display names). */
const NAMES_KEY = '__names';

/** CreditBatch.sourceKind tag for batches created by the direct-credit path (idempotency + provenance). */
const POINTS_ENGINE_SOURCE = 'POINTS_ENGINE';

/** APPLIES-TO D5: SKIP reason for an (outlet, KPI) pair outside the KPI's scope (exact owner wording). */
export const KPI_SCOPE_SKIP_REASON = 'KPI not applicable to this outlet (KPI scope)';

@Injectable()
export class PointsComputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pointsEngine: PointsEngineService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly credits: CreditsService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * The tenant's visibility (POSM) result for the period — loaded ONCE per compute and only when a resolved rule
   * declares a `visibility:*` input (design §3a). Master switch + capture mode are read uncached / per call.
   */
  private async loadVisibility(
    clientId: string,
    period: string,
    visibilityConfig: unknown,
  ): Promise<VisibilityInputData> {
    const [enabled, mode] = await Promise.all([
      this.tenant.resolveVisibilityEnabled(clientId),
      this.tenant.resolveVisibilityCaptureMode(clientId),
    ]);
    return loadVisibilityInputs(this.prisma, clientId, period, {
      enabled,
      mode,
      config: (visibilityConfig ?? null) as Parameters<typeof loadVisibilityInputs>[3]['config'],
      now: new Date(),
    });
  }

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
    // QUARTER run (`YYYY-Qn`, owner-approved 2026-11-25): computes QUARTERLY rules only, over the 3 months of the FY
    // quarter; a monthly run computes monthly rules only (byte-identical to before). Effective-window test date = the
    // quarter's first day.
    const quarter = parseQuarter(period);
    const ruleKind: 'MONTH' | 'QUARTER' = quarter ? 'QUARTER' : 'MONTH';
    const periodDate = quarter ? quarterStartDate(quarter) : new Date(`${period}-01T00:00:00.000Z`);
    const quarterInfo = quarter
      ? {
          key: quarter.key,
          label: quarter.label,
          fyLabel: quarter.fyLabel,
          months: [...quarter.months],
          monthLabels: [...quarter.monthLabels],
          creditPeriod: quarter.creditPeriod,
        }
      : undefined;

    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    const engineDisabled = !settings.pointsEngine.enabled;
    const directCreditEnabled = settings.pointsEngine.directCreditEnabled;

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
        select: { kpiCode: true, evaluationBasis: true },
      });
      // Only the rules of THIS run's kind (monthly vs quarterly) decide its KPIs.
      activeKpiCodes = [
        ...new Set(
          ruleRows.filter((r) => isQuarterBasis(r.evaluationBasis) === (ruleKind === 'QUARTER')).map((r) => r.kpiCode),
        ),
      ];
    }

    const emptyPreview: ComputePreview = {
      clientId,
      period,
      filter: { program: programFilter, kpiCode: kpiFilter },
      counts: { total: 0, ok: 0, skip: 0, error: 0, noRule: 0 },
      totalPoints: 0,
      totalPayoutRupees: 0,
      rows: [],
      engineDisabled,
      directCreditEnabled,
      ruleVersionsUsed: [],
      sourceKey: computeSourceKey(clientId, period, { program: programFilter, kpiCode: kpiFilter }, [], []),
      payoutKey: computePayoutKey(clientId, period, { program: programFilter, kpiCode: kpiFilter }, []),
      ...(quarterInfo ? { quarter: quarterInfo } : {}),
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
          metro: true,
          outletType: { select: { code: true } },
        },
        orderBy: { outletCode: 'asc' },
      }),
      // Monthly: the period month (query unchanged). Quarter: the 3 months in one query per source (still no N+1).
      quarter
        ? this.prisma.outletSalesRecord.findMany({
            where: { clientId, month: { in: [...quarter.months] } },
            select: { outletCode: true, kpiValues: true, month: true },
          })
        : this.prisma.outletSalesRecord.findMany({
            where: { clientId, month: period },
            select: { outletCode: true, kpiValues: true },
          }),
      quarter
        ? this.prisma.outletTarget.findMany({
            where: { clientId, month: { in: [...quarter.months] } },
            select: { outletCode: true, targetValues: true, month: true },
          })
        : this.prisma.outletTarget.findMany({
            where: { clientId, month: period },
            select: { outletCode: true, targetValues: true },
          }),
    ]);
    // APPLIES-TO scope (D5) of EVERY KPI a rule could reference: the active (attached) KPIs plus every
    // KPI code present in this period's stored achievement / target values (a rule's bonus inputs —
    // kpiCode / achievement: / target: / pct: — can only ever read one of those keys). One query.
    const referencedKpiCodes = new Set<string>(activeKpiCodes);
    for (const r of salesRows) for (const k of Object.keys(normalizeValues(r.kpiValues))) referencedKpiCodes.add(k);
    for (const r of targetRows) for (const k of Object.keys(normalizeValues(r.targetValues))) referencedKpiCodes.add(k);
    const kpiScopeRows = await this.prisma.kpiDef.findMany({
      where: { clientId, code: { in: [...referencedKpiCodes] } },
      select: { code: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
    });
    // kpiCode → per-outlet scope predicate; absent for unscoped (or unknown) KPIs → never SKIPs/masks, so
    // an unscoped tenant's preview is byte-identical. Uses the outlet's CURRENT attributes (D9/D10).
    const kpiScopePred = new Map<string, (o: AppliesToOutletFacets) => boolean>();
    for (const k of kpiScopeRows ?? []) {
      const p = kpiOutletPredicate(k);
      if (p) kpiScopePred.set(k.code, p);
    }
    // Owner rule: every reader honours KPI scope. A rule's bonus input that reads a KPI OUT of scope for
    // this outlet must see it as ABSENT (→ the input's nullAs), never the stored out-of-scope value. So
    // the per-outlet achievement/target maps are masked by each KPI's own scope. No scoped KPI → the
    // original maps are passed through untouched (identity), keeping unscoped tenants byte-identical.
    const maskByScope = <T,>(values: Record<string, T>, facets: AppliesToOutletFacets): Record<string, T> => {
      if (kpiScopePred.size === 0) return values;
      let masked: Record<string, T> | null = null;
      for (const code of Object.keys(values)) {
        const pred = kpiScopePred.get(code);
        if (pred && !pred(facets)) {
          if (!masked) masked = { ...values };
          delete masked[code];
        }
      }
      return masked ?? values;
    };

    const salesByCode = new Map(
      salesRows.map((r) => [r.outletCode, normalizeValues(r.kpiValues)]),
    );
    const targetsByCode = new Map(
      targetRows.map((r) => [r.outletCode, normalizeValues(r.targetValues)]),
    );
    // Quarter: outletCode → month → values (a month with no row stays absent → each input's nullAs, naming the month).
    const byCodeMonth = (rows: Array<{ outletCode: string; month?: string; values: unknown }>) => {
      const m = new Map<string, Map<string, Record<string, number | null>>>();
      if (!quarter) return m;
      for (const r of rows) {
        let inner = m.get(r.outletCode);
        if (!inner) m.set(r.outletCode, (inner = new Map()));
        inner.set(r.month ?? '', normalizeValues(r.values));
      }
      return m;
    };
    const salesByCodeMonth = byCodeMonth(
      (salesRows as Array<{ outletCode: string; kpiValues: unknown; month?: string }>).map((r) => ({ outletCode: r.outletCode, month: r.month, values: r.kpiValues })),
    );
    const targetsByCodeMonth = byCodeMonth(
      (targetRows as Array<{ outletCode: string; targetValues: unknown; month?: string }>).map((r) => ({ outletCode: r.outletCode, month: r.month, values: r.targetValues })),
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
        ...(quarter ? (['QUARTER'] as const) : ([] as const)),
      );
      ruleCache.set(key, rule);
      return rule;
    };

    const rows: ComputePreviewRow[] = [];
    const ruleVersions = new Map<string, { ruleId: string; version: number }>();

    // Visibility (POSM) inputs (§3a): loaded lazily, ONCE, the first time a resolved rule declares a
    // `visibility:*` input — a run whose rules never read visibility issues no visibility query at all.
    let visibilityLoad: Promise<VisibilityInputData> | null = null;
    /** Outlets of THIS run whose rule read visibility — the preview's visibility counts cover exactly these. */
    const visibilityOutletCodes = new Set<string>();
    const getVisibility = () => (visibilityLoad ??= this.loadVisibility(clientId, period, (settings as { visibilityConfig?: unknown }).visibilityConfig));

    for (const outlet of outlets) {
      const program = outlet.programName ?? null;
      const programCategory = outlet.programCategory ?? null;
      const segment = {
        program,
        programCategory,
        outletType: outlet.outletType?.code ?? null,
        metro: outlet.metro ?? null,
      };
      const facets: AppliesToOutletFacets = { outletType: segment.outletType, program, subProgram: programCategory };
      // Masked by each KPI's own scope for THIS outlet (out-of-scope KPI values read as absent).
      // Quarter: per-month values (each masked by KPI scope like the monthly maps); the monthly maps stay empty.
      const quarterMonths = quarter
        ? quarter.months.map((m, i) => ({
            label: quarter.monthLabels[i],
            achievements: maskByScope(salesByCodeMonth.get(outlet.outletCode)?.get(m) ?? {}, facets),
            targets: maskByScope(targetsByCodeMonth.get(outlet.outletCode)?.get(m) ?? {}, facets),
          }))
        : null;
      const achievements = quarter ? {} : maskByScope(salesByCode.get(outlet.outletCode) ?? {}, facets);
      const targets = quarter ? {} : maskByScope(targetsByCode.get(outlet.outletCode) ?? {}, facets);

      for (const kpiCode of activeKpiCodes) {
        // Quarter rows echo the QUARTER TOTAL of the attached KPI (null when any month is blank).
        const achievement = quarterMonths ? quarterSum(quarterMonths.map((m) => m.achievements[kpiCode])) : toNumOrNull(achievements[kpiCode]);
        const target = quarterMonths ? quarterSum(quarterMonths.map((m) => m.targets[kpiCode])) : toNumOrNull(targets[kpiCode]);

        const base = {
          outletCode: outlet.outletCode,
          outletName: outlet.name,
          program,
          programCategory,
          kpiCode,
          achievement,
          target,
        };

        // D5: an (outlet, KPI) pair outside the KPI's APPLIES-TO scope is never computed.
        const inScope = kpiScopePred.get(kpiCode);
        if (inScope && !inScope(facets)) {
          rows.push({ ...base, status: 'SKIP', reason: KPI_SCOPE_SKIP_REASON, skipKind: 'KPI_SCOPE' });
          continue;
        }

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

        // Visibility facts for this outlet — only when THIS rule reads visibility (else nothing changes).
        const usesVisibility = (config.inputs ?? []).some(isVisibilityInput);
        let visData: VisibilityInputData | null = null;
        let visFacts: ReturnType<typeof visibilityFactsFor> = null;
        if (usesVisibility) {
          visData = await getVisibility();
          visFacts = visibilityFactsFor(visData, outlet);
          visibilityOutletCodes.add(outlet.outletCode);
        }

        const ctx: EvalContext = {
          achievements,
          targets,
          segment,
          ...(usesVisibility ? { visibility: visibilityContext(visFacts) } : {}),
          ...(quarter && quarterMonths
            ? {
                quarter: {
                  label: quarter.label,
                  months: quarterMonths as [QuarterMonthValues, QuarterMonthValues, QuarterMonthValues],
                },
              }
            : {}),
          meta: { outletCode: outlet.outletCode, period },
        };
        const outcome = evaluateRule(config, ctx);
        // Quarter rows: the credit narration names the quarter ("Consistency bonus Oct–Dec 2026") and the explanation
        // opens with the quarter + the attached KPI per month (a formula trace does not echo its inputs).
        const quarterRow =
          quarter && quarterMonths
            ? {
                narration: `${(config.output?.narration ?? '').trim() || 'Quarterly points'} ${quarter.label}`,
              }
            : {};
        const quarterPrefix =
          quarter && quarterMonths
            ? `${quarter.label} (${kpiCode} by month: ${quarterMonths
                .map((m) => `${m.label.slice(0, 3)} ${m.achievements[kpiCode] ?? '—'}`)
                .join(', ')}) · `
            : '';
        const visRow = visFacts
          ? {
              visibility: {
                approvedWindows: visFacts.approvedWindows,
                approved: visFacts.approved,
                windows: visFacts.windows,
                inScope: visFacts.inScope,
                scope: visFacts.scope,
                waitingWindows: visFacts.waitingWindows,
                openWindows: visFacts.openWindows,
                excludedApprovals: visFacts.excludedApprovals,
                note: visFacts.note,
              },
            }
          : {};
        // Prefix the explanation with the visibility values used (a formula trace does not echo its inputs).
        const visPrefix = visFacts ? `${visFacts.note} · ` : '';
        // No usable visibility data → name WHY on the row (never a bare "missing input").
        const visUnavailable = usesVisibility && visData && !visData.available ? visData.unavailableReason : undefined;

        if (outcome.status === 'OK') {
          rows.push({
            ...base,
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            awardType,
            fieldId,
            status: 'OK',
            points: outcome.points,
            // Why the rule paid 0 (opt-in gate failReason, or the missing skipRule input) — never a bare 0.
            ...(outcome.reason ? { reason: outcome.reason } : {}),
            explanation: `${quarterPrefix}${visPrefix}${explainTrace(outcome.trace, outcome.points)}${
              visUnavailable ? ` (visibility: ${visUnavailable})` : ''
            }`,
            ...visRow,
            ...quarterRow,
          });
        } else if (outcome.status === 'SKIP') {
          rows.push({
            ...base,
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            awardType,
            fieldId,
            status: 'SKIP',
            reason: `${outcome.reason}${visUnavailable ? ` — ${visUnavailable}` : ''}`,
            ...visRow,
            ...quarterRow,
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
    // POINTS rows: the credits-upload file the operator re-uploads does NOT state an award type — the
    // existing parser RE-DERIVES POINTS-vs-PAYOUT (and skips) from the live `CreditField.outletTypeAwards`
    // keyed by each outlet's TYPE, at upload time (credits-payouts-parser.ts). So an OK points row is only
    // safe to export if its output field is, right now, an ACTIVE field classified POINTS for THAT outlet's
    // type. Otherwise, on re-upload, the row would be either:
    //   • silently dropped  — field inactive/unknown (parser matches active fields by NAME), or NA for the
    //     outlet type (parser SKIPs) → points vanish with no error; or
    //   • ×100'd into rupees — field PAYOUT for the outlet type (parser does rupeesToPaise) → a 500-point
    //     award becomes a ₹500 payout.
    // We demote any such OK row to ERROR so (a) the preview is HONEST and (b) the export can only ever
    // contain correctly-classified whole-points cells.
    //
    // PAYOUT rows: COMPUTE-TO-REPORT only (owner directive 2026-10-21 — PAYOUT-COMPUTE-REPORT.md). The
    // engine NEVER credits or pays a payout; it computes the amount and emits it into the downloadable
    // payout report, where the client approves offline and the final payment status is uploaded through
    // the existing payout flow. So we DO NOT demote a PAYOUT rule (we did before, when payout crediting was
    // deferred); instead we validate the field is a usable PAYOUT bucket (honest config) and move the
    // computed amount from `points` into `payoutRupees` as WHOLE INR — keeping it entirely OUT of the
    // points total, the credit-upload export, the direct-credit path, and any wallet.
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

        const type = outletTypeByCode.get(r.outletCode) ?? null;

        if (r.awardType === 'PAYOUT') {
          // Report-only payout: validate the field is an active PAYOUT bucket for this outlet type, then
          // stash the WHOLE-INR amount in payoutRupees and clear points (never summed/exported/credited).
          if (!field) {
            demoteToError(r, 'Output credit field no longer exists in this tenant.');
          } else if (!field.isActive) {
            demoteToError(
              r,
              `Output credit field "${field.name}" is inactive — re-activate it or point the rule at an active field.`,
            );
          } else {
            const cls = classForType(field.outletTypeAwards, type);
            if (cls !== 'PAYOUT') {
              demoteToError(
                r,
                `Credit field "${field.name}" is ${cls} for outlet type "${type ?? '—'}", not PAYOUT — reclassify it for this outlet type or point the payout rule at a PAYOUT field.`,
              );
            } else {
              r.payoutRupees = Math.round(r.points ?? 0); // whole INR (rounded off, never paise)
              r.points = undefined; // keep payout entirely out of the points/credit path
            }
          }
          continue;
        }

        // POINTS (default) — unchanged safety: must be an active POINTS field for this outlet type.
        if (r.awardType !== 'POINTS') {
          demoteToError(r, `Unknown award type "${r.awardType}" — the rule output is mis-configured.`);
        } else if (!field) {
          demoteToError(r, 'Output credit field no longer exists in this tenant — cannot credit.');
        } else if (!field.isActive) {
          demoteToError(
            r,
            `Output credit field "${field.name}" is inactive — it would be ignored on upload. Re-activate it or point the rule at an active field.`,
          );
        } else {
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
      // No output fieldIds at all → any OK row is mis-configured (no bucket to credit/report into).
      for (const r of rows) {
        if (r.status === 'OK') demoteToError(r, 'Rule has no output credit field — cannot credit.');
      }
    }

    // ── 4. Aggregate ────────────────────────────────────────────────────────────────────────
    const counts = { total: rows.length, ok: 0, skip: 0, error: 0, noRule: 0 };
    let totalPoints = 0;
    let totalPayoutRupees = 0;
    for (const r of rows) {
      switch (r.status) {
        case 'OK':
          counts.ok++;
          // POINTS rows carry `points`; PAYOUT rows carry `payoutRupees` (report-only, never credited).
          if (r.awardType === 'PAYOUT') totalPayoutRupees += r.payoutRupees ?? 0;
          else totalPoints += r.points ?? 0;
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

    const ruleVersionsUsed = [...ruleVersions.values()];
    const preview: ComputePreview = {
      clientId,
      period,
      filter: { program: programFilter, kpiCode: kpiFilter },
      counts,
      totalPoints,
      totalPayoutRupees,
      rows,
      engineDisabled,
      directCreditEnabled,
      ruleVersionsUsed,
      sourceKey: '', // set below
      payoutKey: '', // set below
      ...(quarterInfo ? { quarter: quarterInfo } : {}),
      // Present ONLY when a rule read visibility — the month's visibility setup + counts, shown on the preview so
      // an unusable setup (switched off / no scope) is loud. Absent for every run that never touches visibility.
      ...(visibilityLoad ? { visibility: summarizeVisibility(await visibilityLoad, visibilityOutletCodes) } : {}),
    };
    // Deterministic key over the creditable (OK, amount>0) rows — the UI stores it and passes it back as
    // `expectedKey` on commit; commitCompute reuses this exact value so a run that changed since preview is
    // rejected. Computed from the same creditable rows commit will use (mapPreviewToUploadRows → amount>0).
    const creditable = PointsComputeService.mapPreviewToUploadRows(preview).filter((r) => r.amount > 0);
    // Fold in ONLY the rule versions of the CREDITABLE rows — not every resolved version (ruleVersionsUsed
    // also lists PAYOUT rules and SKIP/ERROR-only rules, which credit nothing). Keying off all of them would
    // let an unrelated republish (e.g. iterating a payout rule between preview and commit) change a POINTS
    // batch's idempotency key and defeat the dedup → a second identical PENDING batch. The creditable set is
    // exactly what the batch contains, so it is the correct idempotency basis. ruleVersionsUsed stays as the
    // informational "versions used" list on the preview.
    const creditableVersions = new Map<string, { ruleId: string; version: number }>();
    for (const r of rows) {
      if (
        r.status === 'OK' &&
        r.awardType === 'POINTS' &&
        (r.points ?? 0) > 0 &&
        r.ruleId &&
        typeof r.ruleVersion === 'number'
      ) {
        creditableVersions.set(`${r.ruleId}@${r.ruleVersion}`, { ruleId: r.ruleId, version: r.ruleVersion });
      }
    }
    preview.sourceKey = computeSourceKey(
      clientId,
      period,
      preview.filter,
      [...creditableVersions.values()],
      creditable,
    );
    // The PAYOUT report's own content key (payouts are not in sourceKey — they are never credited): the UI passes it
    // back as `expectedKey` on the payout-report download so a run that changed since review is refused.
    preview.payoutKey = computePayoutKey(clientId, period, preview.filter, rows);
    return preview;
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
    opts: {
      period: string;
      program?: string | null;
      kpiCode?: string | null;
      expectedKey?: string | null;
      /** The pendingKey of the visibility-pending outlet set the admin accepted (must equal the fresh run's — §3a). */
      acceptVisibilityPendingKey?: string | null;
    },
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
    // Visibility still pending (waiting for review / open window) must be explicitly accepted — never silent (§3a).
    PointsComputeService.assertVisibilityPendingAccepted(preview, opts.acceptVisibilityPendingKey);
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

    // Idempotency key = the one previewCompute already computed over these same creditable rows (clientId +
    // period + filter + rule versions + rows) — deterministic, so reusing it keeps preview + commit identical.
    const sourceKey = preview.sourceKey;

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

    // Credit batches are MONTH-keyed (batch code, upload window, TDS FY all parse YYYY-MM): a quarter run files its batch
    // under the quarter's LAST month. It can never be confused with that month's monthly run — its sourceKey hashes the
    // `YYYY-Qn` period (distinct idempotency key) and every row's narration names the quarter.
    const batchPeriod = preview.quarter?.creditPeriod ?? preview.period;
    const batch = await this.credits.createBatch(
      user,
      {
        period: batchPeriod,
        totalOutlets,
        totalPoints,
        totalPayoutPaise: 0,
        rows: creditableRows,
      } as never,
      { kind: POINTS_ENGINE_SOURCE, key: sourceKey },
    );

    // Record the admin's acceptance of pending visibility against the batch (audit trail; §3a). ONE row per batch:
    // an idempotent repeat commit (same batch) writes no second row, and a repeat after a failed write fills it in.
    // Never fails the commit — the batch already exists (logged; the next repeat retries the write).
    await PointsComputeService.recordVisibilityAcceptance(this.prisma, user, preview, {
      route: 'commit',
      entityId: batch.id,
      onePerEntity: true,
    });

    // Count OTHER credit batches for this period — ANY source (engine OR manual upload) — so the UI can
    // warn about possible double-crediting (Option A: cross-batch overlap is warned, not blocked).
    const priorBatchesThisPeriod = await this.prisma.creditBatch.count({
      where: {
        clientId: user.clientId,
        period: batchPeriod,
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
      priorBatchesThisPeriod,
    };
  }

  /**
   * PURE rule simulation for the authoring UI's live simulator (Wave 3). Validates a DRAFT rule config
   * (possibly unsaved) and, if valid, evaluates it against one sample context — returning the full trace
   * so the builder can show points + each node's delta + marginal-vs-whole band breakdown live. No DB, no
   * persistence, no money; the engine flag is NOT required (authors build rules while the engine is dormant).
   * Reuses the SINGLE evaluator/validator so the simulator can never diverge from real compute.
   */
  simulate(
    user: JwtPayload,
    dto: {
      attachsTo: RuleAttachment;
      output: { awardType: AwardType; fieldId: string };
      rounding: RoundingSpec;
      // free-form (the DTO types these `unknown` to survive the global pipe); validateRule enforces shape.
      inputs: unknown;
      pipeline: unknown;
      effectiveFrom?: string;
      effectiveTo?: string | null;
      evaluationBasis?: EvaluationBasis;
      context: {
        achievements?: Record<string, number | null>;
        targets?: Record<string, number | null>;
        segment?: { program?: string | null; programCategory?: string | null; outletType?: string | null; metro?: string | null };
        visibility?: { approvedWindows?: number | null; approved?: number | null; windows?: number | null; inScope?: number | null };
        quarterLabel?: string;
        months?: Array<{ label?: string; achievements?: Record<string, number | null>; targets?: Record<string, number | null> }>;
      };
    },
  ): {
    valid: boolean;
    errors: string[];
    outcome?: ReturnType<typeof evaluateRule>;
    /** The test visibility values the rule read (one per `visibility:*` input; null = left blank → nullAs). */
    visibilityUsed?: Array<{ ref: string; source: string; value: number | null }>;
    /** Non-blocking authoring warnings (ruleWarnings) — a valid rule that is easy to get wrong. */
    warnings?: string[];
  } {
    const config: PointsRuleConfig = {
      ruleId: 'simulation',
      tenantId: user.clientId,
      version: 0,
      status: 'draft',
      effectiveFrom: dto.effectiveFrom || '2000-01-01',
      effectiveTo: dto.effectiveTo ?? null,
      attachsTo: dto.attachsTo,
      evaluationBasis: dto.evaluationBasis ?? 'PERIOD_AGGREGATE',
      output: dto.output,
      rounding: dto.rounding,
      inputs: dto.inputs as RuleInput[],
      pipeline: dto.pipeline as PipelineNode[],
    };
    const errors = validateRule(config);
    if (errors.length > 0) return { valid: false, errors };

    const visInputs = (config.inputs ?? []).filter(isVisibilityInput);
    const rawVis = dto.context?.visibility;
    const visibility =
      rawVis && typeof rawVis === 'object' && !Array.isArray(rawVis)
        ? {
            approvedWindows: toNumOrNull(rawVis.approvedWindows),
            approved: toNumOrNull(rawVis.approved),
            windows: toNumOrNull(rawVis.windows),
            inScope: toNumOrNull(rawVis.inScope),
          }
        : undefined;
    // A QUARTERLY rule is simulated on 3 months of test values (month 1, 2, 3 of the quarter).
    let quarterCtx: EvalContext['quarter'] | undefined;
    if (config.evaluationBasis === 'QUARTER') {
      const months = Array.isArray(dto.context?.months) ? dto.context.months : [];
      if (months.length !== 3) {
        return { valid: false, errors: ['A quarterly rule needs test values for all 3 months of the quarter.'] };
      }
      const toVals = (r: unknown): Record<string, number | null> => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) return {};
        const out: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(r as Record<string, unknown>)) out[k] = toNumOrNull(v);
        return out;
      };
      quarterCtx = {
        label: (typeof dto.context?.quarterLabel === 'string' && dto.context.quarterLabel.trim()) || 'the quarter',
        months: months.map((m, i) => ({
          label: (typeof m?.label === 'string' && m.label.trim()) || `Month ${i + 1}`,
          achievements: toVals(m?.achievements),
          targets: toVals(m?.targets),
        })) as [QuarterMonthValues, QuarterMonthValues, QuarterMonthValues],
      };
    }
    const ctx: EvalContext = {
      achievements: dto.context?.achievements ?? {},
      targets: dto.context?.targets ?? {},
      segment: dto.context?.segment ?? {},
      ...(visibility ? { visibility } : {}),
      ...(quarterCtx ? { quarter: quarterCtx } : {}),
      meta: {},
    };
    // Test values must be possible ones (§3a): non-negative whole numbers, approved / inScope in {0,1},
    // approvedWindows <= windows <= 4, and approved consistent with approvedWindows.
    if (visibility) {
      const verrs = simulateVisibilityErrors(visibility);
      if (verrs.length > 0) return { valid: false, errors: verrs };
    }
    const outcome = evaluateRule(config, ctx);
    const warnings = ruleWarnings(config);
    const warn = warnings.length > 0 ? { warnings } : {};
    if (visInputs.length === 0) return { valid: true, errors: [], outcome, ...warn };
    const visibilityUsed = visInputs.map((inp) => {
      const key = (inp.source as string).slice('visibility:'.length) as 'approvedWindows' | 'approved' | 'windows' | 'inScope';
      return { ref: inp.ref, source: inp.source as string, value: visibility ? visibility[key] ?? null : null };
    });
    return { valid: true, errors: [], outcome, visibilityUsed, ...warn };
  }

  /**
   * §3a money gate: when a rule read visibility and some of the run's outlets still have a window WAITING FOR REVIEW
   * or STILL OPEN, those outlets read "not approved" for it now. Export (credit-upload + payout report) and direct
   * credit are REFUSED unless the admin accepted exactly that outlet count (a changed count = re-confirm). Throws 409.
   */
  static assertVisibilityPendingAccepted(preview: ComputePreview, acceptedKey: string | null | undefined): void {
    const v = preview.visibility;
    if (!v || !v.available || v.outletsPending <= 0) return;
    if (acceptedKey && acceptedKey === v.pendingKey) return;
    // ExportRefusedException (a 409) — its message is shown as-is on the Downloads page for a background build.
    throw new ExportRefusedException(
      `${v.outletsPending} outlet${v.outletsPending === 1 ? '' : 's'} will read visibility = NOT approved for ${preview.period} ` +
        `because a review is still pending (${v.outletsWaitingReview}) or a window is still open (${v.outletsOpenWindow}). ` +
        (!acceptedKey
          ? 'Tick "I accept" on the preview to continue, or wait until the reviews / windows are done.'
          : 'The outlets with pending visibility changed since you accepted them — re-run the preview and accept again.'),
    );
  }

  /** §3a: a money file built from a preview that changed since review (POINTS sourceKey / PAYOUT payoutKey) → 409. */
  static assertExpectedKey(actual: string, expected: string | null | undefined, what: string): void {
    if (expected && expected !== actual) {
      throw new ExportRefusedException(
        `The computation changed since you last previewed it (achievements, targets, visibility or a rule were updated). Re-run the preview and review the new result before downloading the ${what}.`,
      );
    }
  }

  /** Audit row for an accepted pending-visibility run (no-op when nothing was pending). */
  static async recordVisibilityAcceptance(
    prisma: Pick<PrismaService, 'auditLog'>,
    user: JwtPayload,
    preview: ComputePreview,
    ctx: { route: string; entityId: string; exportRequestId?: string | null; onePerEntity?: boolean },
  ): Promise<void> {
    const v = preview.visibility;
    if (!v || !v.available || v.outletsPending <= 0) return;
    try {
      if (ctx.onePerEntity) {
        const existing = await prisma.auditLog.findFirst({
          where: { entityType: VISIBILITY_ACCEPT_ENTITY, entityId: ctx.entityId },
          select: { id: true },
        });
        if (existing) return;
      }
      await prisma.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: VISIBILITY_ACCEPT_ENTITY,
          entityId: ctx.entityId,
          actorId: user.sub,
          metadata: {
            clientId: user.clientId,
            period: preview.period,
            route: ctx.route,
            ...(ctx.exportRequestId ? { exportRequestId: ctx.exportRequestId } : {}),
            filter: { program: preview.filter?.program ?? null, kpiCode: preview.filter?.kpiCode ?? null },
            pendingKey: v.pendingKey,
            outletsPending: v.outletsPending,
            outletsWaitingReview: v.outletsWaitingReview,
            outletsOpenWindow: v.outletsOpenWindow,
            openWindowsInMonth: v.openWindowsInMonth,
            // The accepted outlets (each list capped; the counts above are complete).
            waitingOutletCodes: v.waitingOutletCodes,
            openOutletCodes: v.openOutletCodes,
            outletCodesCapped: v.outletsWaitingReview > v.waitingOutletCodes.length || v.outletsOpenWindow > v.openOutletCodes.length,
            sourceKey: preview.sourceKey,
            payoutKey: preview.payoutKey,
          },
        },
      });
    } catch (e) {
      // The money action already happened (batch created / file built) — never turn it into a 500. Logged loudly; a
      // repeat of the same commit (idempotent) retries this write.
      ACCEPT_LOGGER.error(
        `visibility-pending acceptance audit write failed (${ctx.route} ${ctx.entityId}, ${user.clientId} ${preview.period}): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Pure mapping of a preview's OK POINTS rows → the existing credits `UploadRowDto[]`, for the export +
   * direct-credit path. POINTS amounts are WHOLE (a count, never ×100). fieldName carries the resolved
   * CreditField.name (previewCompute populates it) so the row round-trips through the existing credits
   * upload, which keys value columns by field name.
   *
   * POINTS ONLY — a PAYOUT row is report-only (owner directive 2026-10-21): it carries its amount in
   * `payoutRupees`, not `points`, and is excluded here so a payout can never enter crediting or a wallet.
   */
  static mapPreviewToUploadRows(preview: ComputePreview): UploadRowDto[] {
    const out: UploadRowDto[] = [];
    let rowNum = 1;
    for (const row of preview.rows) {
      if (row.status !== 'OK') continue;
      // SAFETY INVARIANT: the credit path (credit-upload export + direct-credit commit) is POINTS ONLY.
      // A PAYOUT row is report-only (its amount lives in payoutRupees, not points) and must NEVER enter
      // crediting — so exclude it explicitly here, not just via the (now undefined) points value.
      if (row.awardType === 'PAYOUT') continue;
      const dto = new UploadRowDto();
      dto.rowNum = rowNum++;
      dto.outletId = row.outletCode;
      dto.outletName = row.outletName ?? '';
      dto.fieldId = row.fieldId ?? '';
      dto.fieldName = row.fieldName ?? '';
      // Whole points (no ×100). PAYOUT-output rules would need paise handling at the Wave-2
      // credit boundary; Wave 1 is points-focused and the evaluator guarantees a whole integer.
      dto.amount = Math.round(row.points ?? 0);
      // Quarter rows name the quarter ("Consistency bonus Oct–Dec 2026"); monthly rows carry none (unchanged).
      dto.narration = row.narration ?? '';
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
    evaluationBasis: row.evaluationBasis as EvaluationBasis,
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
  r.payoutRupees = undefined;
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
  period: string,
  filter: { program?: string | null; kpiCode?: string | null } | undefined,
  ruleVersionsUsed: Array<{ ruleId: string; version: number }>,
  uploadRows: UploadRowDto[],
): string {
  const rows = uploadRows
    .map((r) => `${r.outletId}|${r.fieldId}|${r.amount}`)
    .sort();
  const versions = ruleVersionsUsed
    .map((v) => `${v.ruleId}@${v.version}`)
    .sort();
  const payload = JSON.stringify({
    clientId,
    period,
    filter: { program: filter?.program ?? null, kpiCode: filter?.kpiCode ?? null },
    versions,
    rows,
  });
  return `pe_${createHash('sha256').update(payload).digest('hex')}`;
}

const VISIBILITY_ACCEPT_ENTITY = 'POINTS_ENGINE_VISIBILITY_PENDING_ACCEPTED';
const ACCEPT_LOGGER = new Logger('PointsComputeVisibility');

/** Impossible simulator visibility values (§3a) → plain errors. Blank (null) values are allowed (= missing). */
function simulateVisibilityErrors(v: {
  approvedWindows: number | null;
  approved: number | null;
  windows: number | null;
  inScope: number | null;
}): string[] {
  const errs: string[] = [];
  const label: Record<string, string> = {
    approved: 'Visibility approved this month (1/0)',
    approvedWindows: 'Approved visibility windows this month',
    windows: 'Visibility windows in the month',
    inScope: 'Outlet in the visibility programme (1/0)',
  };
  for (const [k, n] of Object.entries(v)) {
    if (n === null) continue;
    if (!Number.isInteger(n) || n < 0) errs.push(`${label[k]} must be a whole number of 0 or more (got ${n}).`);
  }
  if (v.approved !== null && v.approved !== 0 && v.approved !== 1) errs.push(`${label.approved} must be 0 or 1.`);
  if (v.inScope !== null && v.inScope !== 0 && v.inScope !== 1) errs.push(`${label.inScope} must be 0 or 1.`);
  if (v.windows !== null && v.windows > 4) errs.push(`${label.windows} can be at most 4.`);
  if (v.approvedWindows !== null && v.windows !== null && v.approvedWindows > v.windows) {
    errs.push(`${label.approvedWindows} (${v.approvedWindows}) cannot be more than ${label.windows} (${v.windows}).`);
  }
  if (v.approved !== null && v.approvedWindows !== null && v.approved !== (v.approvedWindows >= 1 ? 1 : 0)) {
    errs.push(`${label.approved} must be 1 exactly when at least one window is approved.`);
  }
  // Out of scope (inScope 0) = nothing approved; windows stays the MONTH's count (the real compute shape), so a
  // windows value > 0 is allowed here.
  if (v.inScope === 0 && ((v.approvedWindows ?? 0) > 0 || v.approved === 1)) {
    errs.push('An outlet outside the visibility programme has nothing approved (approved 0, approved windows 0).');
  }
  return errs;
}

/** Deterministic key over the OK PAYOUT rows (outlet × field × whole INR × rule version), tenant + period scoped. */
function computePayoutKey(
  clientId: string,
  period: string,
  filter: { program?: string | null; kpiCode?: string | null } | undefined,
  rows: ComputePreviewRow[],
): string {
  const payout = rows
    .filter((r) => r.status === 'OK' && r.awardType === 'PAYOUT')
    .map((r) => `${r.outletCode}|${r.kpiCode}|${r.fieldId ?? ''}|${r.payoutRupees ?? 0}|${r.ruleId ?? ''}@${r.ruleVersion ?? ''}`)
    .sort();
  const payload = JSON.stringify({
    clientId,
    period,
    filter: { program: filter?.program ?? null, kpiCode: filter?.kpiCode ?? null },
    payout,
  });
  return `pp_${createHash('sha256').update(payload).digest('hex')}`;
}

/** Quarter total of one KPI across the 3 months — null when ANY month is blank (never a partial sum). */
function quarterSum(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  for (const v of values) {
    const n = toNumOrNull(v);
    if (n === null) return null;
    sum += n;
  }
  return sum;
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
