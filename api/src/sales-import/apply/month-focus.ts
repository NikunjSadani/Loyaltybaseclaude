/**
 * FOCUS-FROM-TARGETS — one month's focus resolution + reconciliation, shared by the import PREVIEW, APPLY (under the
 * month lock), RECALCULATE PREVIEW and RECALCULATE, so every path evaluates exactly the same definitions with the same
 * per-outlet products (design §4–§6, §11).
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MonthReconciliation } from '../sales-import.contract';
import {
  attachOutletFilters,
  buildFocusCatalogue,
  buildMonthReconciliation,
  resolveMonthFocus,
  type FocusCatalogue,
  type MonthFocusInput,
  type MonthFocusResolution,
} from '../kpi/focus-products';
import { hasTargetNamesDef, loadFocusAcceptances, loadMonthTargets, targetsNewerThanApply } from '../kpi/focus-data';
import type { RosterOutlet } from '../kpi/sales-import-data';
import type { KpiDefLite } from '../kpi/sales-kpi.helper';
import { monthLabel } from '../months/month-state';
import type { MonthComputation } from './month-compute';

type Db = PrismaService | Prisma.TransactionClient;

export interface MonthFocusRun {
  input: MonthFocusInput;
  resolution: MonthFocusResolution;
  /** The definitions to evaluate the month with (TARGET_NAMES ones carry their per-outlet filter). */
  evalDefs: KpiDefLite[];
  targetUploadedAt: Date | null;
}

/**
 * A lazily-loaded catalogue shared by every month of one request (only loaded when a TARGET_NAMES def exists).
 *
 * The catalogue is REQUEST-SCOPED on purpose: applying month A rewrites A's stored product list
 * (sales_month_history_combos) inside A's transaction, so a catalogue re-read for month B afterwards would differ from
 * the one the operator previewed — B's names could turn UNMATCHED after A was already written (a half-applied request).
 * Every month of one request (incl. the under-lock re-check) therefore resolves against the product lists as they were
 * at the START of the request ∪ the import's own products. Targets and acceptances are still re-read under the lock.
 */
export function lazyCatalogue(load: () => Promise<FocusCatalogue>): () => Promise<FocusCatalogue> {
  let p: Promise<FocusCatalogue> | null = null;
  return () => (p ??= load());
}

/**
 * Load the month's targets (every tenant — the reconciliation's targets / gaps are useful everywhere) and, only when an
 * enabled TARGET_NAMES definition exists, the catalogue + acceptances; resolve the month's focus products.
 * Without a TARGET_NAMES definition `evalDefs` is `defs` itself (the same objects) → values byte-identical.
 */
export async function runMonthFocus(
  db: Db,
  args: {
    clientId: string;
    month: string;
    defs: readonly KpiDefLite[];
    roster: Map<string, RosterOutlet>;
    labelOf: ReadonlyMap<string, string>;
    catalogue: () => Promise<FocusCatalogue>;
  },
): Promise<MonthFocusRun> {
  const { clientId, month, defs, roster, labelOf } = args;
  const focusOn = hasTargetNamesDef(defs);
  const { targets, uploadedAt } = await loadMonthTargets(db, clientId, month, roster);
  const catalogue = focusOn ? await args.catalogue() : buildFocusCatalogue([], []);
  const acceptances = focusOn ? await loadFocusAcceptances(db, clientId, month) : new Map();
  const input: MonthFocusInput = { month, defs, labelOf, roster, targets, catalogue, acceptances };
  const resolution = resolveMonthFocus(input);
  const evalDefs = focusOn ? attachOutletFilters(defs, resolution) : [...defs];
  return { input, resolution, evalDefs, targetUploadedAt: uploadedAt };
}

/** design §6 + §11: the reconciliation, with `targets.newerThanLastApply` against the month's last apply. */
export function reconcileMonth(
  run: MonthFocusRun,
  comp: MonthComputation,
  ownedKpiCodes: readonly string[],
  lastAppliedAt: Date | null,
): MonthReconciliation {
  const rec = buildMonthReconciliation({
    input: run.input,
    resolution: run.resolution,
    comp,
    targetUploadedAt: run.targetUploadedAt,
    ownedKpiCodes,
  });
  // B-M1: only a TARGET_NAMES tenant's figures depend on the targets, so only then can "targets changed" be true.
  const focusOn = hasTargetNamesDef(run.input.defs);
  return {
    ...rec,
    targets: { ...rec.targets, newerThanLastApply: targetsNewerThanApply(run.targetUploadedAt, lastAppliedAt, focusOn) },
  };
}

/** blockedReason for a month with focus blockers (null = none). Comes AFTER the existing reasons in precedence. */
export function focusBlockedReason(month: string, blockers: readonly unknown[]): string | null {
  if (blockers.length === 0) return null;
  const n = blockers.length;
  return `${n} problem${n === 1 ? '' : 's'} with the focus products in the ${monthLabel(month)} target file — see Focus brands.`;
}

export const FOCUS_CHANGED_MESSAGE = 'The targets or focus products changed since the preview. Refresh the preview and try again.';

/** A non-empty fingerprint must be sent back unchanged ('' = the tenant has no TARGET_NAMES definition → not required). */
export function focusFingerprintMatches(actual: string, expected: string | undefined | null): boolean {
  return actual === '' || expected === actual;
}
