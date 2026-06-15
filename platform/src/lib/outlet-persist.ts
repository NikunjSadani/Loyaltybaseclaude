/**
 * outlet-persist.ts
 *
 * PURE mapping layer for the Outlet Master upsert (admin outlet upload → DB).
 * No Prisma, no side-effects — the route (`/api/admin/outlets/upsert`) does the
 * DB lookups (OutletType-by-code, XSR-by-employeeCode) and the writes; this file
 * turns a validated `OutletUploadRow` + resolved ids into the exact column data
 * to persist, so the mapping is unit-testable without a database.
 *
 * Design notes (see Part B brief):
 *   • partnerId is intentionally LEFT NULL — the owner/partner is attached at KYC,
 *     not from the master file. addressLine1/pincode are likewise KYC-captured.
 *   • The reference-only columns (distributorCode/distributorName/beat/metro/zone/
 *     programName/programCategory) are carried straight through for report grouping.
 *   • New outlets are created PENDING — isActive=false — matching the outlet-upload
 *     lib semantics ("additions are created PENDING / isActive=false"). On UPDATE we
 *     do NOT touch isActive (a REACTIVATE flips it true explicitly).
 */

import type { OutletUploadRow } from '@/types';
import type { Prisma } from '@prisma/client';

/** The Outlet column data common to create + update (excludes identity + isActive). */
export interface OutletWriteData {
  outletTypeId: string;
  name: string;
  city: string;
  state: string;
  // reference-only master-file columns
  distributorCode: string | null;
  distributorName: string | null;
  beat: string | null;
  metro: string | null;
  zone: string | null;
  programName: string | null;
  programCategory: string | null;
}

/** "" → null so blank cells don't overwrite with empty strings. */
function nullIfBlank(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Map a validated upload row + resolved OutletType id to the Outlet column data.
 * Caller resolves `outletTypeId` from the row's outletType code (within the
 * tenant) and supplies it here.
 */
export function mapRowToOutletData(row: OutletUploadRow, outletTypeId: string): OutletWriteData {
  return {
    outletTypeId,
    name: row.outletName.trim(),
    city: row.city.trim(),
    state: row.state.trim(),
    distributorCode: nullIfBlank(row.distributorId),
    distributorName: nullIfBlank(row.distributorName),
    beat: nullIfBlank(row.beat),
    metro: nullIfBlank(row.metro),
    zone: nullIfBlank(row.zone),
    programName: nullIfBlank(row.programName),
    programCategory: nullIfBlank(row.programCategory),
  };
}

/**
 * Build the Prisma `create` payload for a new Outlet from the row data.
 * partnerId is omitted (left NULL); new outlets are created PENDING (isActive=false).
 */
export function buildOutletCreate(
  clientId: string,
  outletCode: string,
  data: OutletWriteData,
): Prisma.OutletUncheckedCreateInput {
  return {
    clientId,
    outletCode,
    isActive: false, // PENDING until KYC approval
    ...data,
  };
}

/**
 * Build the Prisma `update` payload for an existing Outlet.
 * Only the mutable master-file columns are written — outletCode/clientId are the
 * identity and isActive is left untouched here (reactivation is handled separately).
 */
export function buildOutletUpdate(data: OutletWriteData): Prisma.OutletUncheckedUpdateInput {
  return { ...data };
}
