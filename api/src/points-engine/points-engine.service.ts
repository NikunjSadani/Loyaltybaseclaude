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
import type {
  AwardType,
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
  evaluationBasis?: 'PERIOD_AGGREGATE';
  attachsTo: RuleAttachment;
  output: { awardType: AwardType; fieldId: string };
  rounding: RoundingSpec;
  inputs: RuleInput[];
  pipeline: PipelineNode[];
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
        select: { version: true, status: true },
      });
      if (existing.length === 0) {
        throw new NotFoundException(`No rule ${ruleId} exists for this tenant.`);
      }
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
  ): Promise<PointsRule | null> {
    const candidates = await this.prisma.pointsRule.findMany({
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
      select: { code: true },
    });
    const known = new Set(defs.map((d) => d.code));
    const missing = refs.filter((c) => !known.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `These KPI codes are not enabled KPIs for this tenant: ${missing.join(', ')}. ` +
          'Use existing KPI codes from the Target Field Configuration — a typo would silently credit 0.',
      );
    }
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
      inputs:          dto.inputs,
      pipeline:        dto.pipeline,
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
      evaluationBasis: row.evaluationBasis as 'PERIOD_AGGREGATE',
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
