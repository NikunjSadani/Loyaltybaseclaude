/**
 * Canonical re-KYC field map — SINGLE SOURCE OF TRUTH (backend).
 *
 * Keyed by the `reKycFlags` boolean key stored on `Outlet.reKycFlags` (the admin's
 * per-field re-KYC request). Drives the backend-enforced re-KYC LOCK: on resubmit, a
 * non-flagged field's value is pinned to what is already stored — a tampered payload
 * cannot change a field the admin did not flag.
 *
 * MUST stay in sync with:
 *   - the frontend map           platform/src/lib/rekyc-fields.ts
 *   - the ReKycFlags interface    api/src/admin-outlets/admin-outlets.service.ts
 *   - KYC_FIELD_TO_REKYCFLAGS     api/src/kyc/kyc.service.ts (group membership)
 *
 * The `docType` strings below MUST match the KYC document `type` values used in the
 * submit payload (Prisma DocumentType): GST_CERTIFICATE, SELFIE, SHOP_ESTABLISHMENT,
 * STORE_BOARD_PHOTO, CANCELLED_CHEQUE, SELF_DECLARATION.
 */

export type ReKycFlagKey =
  | 'outletName'
  | 'ownerName'
  | 'mobileNumber'
  | 'gstNumber'
  | 'panNumber'
  | 'streetAddress'
  | 'city'
  | 'pincode'
  | 'state'
  | 'bankName'
  | 'accountHolderName'
  | 'accountNumber'
  | 'ifscCode'
  | 'upiId'
  | 'gstCertificate'
  | 'ownerPhoto'
  | 'addressProof'
  | 'storeBoardPhoto'
  | 'cancelledCheque'
  | 'selfDeclaration';

export type ReKycFieldGroup =
  | 'PAYMENT'
  | 'GST_VALIDATION'
  | 'GST_DOCUMENT'
  | 'ADDRESS'
  | 'ADDRESS_DOCUMENT'
  | 'BOARD_PHOTO'
  | 'OWNER_PHOTO';

export interface ReKycFieldDef {
  /** CreateKycDto property carrying this value (text fields only). */
  dtoField?: string;
  /** KYC document `type` (DocumentType) for document flags. */
  docType?: string;
  /** Gifsy 7-field review group, or null. */
  group: ReKycFieldGroup | null;
  /** human label (errors / logs). */
  label: string;
}

export const REKYC_FIELD_KEYS: ReKycFlagKey[] = [
  'outletName',
  'ownerName',
  'mobileNumber',
  'gstNumber',
  'panNumber',
  'streetAddress',
  'city',
  'pincode',
  'state',
  'bankName',
  'accountHolderName',
  'accountNumber',
  'ifscCode',
  'upiId',
  'gstCertificate',
  'ownerPhoto',
  'addressProof',
  'storeBoardPhoto',
  'cancelledCheque',
  'selfDeclaration',
];

/**
 * `Record<ReKycFlagKey, …>` makes TypeScript enforce all 20 keys are present.
 * `outletName` has no dtoField/docType: the outlet name is master data, not a KYC field.
 */
export const REKYC_FIELDS: Record<ReKycFlagKey, ReKycFieldDef> = {
  outletName: { group: null, label: 'Outlet Name' },
  ownerName: { dtoField: 'partnerName', group: null, label: 'Owner Name' },
  mobileNumber: { dtoField: 'mobile', group: null, label: 'Mobile Number' },
  gstNumber: { dtoField: 'gstNumber', group: 'GST_VALIDATION', label: 'GST Number' },
  panNumber: { dtoField: 'panNumber', group: 'GST_VALIDATION', label: 'PAN Number' },
  streetAddress: { dtoField: 'address', group: 'ADDRESS', label: 'Street Address' },
  city: { dtoField: 'city', group: 'ADDRESS', label: 'City' },
  pincode: { dtoField: 'pincode', group: 'ADDRESS', label: 'Pincode' },
  state: { dtoField: 'state', group: 'ADDRESS', label: 'State' },
  bankName: { dtoField: 'bankName', group: 'PAYMENT', label: 'Bank Name' },
  accountHolderName: { dtoField: 'accountHolderName', group: 'PAYMENT', label: 'Account Holder Name' },
  accountNumber: { dtoField: 'accountNumber', group: 'PAYMENT', label: 'Account Number' },
  ifscCode: { dtoField: 'ifscCode', group: 'PAYMENT', label: 'IFSC Code' },
  upiId: { dtoField: 'upiId', group: 'PAYMENT', label: 'UPI ID' },
  gstCertificate: { docType: 'GST_CERTIFICATE', group: 'GST_DOCUMENT', label: 'GST Certificate' },
  ownerPhoto: { docType: 'SELFIE', group: 'OWNER_PHOTO', label: 'Owner Photo' },
  addressProof: { docType: 'SHOP_ESTABLISHMENT', group: 'ADDRESS_DOCUMENT', label: 'Shop & Establishment Proof' },
  storeBoardPhoto: { docType: 'STORE_BOARD_PHOTO', group: 'BOARD_PHOTO', label: 'Store Board Photo' },
  cancelledCheque: { docType: 'CANCELLED_CHEQUE', group: 'PAYMENT', label: 'Cancelled Cheque' },
  selfDeclaration: { docType: 'SELF_DECLARATION', group: 'ADDRESS_DOCUMENT', label: 'Self Declaration' },
};

export type ReKycFlags =
  | (Partial<Record<ReKycFlagKey, boolean>> & { remarks?: string })
  | null
  | undefined;

/** True when at least one field boolean is set (ignores `remarks`). The "re-KYC pending"
 *  signal — mirrors isReKycPending() but flag-aware, not just key-count. */
export function hasReKycFlags(flags: ReKycFlags): boolean {
  if (!flags || typeof flags !== 'object') return false;
  return REKYC_FIELD_KEYS.some((k) => flags[k] === true);
}

/** Flagged keys (true booleans), in canonical order. */
export function flaggedKeys(flags: ReKycFlags): ReKycFlagKey[] {
  if (!flags) return [];
  return REKYC_FIELD_KEYS.filter((k) => flags[k] === true);
}

/** dtoField names that ARE flagged (editable text fields). */
export function flaggedDtoFields(flags: ReKycFlags): string[] {
  return flaggedKeys(flags)
    .map((k) => REKYC_FIELDS[k].dtoField)
    .filter((f): f is string => !!f);
}

/**
 * Document `type` values the rep is ALLOWED to (re)submit on this resubmission:
 *   - no field flags (first-time / blanket) → null, meaning "all documents allowed"
 *   - field flags present → only the flagged document types
 * A null return is the caller's signal to process every document unchanged.
 */
export function allowedDocTypes(flags: ReKycFlags): Set<string> | null {
  if (!hasReKycFlags(flags)) return null;
  return new Set(
    flaggedKeys(flags)
      .map((k) => REKYC_FIELDS[k].docType)
      .filter((t): t is string => !!t),
  );
}

/** Normalise a stored/incoming scalar for lock comparison (null/''/undefined collapse). */
function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

export interface ReKycLockResult<T> {
  /** the values to persist: non-flagged text fields pinned to `stored`, flagged taken from `incoming`. */
  effective: T;
  /** dtoFields whose incoming value differed from stored but were LOCKED back (tamper/observability signal). */
  blocked: string[];
}

/**
 * Enforce the re-KYC lock on the TEXT fields of a resubmission.
 *
 * Fail-safe by design: a non-flagged field can NEVER change — its incoming value is
 * discarded in favour of what is already stored — so a hand-crafted payload cannot edit a
 * field the admin did not flag. Returns the blocked field names so the caller can log a
 * warning (we pin rather than 400 to avoid false positives from formatting drift; the FE
 * never legitimately sends a changed non-flagged value because it pre-fills from `stored`).
 *
 * Only meaningful when hasReKycFlags(flags) is true; with no flags the whole form is
 * editable, so `incoming` passes through untouched.
 *
 * @param flags     the outlet's current reKycFlags
 * @param incoming  the incoming DTO (a subset with the mapped text dtoFields)
 * @param stored    the currently-persisted values, keyed by the SAME dtoField names
 */
export function applyReKycTextLock<T extends Record<string, unknown>>(
  flags: ReKycFlags,
  incoming: T,
  stored: Record<string, unknown>,
): ReKycLockResult<T> {
  if (!hasReKycFlags(flags)) return { effective: incoming, blocked: [] };
  const flagged = new Set(flaggedDtoFields(flags));
  const effective: Record<string, unknown> = { ...incoming };
  const blocked: string[] = [];
  for (const key of REKYC_FIELD_KEYS) {
    const dtoField = REKYC_FIELDS[key].dtoField;
    if (!dtoField || flagged.has(dtoField)) continue; // unmapped or flagged → leave as incoming
    // Only pin fields the incoming payload actually carries (don't invent keys).
    if (!(dtoField in incoming)) continue;
    if (norm(incoming[dtoField]) !== norm(stored[dtoField])) blocked.push(dtoField);
    effective[dtoField] = stored[dtoField];
  }
  return { effective: effective as T, blocked };
}
