/**
 * Lane B report kinds: Outlet master, visibility capture exports (+ visibility status report), KYC dumps/exports.
 * OWNED BY LANE B — only lane B edits this file.
 */
import type { AnyExportKind } from '../export-kinds';
import { KYC_REJECTED_KIND, KYC_REVIEW_DUMP_KIND } from './batch1/kyc-dumps';
import { KYC_STATUS_KIND } from './batch1/kyc-status';
import { OUTLET_MASTER_KIND } from './batch1/outlet-master';
import { VISIBILITY_CAPTURES_KIND } from './batch1/visibility-captures';
import { VISIBILITY_STATUS_KIND } from './batch1/visibility-status';

export const BATCH1_EXPORT_KINDS: readonly AnyExportKind[] = [
  OUTLET_MASTER_KIND,
  VISIBILITY_CAPTURES_KIND,
  VISIBILITY_STATUS_KIND,
  KYC_REVIEW_DUMP_KIND,
  KYC_REJECTED_KIND,
  KYC_STATUS_KIND,
];
