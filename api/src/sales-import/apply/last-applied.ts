/**
 * The import last applied to a (tenant, month) — read by preview (display + OLDER_THAN_LAST_APPLIED) and re-read by
 * apply UNDER the month lock (M7), so both decide on the same data. Source of truth = the newest SalesImportApply row.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { lastInvoiceDateOf } from './warnings';

type Db = PrismaService | Prisma.TransactionClient;

export interface LastApplied {
  importId: string;
  at: Date;
  appliedById: string;
  ownedCodes: string[];
  /** That import's latest invoice date in this month (UX-1). */
  lastInvoiceDate: string | null;
}

export async function loadLastApplied(db: Db, clientId: string, month: string): Promise<LastApplied | null> {
  const a = await db.salesImportApply.findFirst({
    where: { clientId, month },
    orderBy: { createdAt: 'desc' },
    select: { importId: true, createdAt: true, appliedById: true, definitionsSnapshot: true },
  });
  if (!a) return null;
  const imp = await db.salesImport.findFirst({ where: { id: a.importId, clientId }, select: { monthSummaries: true } });
  const ownedCodes = Array.isArray(a.definitionsSnapshot)
    ? (a.definitionsSnapshot as Array<{ kpiCode?: string }>).map((d) => String(d?.kpiCode ?? ''))
    : [];
  return {
    importId: a.importId,
    at: a.createdAt,
    appliedById: a.appliedById,
    ownedCodes,
    lastInvoiceDate: lastInvoiceDateOf(imp?.monthSummaries, month),
  };
}
