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
 * rewritten once it is switched back on. The read-only preview route is deliberately NOT guarded.
 *
 * Failure policy (re-audit L3): the client flag is read FIRST. Flag OFF and no Sales Import apply for the month → allow
 * immediately (Deoleo). If the involvement cannot be established because a read FAILED and nothing shows Sales Import
 * involvement, the guard fails OPEN — a tenant that never used Sales Import must never get a Sales-Import-caused 503.
 * Only once involvement is known (flag ON, or an apply exists) does a failed month-state read fail CLOSED (503).
 * Re-check L5: a failed flag read is retried once; if it still fails, the last flag value this instance read for the
 * tenant decides (ON → involved; OFF or never read → treated as OFF, so it can only fail open).
 *
 * Each SUCCESSFUL export / report download of a guarded month is recorded as an AuditLog EXPORT row on the month entity
 * (re-audit L4: written when the response finishes with a 2xx, so a failed export is never recorded), so a later GIFSY
 * reopen can warn that artefacts were already produced (M5). Commit is not recorded here: it creates a CreditBatch,
 * which the reopen check counts directly. (A response hook rather than an interceptor keeps the points-compute
 * controller free of further edits.)
 *
 * A malformed / missing `period` is let through: the route's own validation pipe rejects it (guards run first).
 */
@Injectable()
export class SalesMonthClosedGuard implements CanActivate {
  private readonly logger = new Logger(SalesMonthClosedGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ user?: JwtPayload; body?: Record<string, unknown>; query?: Record<string, unknown> }>();
    const user = req.user;
    if (!user?.clientId) return true; // unauthenticated requests are rejected by the global JWT guard
    const period = (req.body && typeof req.body === 'object' ? req.body.period : undefined) ?? req.query?.period;
    if (!isMonthKey(period)) return true;
    const clientId = user.clientId;

    // 1. Is Sales Import involved for this tenant / month at all? (re-check L5: one retry, then the last flag value this
    //    instance read for the tenant; never known → treated as OFF, i.e. it can only fail OPEN.)
    let flagOn: boolean | null = await this.readFlag(clientId);
    if (flagOn === null) flagOn = await this.readFlag(clientId);
    if (flagOn === null) flagOn = SalesMonthClosedGuard.lastKnownFlag.get(clientId) ?? null;
    if (flagOn !== true) {
      let applied: boolean;
      try {
        applied = !!(await this.prisma.salesImportApply.findFirst({ where: { clientId, month: period }, select: { id: true } }));
      } catch (e) {
        // Involvement cannot be shown → fail OPEN (a tenant that never used Sales Import must not get a 503 from it).
        this.logger.warn(`D-1 guard: apply lookup failed for ${clientId}/${period}; allowing: ${(e as Error)?.message}`);
        return true;
      }
      if (!applied) return true; // no Sales Import involvement for this month → inert (Deoleo)
    }

    // 2. Involved → the month must be CLOSED; a failed read now fails CLOSED.
    let state: ReturnType<typeof resolveMonthState>;
    try {
      const override = await this.prisma.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month: period } } });
      state = resolveMonthState(period, currentMonthKey(), override);
    } catch (e) {
      this.logger.error(`D-1 guard could not read the month state for ${clientId}/${period}: ${(e as Error)?.message}`);
      throw new ServiceUnavailableException('Could not check whether this month is closed in Sales Import. Try again in a moment.');
    }
    if (state.state === 'OPEN') {
      throw new ConflictException(`${monthLabel(period)} is still OPEN. Close it in Sales Import first.`);
    }

    // 3. Record a SUCCESSFUL export / report (not commit) once the response has gone out with a 2xx.
    const route = context.getHandler()?.name ?? 'unknown';
    const res = http.getResponse<{ statusCode?: number; once?: (ev: string, cb: () => void) => unknown } | undefined>();
    if (route !== 'commit' && res && typeof res.once === 'function') {
      res.once('finish', () => {
        if ((res.statusCode ?? 500) >= 300) return;
        void this.recordExport(clientId, period, user.sub, route);
      });
    }
    return true;
  }

  /** Last successfully read `features.salesImport` per tenant (this instance), used only when a read fails. */
  static readonly lastKnownFlag = new Map<string, boolean>();

  /** The tenant's flag (strict `true`, client not INACTIVE), or null when the read failed. */
  private async readFlag(clientId: string): Promise<boolean | null> {
    try {
      const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { features: true, status: true } });
      const f = client?.features;
      const on =
        !!client && client.status !== 'INACTIVE' && !!f && typeof f === 'object' && !Array.isArray(f) && (f as Record<string, unknown>).salesImport === true;
      SalesMonthClosedGuard.lastKnownFlag.set(clientId, on);
      return on;
    } catch (e) {
      this.logger.warn(`D-1 guard: flag read failed for ${clientId}: ${(e as Error)?.message}`);
      return null;
    }
  }

  /** AuditLog EXPORT on the month entity (best effort; never affects the response). */
  async recordExport(clientId: string, period: string, actorId: string, route: string): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          action: 'EXPORT',
          entityType: 'SALES_MONTH',
          entityId: salesMonthEntityId(clientId, period),
          actorId,
          newValues: { route, period },
          metadata: { clientId, month: period, route },
        },
      })
      .catch((e: unknown) => this.logger.warn(`D-1 guard: export record failed: ${(e as Error)?.message}`));
  }
}
