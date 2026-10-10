import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveCapabilities } from '../common/loyalty-capabilities.helper';
import { resolveEmployeeReadContext } from '../common/employee-context.helper';
import { ensureEmployeeAccount, ensureEmployeeWallet } from '../common/reward-account.helper';
import {
  CONTEST_SETTABLE_STATUSES,
  CreateContestDto,
  CreditContestBonusDto,
  ListContestsQueryDto,
  SetContestStatusDto,
  UpdateContestDto,
} from './dto/contests.dto';

/**
 * Employee Rewards Phase C — CONTESTS (ADMIN-DESIGN §5.3). MANUAL only: an admin creates +
 * schedules a contest, then MANUALLY credits the bonus to winners (or the whole eligible set).
 * There is NO auto-validation from performance data (deferred).
 *
 * ═══ MONEY DESIGN (money-adjacent — the bonus credits employee wallets) ═══════════════════
 *  1. COEXISTS WITH THE MONTHLY POINTS BATCH. The employee points rail (confirmEmployeeBatch)
 *     enforces F2: at most ONE confirmed sourceKind='EMPLOYEE_UPLOAD' batch per period. A contest
 *     bonus must NOT be blocked by that, so a contest bonus does NOT go through
 *     createEmployeeBatch/confirmEmployeeBatch and creates NO CreditBatch at all. Each winner is
 *     credited DIRECTLY via the audited primitive WalletService.creditEarnForAccount (the SAME
 *     applyMovement whole-Int EARN write-path the points rail uses) with referenceType CONTEST.
 *     Because it never touches the CreditBatch table, the EMPLOYEE_UPLOAD F2 period guard never
 *     sees it — the two rails are independent and coexist cleanly within a month.
 *  2. CREDITED ONCE (idempotency / no double-credit). A contest is credited at most once. Inside a
 *     single $transaction we GUARD-CLAIM the contest with a conditional updateMany
 *     ({ id, status ∈ creditable, bonusCreditedAt: null } → status CREDITED + stamp
 *     bonusCreditedAt/By) and require count===1 BEFORE any wallet write. A racing/second credit
 *     sees count 0 (status already CREDITED / bonusCreditedAt non-null) and throws — so no winner
 *     is double-credited. Each winner resolves the audited way (employeeCode → active SalesUser →
 *     ensureEmployeeAccount → ensureEmployeeWallet → creditEarnForAccount); an unresolved/inactive
 *     winner is SKIPPED WITH A REASON (never silently dropped), mirroring confirmEmployeeBatch. The
 *     EMPLOYEE-earner tenant gate (assertEmployeeEarner) fail-safely rejects a trade tenant.
 *
 * The live trade credit paths (createBatch/confirmBatch/creditEarn) and the employee
 * confirmEmployeeBatch are NOT touched — this is a wholly additive, separate rail.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class ContestsService {
  private readonly logger = new Logger(ContestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** Statuses from which a contest bonus may be credited. */
  private static readonly CREDITABLE_STATUSES: ContestStatus[] = [
    ContestStatus.ACTIVE,
    ContestStatus.ENDED,
  ];

  /** Statuses in which a contest may still be edited (content locked once it goes live). */
  private static readonly EDITABLE_STATUSES: ContestStatus[] = [
    ContestStatus.DRAFT,
    ContestStatus.SCHEDULED,
  ];

  /**
   * Allowed admin status transitions (schedule). CREDITED is reached ONLY via credit-bonus and
   * CANCELLED only via cancel() — neither is a target here. ENDED/CREDITED/CANCELLED are terminal
   * for the schedule endpoint.
   */
  private static readonly STATUS_TRANSITIONS: Record<ContestStatus, ContestStatus[]> = {
    [ContestStatus.DRAFT]: [ContestStatus.SCHEDULED, ContestStatus.ACTIVE],
    [ContestStatus.SCHEDULED]: [ContestStatus.ACTIVE, ContestStatus.DRAFT],
    [ContestStatus.ACTIVE]: [ContestStatus.ENDED],
    [ContestStatus.ENDED]: [ContestStatus.ACTIVE],
    [ContestStatus.CREDITED]: [],
    [ContestStatus.CANCELLED]: [],
  };

  /**
   * Fail-safe EMPLOYEE-earner tenant gate (identical rule to CreditsService.assertEmployeeEarner).
   * Resolves the tenant's capability set from loyaltyType + features; an unknown/absent loyaltyType
   * resolves to TRADE/OUTLET, so a trade tenant can NEVER create or credit a contest.
   */
  private async assertEmployeeEarner(clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { loyaltyType: true, features: true },
    });
    const capabilities = resolveCapabilities(
      client?.loyaltyType as string | null | undefined,
      (client?.features ?? null) as Record<string, unknown> | null,
    );
    if (capabilities.earnerModel !== 'EMPLOYEE') {
      throw new BadRequestException('Contests apply to employee-rewards tenants only.');
    }
  }

  // ─── Admin CRUD ──────────────────────────────────────────────────────────────

  /** POST /v1/admin/contests — create a DRAFT contest (employee-earner tenants only). */
  async createContest(user: JwtPayload, dto: CreateContestDto) {
    await this.assertEmployeeEarner(user.clientId);
    const { startDate, endDate } = this.parseDuration(dto.startDate, dto.endDate);

    return this.prisma.contest.create({
      data: {
        clientId: user.clientId,
        name: dto.name.trim(),
        bannerUrl: dto.bannerUrl?.trim() || null,
        description: dto.description?.trim() || null,
        startDate,
        endDate,
        eligibleRoleCodes: this.normalizeCodes(dto.eligibleRoleCodes),
        eligibleRegions: this.normalizeCodes(dto.eligibleRegions),
        bonusPoints: dto.bonusPoints ?? 0,
        status: ContestStatus.DRAFT,
      },
    });
  }

  /** PATCH /v1/admin/contests/:id — edit, ONLY while DRAFT/SCHEDULED. */
  async updateContest(user: JwtPayload, id: string, dto: UpdateContestDto) {
    await this.assertEmployeeEarner(user.clientId);
    const contest = await this.requireContest(user.clientId, id);
    if (!ContestsService.EDITABLE_STATUSES.includes(contest.status)) {
      throw new BadRequestException(
        `A ${contest.status} contest can no longer be edited (only DRAFT or SCHEDULED).`,
      );
    }

    // Validate the resulting duration (merge supplied dates over the stored ones).
    const startStr = dto.startDate ?? contest.startDate.toISOString();
    const endStr = dto.endDate ?? contest.endDate.toISOString();
    const { startDate, endDate } = this.parseDuration(startStr, endStr);

    const data: Prisma.ContestUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.bannerUrl !== undefined) data.bannerUrl = dto.bannerUrl.trim() || null;
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.startDate !== undefined) data.startDate = startDate;
    if (dto.endDate !== undefined) data.endDate = endDate;
    if (dto.eligibleRoleCodes !== undefined) data.eligibleRoleCodes = this.normalizeCodes(dto.eligibleRoleCodes);
    if (dto.eligibleRegions !== undefined) data.eligibleRegions = this.normalizeCodes(dto.eligibleRegions);
    if (dto.bonusPoints !== undefined) data.bonusPoints = dto.bonusPoints;

    // Guarded update so a concurrent credit/status move cannot slip an edit past the gate: only
    // rows STILL in an editable status are updated.
    const claimed = await this.prisma.contest.updateMany({
      where: { id, clientId: user.clientId, status: { in: ContestsService.EDITABLE_STATUSES } },
      data,
    });
    if (claimed.count === 0) {
      throw new ConflictException('Contest is no longer editable (its status changed concurrently).');
    }
    return this.requireContest(user.clientId, id);
  }

  /** GET /v1/admin/contests — tenant-scoped list with optional status filter + pagination. */
  async listContests(user: JwtPayload, q: ListContestsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.ContestWhereInput = { clientId: user.clientId };
    if (q.status) where.status = q.status as ContestStatus;

    const [contests, total] = await Promise.all([
      this.prisma.contest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.contest.count({ where }),
    ]);
    return { contests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** GET /v1/admin/contests/:id — one contest (tenant-scoped). */
  async getContest(user: JwtPayload, id: string) {
    return this.requireContest(user.clientId, id);
  }

  /** POST /v1/admin/contests/:id/status — guarded status transition (schedule / advance). */
  async setStatus(user: JwtPayload, id: string, dto: SetContestStatusDto) {
    await this.assertEmployeeEarner(user.clientId);
    const target = dto.status as ContestStatus;
    if (!CONTEST_SETTABLE_STATUSES.includes(dto.status)) {
      throw new BadRequestException(`Status ${dto.status} cannot be set directly.`);
    }
    const contest = await this.requireContest(user.clientId, id);
    const allowed = ContestsService.STATUS_TRANSITIONS[contest.status] ?? [];
    if (contest.status === target) return contest; // idempotent no-op
    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `Cannot move a ${contest.status} contest to ${target}.`,
      );
    }
    const claimed = await this.prisma.contest.updateMany({
      where: { id, clientId: user.clientId, status: contest.status },
      data: { status: target },
    });
    if (claimed.count === 0) {
      throw new ConflictException('Contest status changed concurrently; retry.');
    }
    return this.requireContest(user.clientId, id);
  }

  /** POST /v1/admin/contests/:id/cancel — cancel a contest (not once ENDED/CREDITED). */
  async cancelContest(user: JwtPayload, id: string) {
    await this.assertEmployeeEarner(user.clientId);
    const contest = await this.requireContest(user.clientId, id);
    const cancellable: ContestStatus[] = [
      ContestStatus.DRAFT,
      ContestStatus.SCHEDULED,
      ContestStatus.ACTIVE,
    ];
    if (!cancellable.includes(contest.status)) {
      throw new BadRequestException(`A ${contest.status} contest cannot be cancelled.`);
    }
    const claimed = await this.prisma.contest.updateMany({
      where: { id, clientId: user.clientId, status: { in: cancellable } },
      data: { status: ContestStatus.CANCELLED },
    });
    if (claimed.count === 0) {
      throw new ConflictException('Contest status changed concurrently; retry.');
    }
    return this.requireContest(user.clientId, id);
  }

  // ─── Manual bonus credit (money-adjacent — DUAL-audit-worthy) ─────────────────

  /**
   * POST /v1/admin/contests/:id/credit-bonus — MANUALLY credit the bonus ONCE.
   *
   * `winnerEmployeeCodes` absent/empty = the WHOLE eligible set (active employees matching the
   * contest's eligibleRoleCodes/eligibleRegions — empty list = all). Present = that explicit list,
   * still INTERSECTED with eligibility. Each creditable winner is credited bonusPoints via the
   * audited account-first primitive; an unresolved/inactive/ineligible winner is skipped-with-reason.
   *
   * Once-only: a guarded conditional updateMany claims the contest (creditable status +
   * bonusCreditedAt null → CREDITED) and must return count===1 BEFORE any wallet write; a racing
   * second credit gets count 0 and throws. A run that would credit NOBODY (every winner skipped)
   * does NOT claim the contest and changes no wallet — it returns the skip list and leaves the
   * contest creditable (safe + re-runnable; nothing was credited). Independent of the EMPLOYEE_UPLOAD
   * batch rail: NO CreditBatch is created, so the F2 one-confirmed-batch-per-period guard is untouched.
   */
  async creditBonus(user: JwtPayload, id: string, dto: CreditContestBonusDto) {
    await this.assertEmployeeEarner(user.clientId);

    const contest = await this.requireContest(user.clientId, id);
    if (contest.status === ContestStatus.CREDITED || contest.bonusCreditedAt) {
      throw new BadRequestException('This contest bonus has already been credited.');
    }
    if (!ContestsService.CREDITABLE_STATUSES.includes(contest.status)) {
      throw new BadRequestException(
        `A ${contest.status} contest bonus cannot be credited (must be ACTIVE or ENDED).`,
      );
    }
    if (contest.bonusPoints <= 0) {
      throw new BadRequestException('This contest has no bonus points to credit.');
    }
    // Money audit A, Finding 1 — enforce the SAME per-tenant points safety cap the monthly upload rail
    // applies (credits.service.assertWithinSafetyCaps). Each winner is credited `bonusPoints`, so the
    // per-credit value must not exceed `safetyCapPoints`; without this, an unbounded bonus could
    // mass-over-credit every eligible employee. Authoritative at credit time (the cap can change).
    const { creditsPayouts } = await this.tenantSettings.getEffectiveSettings(user.clientId);
    if (contest.bonusPoints > creditsPayouts.safetyCapPoints) {
      throw new BadRequestException(
        `Contest bonus (${contest.bonusPoints}) exceeds the tenant points safety cap ` +
          `(${creditsPayouts.safetyCapPoints}). Lower the bonus or raise the cap in settings.`,
      );
    }

    // Explicit winner list (if any), de-duped + trimmed. Empty/absent → whole eligible set.
    const explicit = this.normalizeCodes(dto.winnerEmployeeCodes);
    const explicitSet = explicit.length ? new Set(explicit) : null;

    const skipped: { employeeCode: string; reason: string }[] = [];
    let creditedCount = 0;
    let pointsCreditedTotal = 0;

    const result = await this.prisma.$transaction(
      async (tx) => {
        // ── Resolve the eligible, ACTIVE winner set (tenant-scoped) ────────────────────────────
        // Eligibility = (eligibleRoleCodes empty OR level code ∈ it) AND (eligibleRegions empty OR
        // region ∈ it). An explicit winner list is INTERSECTED (employeeCode ∈ list). Active =
        // deletedAt null + isActive true (mirrors confirmEmployeeBatch's active-only credit rule).
        const where: Prisma.SalesUserWhereInput = {
          clientId: user.clientId,
          deletedAt: null,
          isActive: true,
        };
        if (contest.eligibleRoleCodes.length > 0) {
          where.hierarchyLevel = { code: { in: contest.eligibleRoleCodes } };
        }
        if (contest.eligibleRegions.length > 0) {
          where.region = { in: contest.eligibleRegions };
        }
        if (explicitSet) {
          where.employeeCode = { in: [...explicitSet] };
        }

        const eligible = await tx.salesUser.findMany({
          where,
          select: { id: true, employeeCode: true },
        });
        const eligibleCodes = new Set(eligible.map((e) => e.employeeCode));

        // Surface explicit winners that did NOT make the eligible/active set (never a silent drop):
        // an unknown code, a deactivated/soft-deleted employee, or one outside the eligibility
        // (role/region) all land here. We cannot distinguish the exact cause from the filtered
        // query alone, so the reason is NOT_ELIGIBLE_OR_INACTIVE.
        if (explicitSet) {
          for (const code of explicitSet) {
            if (!eligibleCodes.has(code)) {
              skipped.push({ employeeCode: code, reason: 'NOT_ELIGIBLE_OR_INACTIVE' });
            }
          }
        }

        // AUDIT: zero-creditable-winner behaviour (decision beyond the brief's literal text). The
        // brief says "require count===1 before ANY credit" + flip to CREDITED. When a run resolves
        // NO creditable winner (e.g. every explicit code is inactive/ineligible, or an empty
        // eligible set), flipping to CREDITED would STRAND the contest (credited nobody, yet no
        // longer creditable). Instead we do NOT claim/flip: nothing was credited, no wallet moved,
        // so the contest stays ACTIVE/ENDED and is safely re-runnable (no double-credit is possible
        // because no credit happened). The once-only guard still fully applies once ≥1 credit lands.
        // If the owner prefers "any credit attempt burns the contest", flip this to claim-then-return.
        if (eligible.length === 0) {
          return { claimed: false };
        }

        // ── Once-only guarded status claim — BEFORE any wallet write ───────────────────────────
        // Only the first caller flips a creditable + not-yet-credited contest to CREDITED and
        // stamps bonusCreditedAt/By (count===1). A racing/second credit sees count 0 (status now
        // CREDITED / bonusCreditedAt non-null) and throws — no winner is double-credited.
        const now = new Date();
        const claim = await tx.contest.updateMany({
          where: {
            id,
            clientId: user.clientId,
            status: { in: ContestsService.CREDITABLE_STATUSES },
            bonusCreditedAt: null,
          },
          data: {
            status: ContestStatus.CREDITED,
            bonusCreditedAt: now,
            bonusCreditedBy: user.sub ?? null,
          },
        });
        if (claim.count !== 1) {
          throw new ConflictException('This contest bonus has already been credited.');
        }

        // ── Credit each winner via the AUDITED account-first primitive ─────────────────────────
        for (const emp of eligible) {
          // Account-first: link (idempotent) the EMPLOYEE RewardAccount, mint (idempotent) its
          // wallet, then credit through the SAME applyMovement whole-Int EARN path the points rail
          // uses. referenceType CONTEST / sourceType CONTEST_BONUS tag the movement (NOT a batch).
          const accountId = await ensureEmployeeAccount(tx, emp.id);
          await ensureEmployeeWallet(tx, accountId);
          await this.walletService.creditEarnForAccount(
            accountId,
            user.clientId,
            contest.bonusPoints,
            {
              referenceType: 'CONTEST',
              referenceId: id,
              sourceType: 'CONTEST_BONUS',
              sourceId: emp.employeeCode,
              description: `Contest bonus: ${contest.name}`,
            },
            tx,
          );
          // Audit-trail child row. The @@unique([contestId, employeeCode]) is a backstop — the
          // once-only contest claim already prevents a second crediting run, and `eligible` is
          // distinct by employeeCode (tenant-unique), so this create never collides in a single run.
          await tx.contestBonusCredit.create({
            data: {
              contestId: id,
              clientId: user.clientId,
              employeeCode: emp.employeeCode,
              accountId,
              points: contest.bonusPoints,
              creditedAt: now,
            },
          });
          creditedCount += 1;
          pointsCreditedTotal += contest.bonusPoints;
        }

        return { claimed: true };
      },
      { timeout: 180_000, maxWait: 20_000 },
    );

    return {
      creditedCount,
      pointsCreditedTotal,
      skipped,
      credited: result.claimed,
    };
  }

  // ─── Rep read ──────────────────────────────────────────────────────────────

  /**
   * GET /v1/rewards/employee/contests — the ACTIVE/SCHEDULED contests visible to the logged-in
   * employee, filtered by their role/region against eligibleRoleCodes/eligibleRegions (empty = all).
   * Display-only (banner/name/duration/bonus/eligibility) — NO money. Resolved via the SAME
   * resolveEmployeeReadContext the other employee reads use (own-identity authorization + the
   * EMPLOYEE-earner tenant gate throws 400/403 otherwise).
   */
  async employeeContests(user: JwtPayload) {
    const ctx = await resolveEmployeeReadContext(this.prisma, user);

    // Role/region visibility: an EMPTY eligibility list = visible to all; a NON-EMPTY list must
    // include the employee's roleCode / region. A null roleCode/region therefore only ever matches
    // the empty-list (unrestricted) contests — identical to the catalogue visibility gate.
    const contests = await this.prisma.contest.findMany({
      where: {
        clientId: user.clientId,
        status: { in: [ContestStatus.ACTIVE, ContestStatus.SCHEDULED] },
        AND: [
          {
            OR: [
              { eligibleRoleCodes: { isEmpty: true } },
              ...(ctx.roleCode ? [{ eligibleRoleCodes: { has: ctx.roleCode } }] : []),
            ],
          },
          {
            OR: [
              { eligibleRegions: { isEmpty: true } },
              ...(ctx.region ? [{ eligibleRegions: { has: ctx.region } }] : []),
            ],
          },
        ],
      },
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        name: true,
        bannerUrl: true,
        description: true,
        startDate: true,
        endDate: true,
        bonusPoints: true,
        status: true,
        eligibleRoleCodes: true,
        eligibleRegions: true,
      },
    });
    return { contests };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async requireContest(clientId: string, id: string) {
    const contest = await this.prisma.contest.findFirst({ where: { id, clientId } });
    if (!contest) throw new NotFoundException('Contest not found');
    return contest;
  }

  /** Parse + validate ISO dates; reject endDate <= startDate. */
  private parseDuration(startStr: string, endStr: string): { startDate: Date; endDate: Date } {
    const startDate = new Date(startStr);
    const endDate = new Date(endStr);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid contest start/end date.');
    }
    if (endDate.getTime() <= startDate.getTime()) {
      throw new BadRequestException('Contest endDate must be after startDate.');
    }
    return { startDate, endDate };
  }

  /** Trim, drop blanks, de-dupe (preserve order) a code/region list. Undefined → []. */
  private normalizeCodes(codes?: string[]): string[] {
    if (!codes || codes.length === 0) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of codes) {
      const t = (c ?? '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }
}
