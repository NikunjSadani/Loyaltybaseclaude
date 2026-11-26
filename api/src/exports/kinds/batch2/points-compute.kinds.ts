/**
 * Points Compute Engine downloads as export kinds (Downloads page design):
 *   points-credit-upload   GET /v1/admin/points-compute/export          (credits-upload file — creditable artefact)
 *   points-preview-report  GET /v1/admin/points-compute/preview-report  (human review report, POINTS)
 *   points-payout-report   GET /v1/admin/points-compute/payout-report   (report-only PAYOUT amounts)
 *
 * Each export used to recompute the whole preview inside the API (every outlet × KPI with its explanation) and then
 * build the workbook in memory. The compute itself is not pageable (rules are evaluated per outlet across all inputs),
 * so these kinds are ALWAYS heavy: the compute runs in the background worker (2 GiB, its own process) and only the
 * finished file is streamed from storage. The workbook is streamed row by row (points-compute-export.helper writers),
 * so the worker holds the preview once, never the preview + a SheetJS copy.
 *
 * Gates that sat on the routes are re-checked when the file is actually built (the request may have queued, and the
 * generic Downloads route has no route guards):
 *   - D-1 SalesMonthClosedGuard (month must be CLOSED when Sales Import is involved) — same guard class, same rules;
 *     a successful build is recorded as the AuditLog EXPORT row the guard writes for the route;
 *   - credit-upload only: the points engine must be enabled (UNCACHED, fail-closed), same message.
 */
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PreviewComputeDto } from '../../../points-engine/dto/points-compute.dto';
import { PointsComputeService } from '../../../points-engine/points-compute.service';
import {
  writeCreditUploadXlsx,
  writePayoutReportXlsx,
  writePreviewReportXlsx,
} from '../../../points-engine/points-compute-export.helper';
import type { ComputePreview } from '../../../points-engine/points-compute.types';
import { SalesMonthClosedGuard } from '../../../sales-import/months/sales-month-closed.guard';
import { TenantSettingsService } from '../../../tenant/tenant-settings.service';
import type { ExportAccess, ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { monthWords, parseQueryDto, serviceOf } from './kind-support';
import { parseQuarter } from '../../../points-engine/points-engine.quarter';

export interface PointsComputeParams {
  period: string;
  program: string | null;
  kpiCode: string | null;
  /** §3a: the pendingKey of the visibility-pending outlet set the admin accepted (money files only). */
  acceptVisibilityPendingKey?: string | null;
  /** The run key the operator reviewed (sourceKey for the credit file, payoutKey for the payout report). */
  expectedKey?: string | null;
  /** preview.importedMonths.confirmKey — a Gifsy admin's confirmation for a run covering imported months. */
  confirmImportedMonthsKey?: string | null;
}

/** Same as every points-compute download route: @Roles('GIFSY_ADMIN','CLIENT_ADMIN') + points_rules:read. */
const POINTS_RULES_READ: ExportAccess = { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'points_rules:read' };

export const POINTS_ENGINE_DISABLED_MESSAGE =
  'The points engine is disabled for this tenant — enable it in settings before exporting a credit-upload file.';

function parse(raw: unknown): PointsComputeParams {
  const q = parseQueryDto(PreviewComputeDto, raw);
  return {
    period: q.period,
    program: q.program ?? null,
    kpiCode: q.kpiCode ?? null,
    ...(q.acceptVisibilityPendingKey !== undefined ? { acceptVisibilityPendingKey: q.acceptVisibilityPendingKey } : {}),
    ...(q.expectedKey !== undefined ? { expectedKey: q.expectedKey } : {}),
    ...(q.confirmImportedMonthsKey !== undefined ? { confirmImportedMonthsKey: q.confirmImportedMonthsKey } : {}),
  };
}

/**
 * Run the route's D-1 guard for this request (the guard reads `user` + `period` from the request and the route name
 * from the handler). Throws the guard's 409 / 503 exactly as the route would.
 */
async function assertMonthClosed(guard: SalesMonthClosedGuard, user: JwtPayload, period: string, route: string): Promise<void> {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user, query: { period } }), getResponse: () => undefined }),
    getHandler: () => ({ name: route }),
  } as unknown as ExecutionContext;
  await guard.canActivate(context);
}

function pointsKind(opts: {
  kind: string;
  label: string;
  /** The controller handler name — what the D-1 guard records as the route. */
  route: 'export' | 'previewReport' | 'payoutReport';
  fileName: (period: string) => string;
  write: (preview: ComputePreview, out: XlsxStreamWriter) => Promise<number>;
  requiresEngineEnabled?: boolean;
  /**
   * §3a: a MONEY file (credit-upload / payout report) — refused while visibility is pending unless the admin accepted
   * the pending outlet count; the acceptance is written to the audit log. The review report is not gated.
   */
  requiresVisibilityAcceptance?: boolean;
  /** Which preview key `expectedKey` is checked against (a money file must match the run the operator reviewed). */
  expectedKeyOf?: (preview: ComputePreview) => string;
}): ExportKindDef<PointsComputeParams> {
  return {
    kind: opts.kind,
    label: opts.label,
    access: POINTS_RULES_READ,
    parseParams: (raw: unknown) => parse(raw),
    // The whole-tenant compute runs on every download → always in the background worker.
    isHeavy: () => true,
    describeParams: (p) =>
      [parseQuarter(p.period)?.label ?? monthWords(p.period), ...(p.program ? [p.program] : []), ...(p.kpiCode ? [p.kpiCode] : [])].join(' · '),
    fileName: (p) => opts.fileName(p.period),
    async run(ctx: ExportRunContext, p: PointsComputeParams, out: XlsxStreamWriter) {
      const guard = new SalesMonthClosedGuard(ctx.prisma);
      await assertMonthClosed(guard, ctx.user, p.period, opts.route);
      if (opts.requiresEngineEnabled) {
        // The credit-upload file IS the creditable artefact: withhold it when the engine is disabled. Read UNCACHED +
        // fail-closed (same as the route and the commit money-gate).
        const flags = await serviceOf(ctx, TenantSettingsService).getPointsEngineFlagsUncached(ctx.clientId);
        if (!flags.enabled) throw new ForbiddenException(POINTS_ENGINE_DISABLED_MESSAGE);
      }
      const preview = await serviceOf(ctx, PointsComputeService).previewCompute(ctx.user, {
        period: p.period,
        program: p.program,
        kpiCode: p.kpiCode,
      });
      if (opts.expectedKeyOf) PointsComputeService.assertExpectedKey(opts.expectedKeyOf(preview), p.expectedKey, opts.label.toLowerCase());
      if (opts.requiresVisibilityAcceptance) {
        // Money files: quarter must be over; imported months need the Gifsy confirmation (uncached first-live month).
        await serviceOf(ctx, PointsComputeService).refreshImportedMonths(ctx.clientId, preview);
        PointsComputeService.assertMoneyRunAllowed(preview, ctx.user, p.confirmImportedMonthsKey ?? null);
        PointsComputeService.assertVisibilityPendingAccepted(preview, p.acceptVisibilityPendingKey ?? null);
        await PointsComputeService.recordImportedMonthsConfirmation(ctx.prisma, ctx.user, preview, {
          route: opts.route,
          entityId: ctx.requestId ?? `${ctx.clientId}:${p.period}`,
        });
      }
      const rowCount = await opts.write(preview, out);
      if (opts.requiresVisibilityAcceptance) {
        await PointsComputeService.recordVisibilityAcceptance(ctx.prisma, ctx.user, preview, {
          route: opts.route,
          entityId: ctx.requestId ?? `${ctx.clientId}:${p.period}`,
          exportRequestId: ctx.requestId ?? null,
        });
      }
      // Recorded once the file has been built (the guard records a route download on a 2xx response).
      await guard.recordExport(ctx.clientId, p.period, ctx.user.sub, opts.route);
      return { rowCount };
    },
  };
}

export const POINTS_CREDIT_UPLOAD_KIND = pointsKind({
  kind: 'points-credit-upload',
  label: 'Points credit-upload file',
  route: 'export',
  fileName: (period) => `points-credit-upload-${period}.xlsx`,
  write: writeCreditUploadXlsx,
  requiresEngineEnabled: true,
  requiresVisibilityAcceptance: true,
  expectedKeyOf: (p) => p.sourceKey,
});

export const POINTS_PREVIEW_REPORT_KIND = pointsKind({
  kind: 'points-preview-report',
  label: 'Points preview report',
  route: 'previewReport',
  fileName: (period) => `points-preview-${period}.xlsx`,
  write: writePreviewReportXlsx,
});

export const POINTS_PAYOUT_REPORT_KIND = pointsKind({
  kind: 'points-payout-report',
  label: 'Points payout report',
  route: 'payoutReport',
  fileName: (period) => `points-payout-report-${period}.xlsx`,
  write: writePayoutReportXlsx,
  requiresVisibilityAcceptance: true,
  expectedKeyOf: (p) => p.payoutKey,
});

export const POINTS_COMPUTE_KINDS = [POINTS_CREDIT_UPLOAD_KIND, POINTS_PREVIEW_REPORT_KIND, POINTS_PAYOUT_REPORT_KIND];
