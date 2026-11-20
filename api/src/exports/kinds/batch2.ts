/**
 * Lane C report kinds: Target-vs-Sales (multi-month), target/achievement exports + templates, TDS payouts export,
 * payments report, delivery-status export, points-compute exports.
 * OWNED BY LANE C — only lane C edits this file. Each kind lives in kinds/batch2/*.
 */
import type { AnyExportKind } from '../export-kinds';
import { APP_INSTALLED_USERS_KIND } from './batch2/app-installed-users.kind';
import { BILLING_COMPARISON_SLOWER_KIND } from './batch2/billing-comparison.kind';
import { BILLING_PROGRESS_OUTLETS_KIND } from './batch2/billing-progress.kind';
import { DELIVERY_STATUS_KIND } from './batch2/delivery-status.kind';
import { PAYMENTS_REPORT_KIND } from './batch2/payments-report.kind';
import { POINTS_COMPUTE_KINDS } from './batch2/points-compute.kinds';
import { TARGET_VS_SALES_KIND } from './batch2/target-vs-sales.kind';
import { TARGET_EXPORT_KINDS } from './batch2/targets.kinds';
import { TDS_PAYOUTS_KIND } from './batch2/tds-payouts.kind';
import { USAGE_REPORT_KIND } from './batch2/usage-report.kind';
import { LOCATION_COMPLIANCE_KIND } from './batch2/location-compliance.kind';
import { REDEMPTION_REPORT_KIND } from './batch2/redemption-report.kind';

export const BATCH2_EXPORT_KINDS: readonly AnyExportKind[] = [
  TARGET_VS_SALES_KIND,
  ...TARGET_EXPORT_KINDS,
  TDS_PAYOUTS_KIND,
  PAYMENTS_REPORT_KIND,
  DELIVERY_STATUS_KIND,
  ...POINTS_COMPUTE_KINDS,
  APP_INSTALLED_USERS_KIND,
  BILLING_PROGRESS_OUTLETS_KIND,
  BILLING_COMPARISON_SLOWER_KIND,
  USAGE_REPORT_KIND,
  LOCATION_COMPLIANCE_KIND,
  REDEMPTION_REPORT_KIND,
];
