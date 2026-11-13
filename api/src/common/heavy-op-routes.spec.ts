import 'reflect-metadata';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { HeavyOpInterceptor } from './heavy-op-limiter';
import { TdsController } from '../tds/tds.controller';
import { SalesImportApplyController } from '../sales-import/sales-import-apply.controller';
import { SalesImportConfigController } from '../sales-import/sales-import-config.controller';
import { SalesMonthsController } from '../sales-import/sales-months.controller';
import { PointsComputeController } from '../points-engine/points-compute.controller';
import { TargetsController, AchievementsController } from '../targets/targets.controller';
import { CreditsController } from '../credits/credits.controller';
import { AdminInvoicesController } from '../invoices/invoices.controller';
import { PayoutsController } from '../payouts/payouts.controller';
import { SalesImportController } from '../sales-import/sales-import.controller';
import { GiftDisbursalController } from '../vendor/gift-disbursal.controller';

/**
 * Memory-safety (2026-11-13): every heavy in-API route runs inside a per-instance
 * heavy-operation slot (max 2 → 503 + Retry-After). Exports moved to the Downloads flow
 * take their slot inside ExportsService.respond instead, so they are NOT listed here.
 */
const HEAVY: Array<[string, object, string]> = [
  ['TDS 194R export', TdsController.prototype, 'export194R'],
  ['TDS 194C export', TdsController.prototype, 'export194C'],
  ['Sales Import preview', SalesImportApplyController.prototype, 'getPreview'],
  ['Sales Import apply', SalesImportApplyController.prototype, 'postApply'],
  ['KPI tester', SalesImportConfigController.prototype, 'testKpi'],
  ['recalculate preview', SalesMonthsController.prototype, 'recalcPreview'],
  ['recalculate', SalesMonthsController.prototype, 'recalculate'],
  ['points-compute preview', PointsComputeController.prototype, 'preview'],
  ['points-compute commit', PointsComputeController.prototype, 'commit'],
  ['target upload', TargetsController.prototype, 'uploadTargets'],
  ['achievement upload', AchievementsController.prototype, 'uploadAchievements'],
  ['payout bank file', CreditsController.prototype, 'createPayoutDownload'],
  ['admin invoice export', AdminInvoicesController.prototype, 'export'],
  ['payout reconciliation export', PayoutsController.prototype, 'reconciliation'],
  ['Sales Import errors.xlsx', SalesImportController.prototype, 'errorsXlsx'],
  ['gift disbursal export', GiftDisbursalController.prototype, 'export'],
];

describe.each(HEAVY)('%s runs inside a heavy-operation slot', (_label, proto, method) => {
  it(`${method} carries the HeavyOpInterceptor`, () => {
    const handler = (proto as Record<string, unknown>)[method];
    expect(typeof handler).toBe('function');
    const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, handler as object) ?? []) as unknown[];
    expect(interceptors).toContain(HeavyOpInterceptor);
  });
});
