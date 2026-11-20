/**
 * Imported (old-app) visibility history — ONE place for both questions every visibility surface asks:
 *
 *   1. Is this CAPTURE an imported old-app record?  → its photo storage path lives under `vendor-import/`
 *      (the Bajaj migration re-hosted every old-app photo to `visibility-media/<tenant>/vendor-import/...`,
 *      BAJAJ-PROD-OUTLET-IMPORT.md). A portal capture never writes there, so the path is the reliable marker —
 *      unlike "no submitting rep", which a deleted rep (onDelete: SetNull) would also produce.
 *
 *   2. Is this MONTH an imported month?  → a month BEFORE the tenant's portal go-live month, where go-live = the
 *      first month holding a capture with a submitting rep. A tenant with no portal capture at all yet has no
 *      go-live: then any month holding captures (all of them imported) is an imported month.
 *      The old app only kept APPROVED visits, so for an imported month we show the approved count it kept and
 *      never compute coverage / "Missed" against today's outlets (IMPORTED_MONTH_NOTE).
 *
 * Shared by the report screen, the dashboards and (at integration) the Excel export — do not re-derive elsewhere.
 */
import { Prisma } from '@prisma/client';
import { readMediaValue } from './visibility-types';

/** The plain one-line explanation shown wherever an imported month's coverage / Missed would appear. */
export const IMPORTED_MONTH_NOTE =
  'Not tracked for imported months — the old app only kept approved visits, so coverage and Missed cannot be worked out.';

const VENDOR_IMPORT_RE = /(^|\/)vendor-import\//;

/** True when a stored media key is an imported old-app photo (path contains `vendor-import/`). Pure. */
export function isVendorImportKey(key: unknown): boolean {
  return typeof key === 'string' && VENDOR_IMPORT_RE.test(key);
}

/** True when any photo of a capture's formValues is an imported old-app photo. Pure. */
export function isImportedCaptureFormValues(formValues: unknown): boolean {
  if (!formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return false;
  for (const v of Object.values(formValues as Record<string, unknown>)) {
    if (isVendorImportKey(readMediaValue(v).key)) return true;
  }
  return false;
}

type GoLivePrisma = { visibilityCapture: Pick<Prisma.TransactionClient['visibilityCapture'], 'findFirst'> };

/**
 * The tenant's portal go-live month (`YYYY-MM`): the earliest month holding a capture with a submitting rep.
 * null = no portal capture yet. Index-backed: (clientId, windowKey) ascending, first match.
 */
export async function visibilityPortalGoLiveMonth(prisma: GoLivePrisma, clientId: string): Promise<string | null> {
  const first = await prisma.visibilityCapture.findFirst({
    where: { clientId, submittedBySalesUserId: { not: null } },
    orderBy: { windowKey: 'asc' },
    select: { windowKey: true },
  });
  return first?.windowKey ? first.windowKey.slice(0, 7) : null;
}

/**
 * The imported-month rule. Pure.
 *   goLive set  → month < goLive.
 *   goLive null → month holds captures (all imported, since no portal capture exists anywhere).
 */
export function isImportedMonthRule(month: string, goLive: string | null, monthHasCaptures: boolean): boolean {
  if (goLive) return month < goLive;
  return monthHasCaptures;
}

/** Loader form of {@link isImportedMonthRule}: one go-live lookup (+ one count only when there is no go-live). */
export async function isVisibilityImportedMonth(
  prisma: { visibilityCapture: Pick<Prisma.TransactionClient['visibilityCapture'], 'findFirst' | 'count'> },
  clientId: string,
  month: string,
): Promise<boolean> {
  const goLive = await visibilityPortalGoLiveMonth(prisma, clientId);
  if (goLive) return isImportedMonthRule(month, goLive, false);
  const n = await prisma.visibilityCapture.count({ where: { clientId, windowKey: { startsWith: `${month}-P` } } });
  return isImportedMonthRule(month, null, n > 0);
}
