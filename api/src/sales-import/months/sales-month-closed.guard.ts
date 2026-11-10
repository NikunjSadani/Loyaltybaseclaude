import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { currentMonthKey } from '../../targets/targets.helpers';
import { isMonthKey, monthLabel, resolveMonthState } from './month-state';
import { salesMonthEntityId } from './sales-months.service';

/**
 * D-1 (owner: A). Refuses the CREDITABLE / APPROVABLE points-compute artefacts — export, commit, preview-report,
 * payout-report — for a month that is still OPEN in Sales Import, because importer data for an OPEN month can still
 * be rewritten and the approved points would silently diverge from the stored achievements.
 *
 * Applies when the tenant has `features.salesImport === true` OR (M5) the month already holds importer-written data
 * (a SalesImportApply exists for it) — switching the flag off must not unlock exports of a month that can still be
 * rewritten once it is switched back on. Deoleo (flag off, no Sales Import applies) passes straight through.
 * FAIL-CLOSED (M5): if the flag / month state cannot be read (DB error) the request gets 503 instead of an unchecked
 * export. The read-only preview route is deliberately NOT guarded.
 *
 * Each allowed export / report download of a guarded month is recorded as an AuditLog EXPORT row on the month entity
 * (best effort), so a later GIFSY reopen can warn that artefacts were already produced (M5). Commit is not recorded
 * here: it creates a CreditBatch, which the reopen check counts directly.
 *
 * A malformed / missing `period` is let through: the route's own validation pipe rejects it (guards run first).
 */
@Injectable()
export class SalesMonthClosedGuard implements CanActivate {
  private readonly logger = new Logger(SalesMonthClosedGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: JwtPayload; body?: Record<string, unknown>; query?: Record<string, unknown> }>();
    const user = req.user;
    if (!user?.clientId) return true; // unauthenticated requests are rejected by the global JWT guard
    const period = (req.body && typeof req.body === 'object' ? req.body.period : undefined) ?? req.query?.period;
    if (!isMonthKey(period)) return true;
    const clientId = user.clientId;

    let state: ReturnType<typeof resolveMonthState>;
    try {
      const [client, applied] = await Promise.all([
        this.prisma.client.findUnique({ where: { id: clientId }, select: { features: true, status: true } }),
        this.prisma.salesImportApply.findFirst({ where: { clientId, month: period }, select: { id: true } }),
      ]);
      const f = client?.features;
      const flagOn =
        !!client && client.status !== 'INACTIVE' && !!f && typeof f === 'object' && !Array.isArray(f) && (f as Record<string, unknown>).salesImport === true;
      if (!flagOn && !applied) return true; // no Sales Import involvement for this month → inert (Deoleo)
      const override = await this.prisma.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month: period } } });
      state = resolveMonthState(period, currentMonthKey(), override);
    } catch (e) {
      this.logger.error(`D-1 guard could not read the month state for ${clientId}/${period}: ${(e as Error)?.message}`);
      throw new ServiceUnavailableException('Could not check whether this month is closed in Sales Import. Try again in a moment.');
    }
    if (state.state === 'OPEN') {
      throw new ConflictException(`${monthLabel(period)} is still OPEN. Close it in Sales Import first.`);
    }

    const route = context.getHandler()?.name ?? 'unknown';
    if (route !== 'commit') {
      await this.prisma.auditLog
        .create({
          data: {
            action: 'EXPORT',
            entityType: 'SALES_MONTH',
            entityId: salesMonthEntityId(clientId, period),
            actorId: user.sub,
            newValues: { route, period },
            metadata: { clientId, month: period, route },
          },
        })
        .catch((e: unknown) => this.logger.warn(`D-1 guard: export record failed: ${(e as Error)?.message}`));
    }
    return true;
  }
}
