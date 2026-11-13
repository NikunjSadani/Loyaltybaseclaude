/**
 * FOCUS-FROM-TARGETS design §7 — the EARLY, NON-blocking focus check returned by the target upload (`focusCheck`), so a
 * typo in a focus product name is seen on the day the targets are uploaded. The month preview re-checks and is the one
 * that blocks. Catalogue = the stored months' product lists only (one load per upload); acceptances are NOT applied here
 * (a fresh file is checked as written). Never throws: any failure → `checked: false` + reason.
 */
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TargetUploadFocusCheck } from '../sales-import.contract';
import { resolveMonthFocus } from './focus-products';
import { kpiLabelsOf, loadFocusCatalogue, mapTargetsOntoRoster } from './focus-data';
import { loadRosterMeta } from './sales-import-data';
import { kpiScopesOf, productSourceOf, toLite } from './sales-kpi-def.service';

type Db = PrismaService | Prisma.TransactionClient;

const log = new Logger('TargetUploadFocusCheck');

export const FOCUS_CHECK_NO_DEFINITION = 'No Sales Import KPI takes its products from the target file.';
export const FOCUS_CHECK_NO_PRODUCTS =
  'No sales month has been applied yet, so there is no product list to check the focus product names against. They will be checked on the month preview.';
export const FOCUS_CHECK_FAILED = 'The focus product check could not run. The month preview will still check the names before applying.';

/**
 * `uploaded` = month → stored outlet code → the uploaded target map (numbers + optional `__names`), exactly as the
 * upload wrote it. `months` = the months to check (the months the upload wrote).
 */
export async function targetUploadFocusCheck(
  db: Db,
  clientId: string,
  uploaded: Record<string, Record<string, unknown>>,
  months: readonly string[],
): Promise<TargetUploadFocusCheck> {
  try {
    const rows = await db.salesKpiDefinition.findMany({ where: { clientId, enabled: true, productSource: 'TARGET_NAMES' } });
    const focusRows = rows.filter((r) => r.enabled !== false && productSourceOf(r.productSource) === 'TARGET_NAMES');
    if (focusRows.length === 0) return { checked: false, reason: FOCUS_CHECK_NO_DEFINITION, months: [] };
    const catalogue = await loadFocusCatalogue(db, clientId);
    if (catalogue.size === 0) return { checked: false, reason: FOCUS_CHECK_NO_PRODUCTS, months: [] };

    const scopes = await kpiScopesOf(db, clientId, focusRows.map((r) => r.kpiCode));
    const defs = focusRows.map((r) => toLite(r, scopes.get(r.kpiCode) ?? null));
    const labelOf = await kpiLabelsOf(db, clientId, defs.map((d) => d.kpiCode));
    const roster = await loadRosterMeta(db, clientId);
    const out: TargetUploadFocusCheck['months'] = [];
    for (const month of [...months].sort()) {
      const targets = mapTargetsOntoRoster(
        Object.entries(uploaded[month] ?? {}).map(([outletCode, targetValues]) => ({ outletCode, targetValues })),
        roster,
      );
      const res = resolveMonthFocus({ month, defs, labelOf, roster, targets, catalogue, acceptances: new Map() });
      out.push({ month, blockers: res.blockers });
    }
    return { checked: true, months: out };
  } catch (e) {
    log.warn(`focus check failed for ${clientId}: ${(e as Error)?.message}`);
    return { checked: false, reason: FOCUS_CHECK_FAILED, months: [] };
  }
}
