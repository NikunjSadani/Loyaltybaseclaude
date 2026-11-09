import { CanActivate, ConflictException, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { currentMonthKey } from '../../targets/targets.helpers';
import { isSalesImportEnabledUncached } from '../sales-import-access';
import { isMonthKey, monthLabel, resolveMonthState } from './month-state';

/**
 * D-1 (owner: A). Refuses the CREDITABLE / APPROVABLE points-compute artefacts — export, commit, preview-report,
 * payout-report — for a month that is still OPEN in Sales Import, because importer data for an OPEN month can still
 * be rewritten and the approved points would silently diverge from the stored achievements.
 *
 * Inert for every tenant without `features.salesImport === true` (Deoleo): it reads the flag UNCACHED + fail-closed
 * (isSalesImportEnabledUncached → false on any error) and returns `true` before anything else. The read-only preview
 * route is deliberately NOT guarded. The engine's evaluator / rule store / compute service / response shapes are
 * untouched; this only adds a decorator on 4 routes.
 *
 * A malformed / missing `period` is let through: the route's own validation pipe rejects it (guards run first).
 */
@Injectable()
export class SalesMonthClosedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: JwtPayload; body?: Record<string, unknown>; query?: Record<string, unknown> }>();
    const user = req.user;
    if (!user?.clientId) return true; // unauthenticated requests are rejected by the global JWT guard
    const period = (req.body && typeof req.body === 'object' ? req.body.period : undefined) ?? req.query?.period;
    if (!isMonthKey(period)) return true;

    if (!(await isSalesImportEnabledUncached(this.prisma, user.clientId))) return true;

    const override = await this.prisma.salesMonthStatus.findUnique({
      where: { clientId_month: { clientId: user.clientId, month: period } },
    });
    const st = resolveMonthState(period, currentMonthKey(), override);
    if (st.state === 'OPEN') {
      throw new ConflictException(`${monthLabel(period)} is still OPEN. Close it in Sales Import first.`);
    }
    return true;
  }
}
