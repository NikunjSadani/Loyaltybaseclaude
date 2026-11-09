/**
 * Shared DB readers for Lane K (preview / apply / KPI tester). Every reader is keyed by clientId (tenant isolation:
 * a foreign import id is a 404, never a cross-tenant read).
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma, SalesImport } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { KpiAgg, OutletScopeMeta } from './sales-kpi.helper';
import { rosterHashOf } from './sales-kpi.helper';

type Db = PrismaService | Prisma.TransactionClient;

/** Aggregate page size for keyset pagination (plan K-5: 20k at a time). */
export const AGG_PAGE_SIZE = 20_000;

export interface AggRow extends KpiAgg {
  id: bigint;
  month: string;
  outletCode: string;
  dimKey: string;
}

export interface RosterOutlet extends OutletScopeMeta {
  name: string;
}

/** Load an import of THIS tenant (404 otherwise); `latest` = the newest READY import. Must be READY (409). */
export async function resolveReadyImport(db: Db, clientId: string, importId: string): Promise<SalesImport> {
  const imp =
    importId === 'latest'
      ? await db.salesImport.findFirst({ where: { clientId, status: 'READY' }, orderBy: { createdAt: 'desc' } })
      : await db.salesImport.findFirst({ where: { id: importId, clientId } });
  if (!imp) throw new NotFoundException(importId === 'latest' ? 'No processed (READY) import yet.' : 'Import not found');
  if (imp.status !== 'READY') throw new ConflictException(`This import is ${imp.status}, not READY.`);
  return imp;
}

/** The tenant's roster (non-deleted outlets) → scope facets + name. */
export async function loadRosterMeta(db: Db, clientId: string): Promise<Map<string, RosterOutlet>> {
  const outlets = await db.outlet.findMany({
    where: { clientId, deletedAt: null },
    select: { outletCode: true, name: true, programName: true, outletType: { select: { code: true } } },
  });
  return new Map(
    outlets.map((o) => [
      o.outletCode,
      { name: o.name, outletType: o.outletType?.code ?? null, program: o.programName ?? null },
    ]),
  );
}

export function rosterHashOfMap(roster: Map<string, unknown>): string {
  return rosterHashOf(roster.keys());
}

function toAgg(r: {
  id: bigint;
  month: string;
  outletCode: string;
  dims: Prisma.JsonValue;
  dimKey: string;
  amountPaise: bigint;
  qtyMicro: bigint;
  lines: number;
}): AggRow {
  const dims: Record<string, string> = {};
  if (r.dims && typeof r.dims === 'object' && !Array.isArray(r.dims)) {
    for (const [k, v] of Object.entries(r.dims as Record<string, unknown>)) dims[k] = v === null || v === undefined ? '' : String(v);
  }
  return {
    id: r.id,
    month: r.month,
    outletCode: r.outletCode,
    dims,
    dimKey: r.dimKey,
    amountPaise: BigInt(r.amountPaise),
    qtyMicro: BigInt(r.qtyMicro),
    lines: r.lines,
  };
}

/**
 * Keyset-page every aggregate of an import (optionally one month) ordered by id; `onPage` per page.
 * Uses the (importId, month, id) index.
 */
export async function forEachAggregatePage(
  db: Db,
  importId: string,
  month: string | null,
  onPage: (rows: AggRow[]) => void | Promise<void>,
  pageSize = AGG_PAGE_SIZE,
): Promise<void> {
  let cursor: bigint | null = null;
  for (;;) {
    const page = await db.salesImportAggregate.findMany({
      where: { importId, ...(month ? { month } : {}), ...(cursor !== null ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: pageSize,
      select: { id: true, month: true, outletCode: true, dims: true, dimKey: true, amountPaise: true, qtyMicro: true, lines: true },
    });
    if (page.length === 0) return;
    await onPage(page.map(toAgg));
    if (page.length < pageSize) return;
    cursor = page[page.length - 1].id;
  }
}
