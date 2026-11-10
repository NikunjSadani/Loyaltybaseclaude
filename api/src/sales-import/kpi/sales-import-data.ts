/**
 * Shared DB readers for Lane K (preview / apply / KPI tester). Every reader is keyed by clientId (tenant isolation:
 * a foreign import id is a 404, never a cross-tenant read).
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma, SalesImport } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SalesColumnMapping } from '../sales-import.contract';
import type { KpiAgg, OutletScopeMeta } from './sales-kpi.helper';
import { normalizedRosterIndex, rosterOutletWhere } from '../ingest/roster';
import { mappingFingerprint } from '../ingest/mapping-fingerprint';

type Db = PrismaService | Prisma.TransactionClient;

/** Aggregate page size for keyset pagination (plan K-5: 20k at a time). */
export const AGG_PAGE_SIZE = 20_000;

export interface AggRow extends KpiAgg {
  id: bigint;
  month: string;
  /** normalizeOutletCode of the file's customer code (M6) — map it with RosterIndex.byNormalized. */
  outletCode: string;
  dimKey: string;
}

export interface RosterOutlet extends OutletScopeMeta {
  name: string;
  /** Outlet.id (SalesMonthHistory.outletId at apply time). */
  id?: string;
}

/** Streams aggregate-shaped rows page by page (an import's aggregates, or a month's stored history). */
export type AggregatePager = (onPage: (rows: AggRow[]) => void | Promise<void>) => Promise<void>;

/** Load an import of THIS tenant (404 otherwise); `latest` = the newest READY import. Must be READY (409) and not purged. */
export async function resolveReadyImport(db: Db, clientId: string, importId: string): Promise<SalesImport> {
  const imp =
    importId === 'latest'
      ? await db.salesImport.findFirst({ where: { clientId, status: 'READY', purgedAt: null }, orderBy: { createdAt: 'desc' } })
      : await db.salesImport.findFirst({ where: { id: importId, clientId } });
  if (!imp) throw new NotFoundException(importId === 'latest' ? 'No processed (READY) import yet.' : 'Import not found');
  if (imp.status !== 'READY') throw new ConflictException(`This import is ${imp.status}, not READY.`);
  if (imp.purgedAt) throw new ConflictException('This import\'s data was deleted after the retention period. Upload the file again.');
  return imp;
}

/**
 * H2: has the tenant's column mapping changed since this import was processed? (Then the aggregates were built under
 * a different reading of the file — another amount column, dimension, date order… — and must not be applied.)
 */
export async function mappingChangedSince(db: Db, clientId: string, imp: Pick<SalesImport, 'mappingFingerprint'>): Promise<boolean> {
  const p = await db.salesImportProfile.findUnique({ where: { clientId }, select: { columnMapping: true } });
  const current = mappingFingerprint((p?.columnMapping ?? null) as SalesColumnMapping | null);
  return !imp.mappingFingerprint || current !== imp.mappingFingerprint;
}

export const MAPPING_CHANGED_REASON =
  'The column mapping changed after this file was processed, so its numbers may be read from the wrong columns. Reprocess the file first.';

/**
 * The tenant's roster (non-deleted outlets) → scope facets + name, keyed by the stored `Outlet.outletCode`
 * (`rosterOutletWhere`, the same outlet set as the worker's `loadRoster`).
 */
export async function loadRosterMeta(db: Db, clientId: string): Promise<Map<string, RosterOutlet>> {
  const outlets = await db.outlet.findMany({
    where: rosterOutletWhere(clientId),
    select: { id: true, outletCode: true, name: true, programName: true, outletType: { select: { code: true } } },
  });
  return new Map(
    outlets.map((o) => [
      o.outletCode,
      { id: o.id, name: o.name, outletType: o.outletType?.code ?? null, program: o.programName ?? null },
    ]),
  );
}

/** normalizeOutletCode(stored code) → stored code, for mapping an aggregate's file code onto the CURRENT roster (M6). */
export function rosterIndexOf(roster: Map<string, RosterOutlet>): Map<string, string> {
  return normalizedRosterIndex(roster.keys());
}

function toAgg(r: {
  id: bigint;
  month: string;
  outletCode: string;
  dims: Prisma.JsonValue;
  dimKey: string;
  amountPaise: bigint;
  qtyPico: bigint;
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
    qtyPico: BigInt(r.qtyPico),
    lines: r.lines,
  };
}

/** An import's aggregates for one month, as a pager. */
export function importPager(db: Db, importId: string, month: string): AggregatePager {
  return (onPage) => forEachAggregatePage(db, importId, month, onPage);
}

/**
 * A month's stored history (SalesMonthHistory) as a pager, in the aggregate shape (`outletCode` = the stored customer
 * code, normalized like the aggregates). Keyset-paged on the (clientId, month, id) index.
 */
export function historyPager(db: Db, clientId: string, month: string, pageSize = AGG_PAGE_SIZE): AggregatePager {
  return async (onPage) => {
    let cursor: bigint | null = null;
    for (;;) {
      const page: Array<{
        id: bigint; month: string; customerCode: string; dims: Prisma.JsonValue; dimKey: string; amountPaise: bigint; qtyPico: bigint; lines: number;
      }> = await db.salesMonthHistory.findMany({
        where: { clientId, month, ...(cursor !== null ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: pageSize,
        select: { id: true, month: true, customerCode: true, dims: true, dimKey: true, amountPaise: true, qtyPico: true, lines: true },
      });
      if (page.length === 0) return;
      await onPage(page.map((r) => toAgg({ ...r, outletCode: r.customerCode })));
      if (page.length < pageSize) return;
      cursor = page[page.length - 1].id;
    }
  };
}

/** The month's stored history: which import it holds and when it was applied (null = no history). */
export async function monthHistoryMeta(db: Db, clientId: string, month: string): Promise<{ sourceImportId: string; appliedAt: Date } | null> {
  return db.salesMonthHistory.findFirst({ where: { clientId, month }, select: { sourceImportId: true, appliedAt: true } });
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
      select: { id: true, month: true, outletCode: true, dims: true, dimKey: true, amountPaise: true, qtyPico: true, lines: true },
    });
    if (page.length === 0) return;
    await onPage(page.map(toAgg));
    if (page.length < pageSize) return;
    cursor = page[page.length - 1].id;
  }
}
