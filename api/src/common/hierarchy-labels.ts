/**
 * Bajaj-only sales-hierarchy nomenclature layer (Stream BE of the Bajaj hierarchy rename).
 *
 * Internal role codes stay XSR/SO/ASM/RSM/ZNM/NSM EVERYWHERE — they are the machine identifiers
 * (hierarchyLevel.code, the resolveRungs buckets, mapRoleCodeToUserRole). For the bajaj tenant
 * ONLY we show different DISPLAY labels and column HEADERS; every other tenant (incl. live Deoleo)
 * resolves to the code-based defaults, so output is byte-identical.
 *
 * Canonical mapping (platform/docs/plans/BAJAJ-HIERARCHY-RENAME.md — the single source of truth):
 *   code  bajaj label   bajaj ID header
 *   XSR   ISR           ISR Code
 *   SO    SO            SO HQ
 *   ASM   ASM           ASM HQ
 *   RSM   SM            SM HQ
 *   ZNM   ZH            ZH HQ
 *   NSM   NSM           NSM HQ
 *
 * Tenant detection: Client.id IS the tenant slug (schema.prisma: "id = the tenant slug ... e.g.
 * 'deoleo'"), and `clientId` on every JWT and model equals that slug. So the slug is the clientId
 * already in hand — no extra DB read, and no hardcoded cuid.
 */

/** The bajaj tenant slug (= Client.id). */
export const BAJAJ_SLUG = 'bajaj';

/** True when the caller's tenant is bajaj (clientId === slug). */
export function isBajajTenant(clientId: string | null | undefined): boolean {
  return (clientId ?? '').trim().toLowerCase() === BAJAJ_SLUG;
}

/** The six internal rung codes, lowest → highest. Unchanged for every tenant. */
export const HIERARCHY_RUNG_CODES = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'] as const;
export type HierarchyRungCode = (typeof HIERARCHY_RUNG_CODES)[number];

interface BajajRungLabel {
  /** Shown in UI + used as the Name/Phone column prefix. */
  displayLabel: string;
  /** The ID-column header (NOT uniform — XSR→"ISR Code", the rest →"<label> HQ"). */
  idHeader: string;
}

/** Bajaj-only per-code label overrides. A code absent here falls back to the code-based default. */
const BAJAJ_RUNG_LABELS: Record<HierarchyRungCode, BajajRungLabel> = {
  XSR: { displayLabel: 'ISR', idHeader: 'ISR Code' },
  SO: { displayLabel: 'SO', idHeader: 'SO HQ' },
  ASM: { displayLabel: 'ASM', idHeader: 'ASM HQ' },
  RSM: { displayLabel: 'SM', idHeader: 'SM HQ' },
  ZNM: { displayLabel: 'ZH', idHeader: 'ZH HQ' },
  NSM: { displayLabel: 'NSM', idHeader: 'NSM HQ' },
};

/** Display label for a rung code (UI + Name/Phone prefix). Non-bajaj = the code itself. */
export function rungDisplayLabel(clientId: string | null | undefined, code: string): string {
  if (isBajajTenant(clientId)) {
    const o = BAJAJ_RUNG_LABELS[code.trim().toUpperCase() as HierarchyRungCode];
    if (o) return o.displayLabel;
  }
  return code;
}

/** ID-column header for a rung. Non-bajaj = `${code} ID`; bajaj per the mapping. */
export function rungIdHeader(clientId: string | null | undefined, code: string): string {
  if (isBajajTenant(clientId)) {
    const o = BAJAJ_RUNG_LABELS[code.trim().toUpperCase() as HierarchyRungCode];
    if (o) return o.idHeader;
  }
  return `${code} ID`;
}

/** Name-column header = `${displayLabel} Name` (byte-identical to `${code} Name` for non-bajaj). */
export function rungNameHeader(clientId: string | null | undefined, code: string): string {
  return `${rungDisplayLabel(clientId, code)} Name`;
}

/**
 * BE phone-column header = `${displayLabel} Phone Number`
 * (byte-identical to `${code} Phone Number` for non-bajaj). The FE uses just "Phone".
 */
export function rungPhoneHeader(clientId: string | null | undefined, code: string): string {
  return `${rungDisplayLabel(clientId, code)} Phone Number`;
}

/**
 * Friendly label for a COARSE sales UserRole (the User.role enum), used by the reviewer /
 * actor labels in the reports. The coarse enum is lossy — SALES_STATE_HEAD covers BOTH RSM
 * and ZNM — so this mirrors the pre-existing Deoleo collapse (SALES_STATE_HEAD → 'RSM') and
 * for bajaj swaps only that bucket to its bajaj label ('SM'). Returns undefined for a role
 * this map does not cover (the caller keeps its own fallbacks for GIFSY/CLIENT_ADMIN/…).
 */
export function salesUserRoleLabel(
  clientId: string | null | undefined,
  role: string | null | undefined,
): string | undefined {
  switch (role) {
    case 'SALES_HO':
      return 'NSM';
    case 'SALES_STATE_HEAD':
      return isBajajTenant(clientId) ? 'SM' : 'RSM';
    case 'SALES_ASM':
      return 'ASM';
    case 'SALES_SO':
      return 'SO';
    case 'SALES_ISR':
      return 'ISR';
    default:
      return undefined;
  }
}
