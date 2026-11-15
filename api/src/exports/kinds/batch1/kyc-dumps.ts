/**
 * KYC review dump + Rejected-outlets export as background exports — kinds `kyc-review-dump`
 * (`GET /v1/kyc/review-dump`) and `kyc-rejected` (`GET /v1/kyc/rejected-export`). The row assembly stays in KycService
 * (reviewDumpPage / rejectedExportPage — shared with the on-screen review queue's helpers), now one keyset page of
 * ≤ 2,000 submissions at a time; the layout is kyc-review-dump.ts (kycReviewDumpCells / rejectedKycCells), streamed.
 *
 * Scoping is exactly as before: KycService.kycTenantFilter(ctx.user) — an un-assumed Gifsy owner sees every tenant's
 * submissions (owner decision DATA-VISIBILITY §3.1), an assumed operator only the assumed tenant.
 */
import { loadHolidaySet } from '../../../common/holiday-calendar';
import { KycService, type KycExportCursor } from '../../../kyc/kyc.service';
import {
  kycDumpColumnWidths,
  kycReviewDumpCells,
  kycReviewDumpHeaders,
  rejectedKycCells,
  rejectedKycHeaders,
} from '../../../kyc/kyc-review-dump';
import type { ExportKindDef } from '../../export-kinds';
import { BATCH1_PAGE_SIZE } from './common';

type NoParams = Record<string, never>;

/** Gifsy-only, like both endpoints: @Roles('GIFSY_ADMIN') + @RequirePermission('kyc:read'). */
const KYC_DUMP_ACCESS = { roles: ['GIFSY_ADMIN'], permission: 'kyc:read' } as const;

/**
 * Heavy rule: LIGHT (streamed instantly) — the dump is the live PENDING_GIFSY review queue, which reviewers download,
 * fill and re-upload straight away (bulk-verify round-trip); its size is bounded by the queue, and streaming keeps
 * memory flat whatever it is.
 */
export const KYC_REVIEW_DUMP_KIND: ExportKindDef<NoParams> = {
  kind: 'kyc-review-dump',
  label: 'KYC review dump',
  access: KYC_DUMP_ACCESS,
  parseParams: () => ({}),
  isHeavy: () => false,
  describeParams: () => 'Submissions awaiting Gifsy review',
  fileName: () => 'kyc-review-dump.xlsx',
  async run(ctx, _params, out) {
    const kyc = ctx.moduleRef.get(KycService, { strict: false });
    const headers = kycReviewDumpHeaders();
    const sheet = await out.addSheet('KYC Review Dump', headers, { widths: kycDumpColumnWidths(headers) });
    let after: KycExportCursor | null = null;
    do {
      const page = await kyc.reviewDumpPage(ctx.user, after, BATCH1_PAGE_SIZE);
      for (const e of page.entries) await sheet.addRow(kycReviewDumpCells(e));
      after = page.next;
    } while (after);
    return { rowCount: sheet.rowCount };
  },
};

/**
 * Heavy rule: ALWAYS heavy — every REJECTED submission ever (it only grows), with business-hour SLA maths per row.
 */
export const KYC_REJECTED_KIND: ExportKindDef<NoParams> = {
  kind: 'kyc-rejected',
  label: 'Rejected outlets (KYC)',
  access: KYC_DUMP_ACCESS,
  parseParams: () => ({}),
  isHeavy: () => true,
  describeParams: () => 'All rejected KYC submissions',
  fileName: () => 'kyc-rejected.xlsx',
  async run(ctx, _params, out) {
    const kyc = ctx.moduleRef.get(KycService, { strict: false });
    const holidays = await loadHolidaySet(ctx.prisma);
    const headers = rejectedKycHeaders();
    const sheet = await out.addSheet('Rejected Outlets', headers, { widths: kycDumpColumnWidths(headers) });
    let after: KycExportCursor | null = null;
    do {
      const page = await kyc.rejectedExportPage(ctx.user, after, BATCH1_PAGE_SIZE, holidays);
      for (const r of page.rows) await sheet.addRow(rejectedKycCells(r));
      after = page.next;
    } while (after);
    return { rowCount: sheet.rowCount };
  },
};
