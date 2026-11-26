/**
 * PointsEngineService — Points Compute Engine rule store (Wave 0).
 *
 * Owns the versioned, immutable `PointsRule` config CRUD. NO compute here (that is the
 * pure evaluator in points-engine.helper.ts + the compute service in later waves) and NO
 * credit wiring. This service only authors/reads/resolves rule CONFIGS.
 *
 * VERSIONING MODEL (mirrors the PointsRuleConfig contract):
 *   - A LOGICAL rule is identified by `ruleId`; each (clientId, ruleId, version) is one row.
 *   - `createDraft` seeds either a brand-new rule (new ruleId, version 1) OR the NEXT draft
 *     version of an existing rule (same ruleId, version = max+1). Only ONE open draft per
 *     ruleId at a time.
 *   - `updateDraft` mutates a row ONLY while status === 'draft'. A PUBLISHED version is never
 *     mutated — you edit a published rule by creating a new draft version and publishing it.
 *   - `publish` promotes the draft in place to 'published' and SUPERSEDES any prior published
 *     version of the same ruleId whose effective window overlaps (archives it + closes its
 *     effectiveTo), so editing can never silently restate already-credited history.
 *
 * TENANCY: every read is scoped via platformWide()/tenantScope() (un-assumed GIFSY_ADMIN =
 * platform-wide; everyone else — incl. assumed staff — pinned to their tenant). Writes bind
 * the rule to `user.clientId` (the assumed tenant for an operator working in a brand).
 *
 * VALIDATION: createDraft/updateDraft/publish all call validateRule() (the shared contract
 * validator in points-engine.helper.ts) and throw BadRequestException on any error. That file
 * is written by a sibling agent; until it lands this module will not compile (expected).
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, PointsRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { validateRule } from './points-engine.helper';
import { isQuarterBasis } from './points-engine.quarter';
import {
  AppliesTo,
  intersectAppliesTo,
  isUnscoped,
  kpiAppliesTo,
  normalizeAppliesTo,
} from '../common/applies-to/applies-to';
import type {
  AwardType,
  EvaluationBasis,
  PipelineNode,
  PointsRuleConfig,
  RoundingSpec,
  RuleAttachment,
  RuleInput,
  RuleStatus,
} from './points-engine.types';
import {
  CreatePointsRuleDto,
  ListPointsRulesQueryDto,
  UpdatePointsRuleDto,
} from './dto/points-rule.dto';

/** The config fields a create/update supplies (everything except server-owned identity). */
interface RuleConfigInput {
  effectiveFrom: string;
  effectiveTo?: string | null;
  evaluationBasis?: EvaluationBasis;
  attachsTo: RuleAttachment;
  output: { awardType: AwardType; fieldId: string };
  rounding: RoundingSpec;
  // `unknown` (not RuleInput[]/PipelineNode[]) — the DTOs type these free-form to survive the global
  // pipe's enableImplicitConversion (see dto/points-rule.dto.ts); validateRule enforces the real shape.
  inputs: unknown;
  pipeline: unknown;
}

@Injectable()
export class PointsEngineService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── tenancy ──────────────────────────────────────────────────────────────

  /** READ scope: platform-wide (un-assumed GIFSY_ADMIN) sees all; everyone else pinned. */
  private readScope(user: JwtPayload): Prisma.PointsRuleWhereInput {
    return platformWide(user) ? {} : { clientId: user.clientId };
  }

  // ─── create / update drafts ─────────────────────────────────────────────────

  /**
   * Create a DRAFT rule. Omit dto.ruleId for a brand-new rule (version 1); pass an existing
   * ruleId to add the next draft version (version = max+1). Rejects a second open draft for a
   * ruleId. Validates the full config before persisting.
   */
  async createDraft(user: JwtPayload, dto: CreatePointsRuleDto): Promise<PointsRule> {
    const clientId = user.clientId;

    let ruleId = dto.ruleId?.trim();
    let version = 1;

    if (ruleId) {
      const existing = await this.prisma.pointsRule.findMany({
        where: { clientId, ruleId },
        select: { version: true, status: true, evaluationBasis: true },
      });
      if (existing.length === 0) {
        throw new NotFoundException(`No rule ${ruleId} exists for this tenant.`);
      }
      // Publishing a version archives the prior versions — so a version must never switch monthly ↔ quarterly
      // (that would retire the other kind of rule). A quarterly bonus is its own rule.
      assertSameBasis(existing, dto.evaluationBasis);
      if (existing.some((r) => r.status === 'draft')) {
        throw new ConflictException(
          `Rule ${ruleId} already has an open draft — edit or publish it before creating another.`,
        );
      }
      version = Math.max(...existing.map((r) => r.version)) + 1;
    } else {
      // Brand-new logical rule. ruleId is a distinct, caller-stable identity (separate from the
      // row's @default(cuid()) primary id), so mint one up-front.
      ruleId = `rule_${randomUUID()}`;
    }

    const config = this.buildConfig({ clientId, ruleId, version, status: 'draft' }, dto);
    this.assertValid(config);

    try {
      return await this.prisma.pointsRule.create({
        data: this.toCreateData(clientId, ruleId, version, 'draft', dto, user.sub),
      });
    } catch (e) {
      // Two concurrent createDraft on the same ruleId can both pass the version/open-draft check above
      // (check-then-act race); the (clientId,ruleId,version) unique turns the loser into a clean 409
      // instead of a raw 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A concurrent draft was just created for this rule — reload and retry.');
      }
      throw e;
    }
  }

  /**
   * Replace a DRAFT's config (whole-object). Only valid while status === 'draft'; a published
   * or archived row is immutable. Identity (ruleId/version) and status are not editable here.
   */
  async updateDraft(user: JwtPayload, id: string, dto: UpdatePointsRuleDto): Promise<PointsRule> {
    const row = await this.loadForWrite(user, id);
    if (row.status !== 'draft') {
      throw new BadRequestException(
        `Only a draft may be edited (rule is '${row.status}'). Create a new draft version instead.`,
      );
    }

    const config = this.buildConfig(
      { clientId: row.clientId, ruleId: row.ruleId, version: row.version, status: 'draft' },
      dto,
    );
    this.assertValid(config);
    // A draft may change monthly ↔ quarterly only while it is the rule's ONLY version.
    if (isQuarterBasis(row.evaluationBasis) !== isQuarterBasis(dto.evaluationBasis)) {
      const siblings = await this.prisma.pointsRule.findMany({
        where: { clientId: row.clientId, ruleId: row.ruleId, id: { not: row.id } },
        select: { version: true, status: true, evaluationBasis: true },
      });
      assertSameBasis(siblings, dto.evaluationBasis);
    }

    const { attachsTo } = dto;
    return this.prisma.pointsRule.update({
      where: { id: row.id },
      data: {
        effectiveFrom:   toDate(dto.effectiveFrom),
        effectiveTo:     dto.effectiveTo ? toDate(dto.effectiveTo) : null,
        evaluationBasis: dto.evaluationBasis ?? 'PERIOD_AGGREGATE',
        attachsTo:       attachsTo as unknown as Prisma.InputJsonValue,
        output:          dto.output as unknown as Prisma.InputJsonValue,
        rounding:        dto.rounding as unknown as Prisma.InputJsonValue,
        inputs:          dto.inputs as unknown as Prisma.InputJsonValue,
        pipeline:        dto.pipeline as unknown as Prisma.InputJsonValue,
        // Re-denormalize from attachsTo at every write.
        kpiCode:         attachsTo.kpiCode,
        program:         attachsTo.program ?? null,
        programCategory: attachsTo.programCategory ?? null,
      },
    });
  }

  // ─── publish ────────────────────────────────────────────────────────────────

  /**
   * Publish a DRAFT. Re-validates, then — atomically — supersedes any prior PUBLISHED version
   * of the same ruleId whose effective window overlaps this one (archives it + closes its
   * effectiveTo to the day before this rule's effectiveFrom) and flips this row to 'published'.
   * A published version is never mutated afterwards.
   */
  async publish(user: JwtPayload, id: string): Promise<PointsRule> {
    const row = await this.loadForWrite(user, id);
    if (row.status === 'published') {
      throw new BadRequestException('Rule is already published.');
    }
    if (row.status === 'archived') {
      throw new BadRequestException('An archived rule cannot be published.');
    }

    // Re-validate the stored config at the publish boundary (belt-and-braces: the draft could
    // have been written before a validator tightening).
    const config = this.rowToConfig(row);
    this.assertValid(config);
    // Reconcile referenced KPI codes against the live KpiDef master so a typo can't ship a rule that
    // silently credits 0 / skips every outlet (a draft is allowed to reference a not-yet-created KPI).
    await this.assertKpiCodesExist(row.clientId, config);

    const newFrom = row.effectiveFrom;
    const newTo = row.effectiveTo; // null = open-ended
    const supersedeBoundary = dayBeforeUtc(newFrom);

    return this.prisma.$transaction(async (tx) => {
      // Block a DIFFERENT logical rule already governing the SAME attachment (program × kpi) over an
      // overlapping window — two distinct ruleIds owning one attachment makes "which rule pays" ambiguous
      // (a null program/category is a wildcard, so it clashes with any specific one). Must archive first.
      const others = await tx.pointsRule.findMany({
        where: {
          clientId: row.clientId,
          status:   'published',
          kpiCode:  row.kpiCode,
          ruleId:   { not: row.ruleId },
          id:       { not: row.id },
        },
      });
      for (const other of others) {
        // A QUARTERLY rule and a MONTHLY rule on the same attachment never compete — they run in different
        // compute runs (YYYY-Qn vs YYYY-MM) — so only rules of the same kind clash.
        if (isQuarterBasis(other.evaluationBasis) !== isQuarterBasis(row.evaluationBasis)) continue;
        const progClash =
          other.program === row.program || other.program === null || row.program === null;
        const catClash =
          other.programCategory === row.programCategory ||
          other.programCategory === null ||
          row.programCategory === null;
        if (progClash && catClash && windowsOverlap(other.effectiveFrom, other.effectiveTo, newFrom, newTo)) {
          throw new ConflictException(
            `Another rule (${other.ruleId}) already governs ${row.program ?? 'all programs'} × ${row.kpiCode} ` +
              `for an overlapping period — archive it before publishing this one.`,
          );
        }
      }

      // Prior published versions of the SAME logical rule in the SAME tenant.
      const priors = await tx.pointsRule.findMany({
        where: {
          clientId: row.clientId,
          ruleId:   row.ruleId,
          status:   'published',
          id:       { not: row.id },
        },
      });

      // Never archive a rule of the OTHER kind (a monthly version must not retire a quarterly one, or vice versa).
      const otherKind = priors.filter((p) => isQuarterBasis(p.evaluationBasis) !== isQuarterBasis(row.evaluationBasis));
      if (otherKind.length > 0) {
        throw new BadRequestException(
          `This version is ${isQuarterBasis(row.evaluationBasis) ? 'quarterly' : 'monthly'} but version(s) ${otherKind
            .map((p) => `v${p.version}`)
            .join(', ')} of this rule are ${isQuarterBasis(row.evaluationBasis) ? 'monthly' : 'quarterly'} — publishing would retire them. Create a new rule for a quarterly bonus instead.`,
        );
      }
      for (const prior of priors) {
        if (!windowsOverlap(prior.effectiveFrom, prior.effectiveTo, newFrom, newTo)) continue;
        // Close the prior's window to just before the new one begins (keeps the historical,
        // already-credited window intact) and archive it.
        const closedTo =
          supersedeBoundary >= prior.effectiveFrom ? supersedeBoundary : prior.effectiveFrom;
        await tx.pointsRule.update({
          where: { id: prior.id },
          data: { status: 'archived', effectiveTo: closedTo },
        });
      }

      return tx.pointsRule.update({
        where: { id: row.id },
        data: { status: 'published' },
      });
    });
  }

  // ─── read ────────────────────────────────────────────────────────────────────

  /** List rules in the caller's tenant scope, newest-effective first. */
  async list(user: JwtPayload, q: ListPointsRulesQueryDto): Promise<PointsRule[]> {
    return this.prisma.pointsRule.findMany({
      where: {
        ...this.readScope(user),
        ...(q.status ? { status: q.status } : {}),
        ...(q.ruleId ? { ruleId: q.ruleId } : {}),
        ...(q.program ? { program: q.program } : {}),
        ...(q.kpiCode ? { kpiCode: q.kpiCode } : {}),
      },
      orderBy: [
        { ruleId: 'asc' },
        { version: 'desc' },
      ],
    });
  }

  /** Load one rule by id, tenant-scoped. 404 if not in the caller's scope. */
  async get(user: JwtPayload, id: string): Promise<PointsRule> {
    const row = await this.prisma.pointsRule.findFirst({
      where: { id, ...this.readScope(user) },
    });
    if (!row) throw new NotFoundException('Rule not found.');
    return row;
  }

  /**
   * Resolve the single EFFECTIVE published rule for an attachment at a period date. Used by the
   * (later-wave) compute service — takes clientId directly (no JwtPayload), so callers MUST pass
   * an already-scoped clientId.
   *
   * Matching: status='published', kpiCode exact, program/programCategory match the given value
   * OR are null (wildcard = "any"), and the period date falls inside [effectiveFrom, effectiveTo]
   * (effectiveTo null = open-ended). When several match, prefer the most SPECIFIC (non-wildcard
   * program, then programCategory), then the latest effectiveFrom, then the highest version.
   */
  async getActiveForAttachment(
    clientId: string,
    program: string | null | undefined,
    programCategory: string | null | undefined,
    kpiCode: string,
    periodDate: Date,
    /** 'MONTH' (default — every existing caller) resolves monthly rules only; 'QUARTER' resolves quarterly rules only. */
    kind: 'MONTH' | 'QUARTER' = 'MONTH',
  ): Promise<PointsRule | null> {
    const all = await this.prisma.pointsRule.findMany({
      where: {
        clientId,
        status:        'published',
        kpiCode,
        effectiveFrom: { lte: periodDate },
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodDate } }] },
          { OR: [{ program: program ?? null }, { program: null }] },
          { OR: [{ programCategory: programCategory ?? null }, { programCategory: null }] },
        ],
      },
      // Deterministic pre-sort (the JS rank below is authoritative, but this makes the input order stable).
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }, { ruleId: 'asc' }],
    });
    // Filtered in JS (not in the query) so the monthly lookup's query is unchanged: a monthly run never resolves a
    // quarterly rule and vice versa.
    const candidates = (all ?? []).filter((r) => isQuarterBasis(r.evaluationBasis) === (kind === 'QUARTER'));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Rank by specificity → recency → version. Done in JS (Postgres NULL-ordering makes a pure
    // orderBy "prefer non-null" fragile); the candidate set per (tenant, kpi, date) is small.
    return candidates
      .slice()
      .sort((a, b) => {
        const spec = specificity(b) - specificity(a);
        if (spec !== 0) return spec;
        const from = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
        if (from !== 0) return from;
        const ver = b.version - a.version;
        if (ver !== 0) return ver;
        // Deterministic final tiebreak so two same-specificity/date/version rules never resolve by DB
        // row order (would make "which rule pays" nondeterministic). publish() already blocks this clash,
        // but defense-in-depth keeps resolution total-ordered.
        return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
      })[0];
  }

  /**
   * QUARTER resolution (audit fix 2026-11-26): a published QUARTERLY rule applies to a quarter when its effective
   * window OVERLAPS the quarter [qStart, qEnd] (not only when it is effective on the first day). Most specific
   * attachment wins; if MORE THAN ONE published version / rule overlaps at that specificity the result is a
   * `conflict` naming them — never a silent pick (the compute row becomes an ERROR with that text).
   */
  async getQuarterRuleForAttachment(
    clientId: string,
    program: string | null | undefined,
    programCategory: string | null | undefined,
    kpiCode: string,
    qStart: Date,
    qEnd: Date,
  ): Promise<{ rule: PointsRule | null; conflict?: string; notCovering?: string }> {
    const all = await this.prisma.pointsRule.findMany({
      where: {
        clientId,
        status: 'published',
        kpiCode,
        evaluationBasis: 'QUARTER',
        effectiveFrom: { lte: qEnd },
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: qStart } }] },
          { OR: [{ program: program ?? null }, { program: null }] },
          { OR: [{ programCategory: programCategory ?? null }, { programCategory: null }] },
        ],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }, { ruleId: 'asc' }],
    });
    const overlapping = (all ?? []).filter((r) => isQuarterBasis(r.evaluationBasis));
    if (overlapping.length === 0) return { rule: null };
    // OWNER DECISION (2026-11-26): a quarterly version pays a quarter only if it covers the WHOLE quarter —
    // effectiveFrom ≤ the quarter's first day AND (effectiveTo open or ≥ the quarter's last day). A version starting
    // (or ending) mid-quarter does NOT pay that quarter; the row says exactly why and how to fix it.
    const covering = overlapping.filter((r) => r.effectiveFrom <= qStart && (r.effectiveTo === null || r.effectiveTo >= qEnd));
    if (covering.length === 0) {
      return { rule: null, notCovering: overlapping.map((r) => notCoveringReason(r, qStart, qEnd)).join(' · ') };
    }
    const top = Math.max(...covering.map(specificity));
    const best = covering.filter((r) => specificity(r) === top);
    if (best.length === 1) return { rule: best[0] };
    return {
      rule: null,
      conflict:
        `More than one published quarterly rule version covers this whole quarter for ${kpiCode}: ` +
        best.map((r) => `${r.ruleId} v${r.version} (${longDay(r.effectiveFrom)} → ${r.effectiveTo ? longDay(r.effectiveTo) : 'open-ended'})`).join('; ') +
        ' — archive one so exactly one version covers the quarter.',
    };
  }

  // ─── archive ──────────────────────────────────────────────────────────────────

  /** Archive a rule (draft or published) — removes it from active resolution. Idempotent. */
  async archive(user: JwtPayload, id: string): Promise<PointsRule> {
    const row = await this.loadForWrite(user, id);
    if (row.status === 'archived') return row;
    return this.prisma.pointsRule.update({
      where: { id: row.id },
      data: { status: 'archived' },
    });
  }

  // ─── internals ─────────────────────────────────────────────────────────────────

  /** Load a row for a mutation, tenant-scoped. 404 if not in the caller's scope. */
  private async loadForWrite(user: JwtPayload, id: string): Promise<PointsRule> {
    const row = await this.prisma.pointsRule.findFirst({
      where: { id, ...this.readScope(user) },
    });
    if (!row) throw new NotFoundException('Rule not found.');
    return row;
  }

  /** Run the shared contract validator; throw 400 with the collected errors if any. */
  private assertValid(config: PointsRuleConfig): void {
    const errors = validateRule(config);
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Invalid points rule', errors });
    }
  }

  /**
   * Reconcile every KPI code a rule references against the tenant's KpiDef master. A rule's attachment
   * KPI and its achievement/target/pct input sources must be REAL, enabled KpiDef codes: a typo (wrong
   * case, stray char) otherwise resolves to an ABSENT value at compute time and — depending on the
   * input's nullAs — silently credits 0 or SKIPs every outlet, with no error surfaced. We enforce this
   * at the PUBLISH boundary (a draft may legitimately be mid-construction, referencing a KPI not yet
   * created). `segment:` sources are outlet attributes, not KPIs, so they are excluded.
   */
  private async assertKpiCodesExist(clientId: string, config: PointsRuleConfig): Promise<void> {
    const refs = collectKpiRefs(config);
    if (refs.length === 0) return;
    const defs = await this.prisma.kpiDef.findMany({
      where: { clientId, enabled: true, code: { in: refs } },
      select: { code: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
    });
    const known = new Set(defs.map((d) => d.code));
    const missing = refs.filter((c) => !known.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `These KPI codes are not enabled KPIs for this tenant: ${missing.join(', ')}. ` +
          'Use existing KPI codes from the Target Field Configuration — a typo would silently credit 0.',
      );
    }

    // APPLIES-TO D5: only the rule's ATTACHED KPI decides which outlets the rule pays (compute SKIPs
    // an outlet where the attached KPI is out of scope). Bonus inputs (pct:/target:/achievement:/
    // kpiCode) are just values read per outlet — a disjoint input scope is legitimate: compute masks
    // each input KPI's values by THAT KPI's scope for the outlet (points-compute.service maskByScope),
    // so an out-of-scope input reads as absent → the input's nullAs. They are NOT checked here. An
    // unscoped attached KPI or an any-program rule always passes → unscoped tenants (Deoleo) are unaffected.
    const attached = defs.find((d) => d.code === config.attachsTo?.kpiCode);
    if (!attached) return;
    const kpiScope = kpiAppliesTo(attached);
    if (isUnscoped(kpiScope)) return;

    // Case-only mismatch: the engine matches rule segments to OUTLET values EXACTLY (case-sensitive),
    // while the KPI scope (and the overlap check below) match case-insensitively. So a rule value that
    // matches NO live outlet value exactly but matches one ignoring case would pass the overlap check
    // yet never pay → reject, naming the LIVE outlet spelling(s) (what the engine actually compares
    // against — not the KPI-scope / settings-list spelling, which may differ). A value that exactly
    // matches a live outlet value is never rejected. Checked on the facets the KPI scopes.
    const segs = ruleSegmentValues(config).filter((s) => s.values.length > 0 && kpiScope[s.facet].length > 0);
    if (segs.length > 0) {
      const live = await this.liveOutletSpellings(clientId, new Set(segs.map((s) => s.facet)));
      const caseIssues: string[] = [];
      for (const { facet, label, values } of segs) {
        const liveVals = live[facet];
        for (const v of values) {
          const t = v.trim();
          if (liveVals.includes(t)) continue;
          const ci = liveVals.filter((s) => s.toUpperCase() === t.toUpperCase());
          if (ci.length > 0) {
            caseIssues.push(
              `Rule segment ${label} "${v}" must be spelled exactly ${ci.map((s) => `"${s}"`).join(' or ')}`,
            );
          }
        }
      }
      if (caseIssues.length > 0) {
        throw new BadRequestException(
          `${caseIssues.join('; ')} (as stored on this tenant's outlets) — rule segments are matched to outlet values case-sensitively, so KPI ${attached.code}'s outlets would never earn.`,
        );
      }
    }

    // Disjoint: the rule's program / programCategory (and hard outlet-type / program filters) can never
    // overlap the attached KPI's scope → every outlet would be SKIPPED at compute time.
    if (intersectAppliesTo(ruleAppliesTo(config), kpiScope) === null) {
      const parts = [
        kpiScope.outletTypes.length ? `outlet types ${kpiScope.outletTypes.join('/')}` : '',
        kpiScope.programs.length ? `programs ${kpiScope.programs.join('/')}` : '',
        kpiScope.subPrograms.length ? `sub-programs ${kpiScope.subPrograms.join('/')}` : '',
      ].filter(Boolean);
      throw new BadRequestException(
        `This rule's program / sub-program / outlet type never overlaps the scope of its KPI ${attached.code} (applies to ${parts.join('; ')}). ` +
          'No outlet could ever earn under it — change the rule attachment or the KPI scope.',
      );
    }
  }

  /**
   * Distinct LIVE (non-deleted) outlet spellings per facet for a tenant — what the engine's exact
   * segment match compares against: outlet type code, programName, programCategory. Only the requested
   * facets are queried (one DISTINCT query each).
   */
  private async liveOutletSpellings(
    clientId: string,
    facets: Set<keyof AppliesTo>,
  ): Promise<Record<keyof AppliesTo, string[]>> {
    const out: Record<keyof AppliesTo, string[]> = { outletTypes: [], programs: [], subPrograms: [] };
    const base = { clientId, deletedAt: null };
    const uniq = (xs: Array<string | null | undefined>) =>
      [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))];
    await Promise.all([
      facets.has('outletTypes')
        ? this.prisma.outlet
            .findMany({ where: base, distinct: ['outletTypeId'], select: { outletType: { select: { code: true } } } })
            .then((rows) => { out.outletTypes = uniq(rows.map((r) => r.outletType?.code)); })
        : null,
      facets.has('programs')
        ? this.prisma.outlet
            .findMany({ where: base, distinct: ['programName'], select: { programName: true } })
            .then((rows) => { out.programs = uniq(rows.map((r) => r.programName)); })
        : null,
      facets.has('subPrograms')
        ? this.prisma.outlet
            .findMany({ where: base, distinct: ['programCategory'], select: { programCategory: true } })
            .then((rows) => { out.subPrograms = uniq(rows.map((r) => r.programCategory)); })
        : null,
    ]);
    return out;
  }

  /** Build a PointsRuleConfig from server-owned identity + a create/update DTO. */
  private buildConfig(
    identity: { clientId: string; ruleId: string; version: number; status: RuleStatus },
    dto: RuleConfigInput,
  ): PointsRuleConfig {
    return {
      ruleId:          identity.ruleId,
      tenantId:        identity.clientId,
      version:         identity.version,
      status:          identity.status,
      effectiveFrom:   dto.effectiveFrom,
      effectiveTo:     dto.effectiveTo ?? null,
      attachsTo:       dto.attachsTo,
      evaluationBasis: dto.evaluationBasis ?? 'PERIOD_AGGREGATE',
      output:          dto.output,
      rounding:        dto.rounding,
      // Cast the free-form (`unknown`) config into the typed shape — validateRule then enforces it.
      inputs:          dto.inputs as RuleInput[],
      pipeline:        dto.pipeline as PipelineNode[],
    };
  }

  /** Reconstruct a PointsRuleConfig from a stored row (Date → YYYY-MM-DD). */
  private rowToConfig(row: PointsRule): PointsRuleConfig {
    return {
      ruleId:          row.ruleId,
      tenantId:        row.clientId,
      version:         row.version,
      status:          row.status as RuleStatus,
      effectiveFrom:   formatDate(row.effectiveFrom),
      effectiveTo:     row.effectiveTo ? formatDate(row.effectiveTo) : null,
      attachsTo:       row.attachsTo as unknown as RuleAttachment,
      evaluationBasis: row.evaluationBasis as EvaluationBasis,
      output:          row.output as unknown as { awardType: AwardType; fieldId: string },
      rounding:        row.rounding as unknown as RoundingSpec,
      inputs:          row.inputs as unknown as RuleInput[],
      pipeline:        row.pipeline as unknown as PipelineNode[],
    };
  }

  /** Map a create DTO to the Prisma create payload, denormalizing the indexed columns. */
  private toCreateData(
    clientId: string,
    ruleId: string,
    version: number,
    status: RuleStatus,
    dto: CreatePointsRuleDto,
    createdBy: string | undefined,
  ): Prisma.PointsRuleCreateInput {
    const { attachsTo } = dto;
    return {
      ruleId,
      clientId,
      version,
      status,
      effectiveFrom:   toDate(dto.effectiveFrom),
      effectiveTo:     dto.effectiveTo ? toDate(dto.effectiveTo) : null,
      evaluationBasis: dto.evaluationBasis ?? 'PERIOD_AGGREGATE',
      attachsTo:       attachsTo as unknown as Prisma.InputJsonValue,
      output:          dto.output as unknown as Prisma.InputJsonValue,
      rounding:        dto.rounding as unknown as Prisma.InputJsonValue,
      inputs:          dto.inputs as unknown as Prisma.InputJsonValue,
      pipeline:        dto.pipeline as unknown as Prisma.InputJsonValue,
      kpiCode:         attachsTo.kpiCode,
      program:         attachsTo.program ?? null,
      programCategory: attachsTo.programCategory ?? null,
      createdBy:       createdBy ?? null,
    };
  }
}

// ─── pure helpers ───────────────────────────────────────────────────────────────

const MONTH_LONG = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "15 Nov 2026" (UTC calendar day of a @db.Date). */
export function longDay(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Why an overlapping quarterly version does not pay a quarter (it starts after / ends before it), with the fix. */
export function notCoveringReason(r: Pick<PointsRule, 'ruleId' | 'version' | 'effectiveFrom' | 'effectiveTo'>, qStart: Date, qEnd: Date): string {
  const who = `${r.ruleId} v${r.version}`;
  if (r.effectiveFrom > qStart) {
    return `Rule ${who} starts ${longDay(r.effectiveFrom)}, after the quarter began ${longDay(qStart)} — back-date its effective-from to ${longDay(qStart)} to cover this quarter.`;
  }
  return `Rule ${who} ends ${longDay(r.effectiveTo!)}, before the quarter ends ${longDay(qEnd)} — a quarterly rule must be effective for the whole quarter.`;
}

/** Refuse a version whose monthly/quarterly kind differs from the rule's other versions. */
function assertSameBasis(
  others: Array<{ version: number; evaluationBasis: string | null }>,
  basis: string | null | undefined,
): void {
  const clash = others.filter((o) => isQuarterBasis(o.evaluationBasis) !== isQuarterBasis(basis));
  if (clash.length === 0) return;
  throw new BadRequestException(
    `A rule cannot switch between monthly and quarterly across versions (version(s) ${clash
      .map((c) => `v${c.version}`)
      .join(', ')} are ${isQuarterBasis(basis) ? 'monthly' : 'quarterly'}). Create a new rule for a quarterly bonus.`,
  );
}

/** More specific attachment ranks higher (exact program + category beats wildcards). */
function specificity(r: PointsRule): number {
  return (r.program != null ? 2 : 0) + (r.programCategory != null ? 1 : 0);
}

/** Parse a YYYY-MM-DD business date to a UTC-midnight Date (matches @db.Date storage). */
function toDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Format a stored @db.Date back to YYYY-MM-DD. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every KPI code a rule references: its attachment KPI plus each input's achievement source (`kpiCode`
 * or `achievement:CODE`), `target:CODE`, and `pct:CODE`. Mirrors the evaluator's source parsing
 * (points-engine.helper resolveRaw). `segment:*` is an outlet attribute, not a KPI, so it is excluded.
 */
/**
 * The outlets a rule can EVER pay, as an AppliesTo (APPLIES-TO D5): its attachment program /
 * programCategory (null = any), narrowed by any HARD (`onFail: 'zero'`) segmentFilter on
 * `outletType` / `program` / `programCategory` (a soft skipNode/passthrough filter restricts nothing).
 * Several hard filters on one field intersect. Used only for the publish-time disjointness check.
 */
export function ruleAppliesTo(config: PointsRuleConfig): AppliesTo {
  let scope: AppliesTo = normalizeAppliesTo({
    programs: config.attachsTo?.program ? [config.attachsTo.program] : [],
    subPrograms: config.attachsTo?.programCategory ? [config.attachsTo.programCategory] : [],
  });
  const facetOf: Record<string, keyof AppliesTo> = {
    outlettype: 'outletTypes',
    program: 'programs',
    programcategory: 'subPrograms',
  };
  for (const node of config.pipeline ?? []) {
    if (node.type !== 'segmentFilter' || node.onFail !== 'zero') continue;
    const facet = facetOf[String(node.field ?? '').trim().toLowerCase()];
    if (!facet || !Array.isArray(node.allow) || node.allow.length === 0) continue;
    const filterScope: Partial<AppliesTo> = { [facet]: node.allow };
    const next = intersectAppliesTo(scope, filterScope);
    // A self-contradictory rule (its own filters disjoint) is not this check's concern — keep the
    // last non-empty scope so the KPI check still runs on something meaningful.
    if (next) scope = next;
  }
  return scope;
}

/**
 * The raw (un-normalised) segment values a rule matches outlets on, per AppliesTo facet — the same
 * sources ruleAppliesTo reads: attachment program / programCategory + every HARD segmentFilter allow
 * list on outletType / program / programCategory. Used for the publish-time case-only check.
 */
export function ruleSegmentValues(
  config: PointsRuleConfig,
): Array<{ facet: keyof AppliesTo; label: string; values: string[] }> {
  const out: Record<keyof AppliesTo, string[]> = { outletTypes: [], programs: [], subPrograms: [] };
  if (config.attachsTo?.program) out.programs.push(config.attachsTo.program);
  if (config.attachsTo?.programCategory) out.subPrograms.push(config.attachsTo.programCategory);
  const facetOf: Record<string, keyof AppliesTo> = {
    outlettype: 'outletTypes',
    program: 'programs',
    programcategory: 'subPrograms',
  };
  for (const node of config.pipeline ?? []) {
    if (node.type !== 'segmentFilter' || node.onFail !== 'zero') continue;
    const facet = facetOf[String(node.field ?? '').trim().toLowerCase()];
    if (!facet || !Array.isArray(node.allow)) continue;
    for (const v of node.allow) if (typeof v === 'string' && v.trim()) out[facet].push(v);
  }
  return [
    { facet: 'outletTypes', label: 'outlet type', values: out.outletTypes },
    { facet: 'programs', label: 'program', values: out.programs },
    { facet: 'subPrograms', label: 'sub-program', values: out.subPrograms },
  ];
}

function collectKpiRefs(config: PointsRuleConfig): string[] {
  const out = new Set<string>();
  if (config.attachsTo?.kpiCode) out.add(config.attachsTo.kpiCode);
  for (const inp of config.inputs ?? []) {
    if (inp.kpiCode) {
      out.add(inp.kpiCode);
      continue;
    }
    if (inp.source) {
      const idx = inp.source.indexOf(':');
      const kind = idx >= 0 ? inp.source.slice(0, idx) : inp.source;
      const key = idx >= 0 ? inp.source.slice(idx + 1) : '';
      if (key && (kind === 'achievement' || kind === 'target' || kind === 'pct')) out.add(key);
    }
  }
  return [...out];
}

/** The calendar day before `d` (UTC), used to close a superseded rule's window. */
function dayBeforeUtc(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() - 1);
  return out;
}

/**
 * Do two half-open-ish business windows overlap? A null `to` means open-ended (∞). Treated as
 * inclusive on both ends (two rules effective the SAME single day overlap).
 */
function windowsOverlap(
  aFrom: Date,
  aTo: Date | null,
  bFrom: Date,
  bTo: Date | null,
): boolean {
  const aEnd = aTo ? aTo.getTime() : Number.POSITIVE_INFINITY;
  const bEnd = bTo ? bTo.getTime() : Number.POSITIVE_INFINITY;
  return aFrom.getTime() <= bEnd && bFrom.getTime() <= aEnd;
}
