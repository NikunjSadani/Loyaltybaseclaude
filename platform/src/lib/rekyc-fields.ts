/**
 * Canonical re-KYC field map — SINGLE SOURCE OF TRUTH (frontend).
 *
 * Keyed by the `reKycFlags` boolean key stored on `Outlet.reKycFlags` (the admin's
 * per-field re-KYC request). Drives BOTH:
 *   - the sales KYC wizard: which field is editable + highlighted on re-entry, and
 *   - the approver highlight (sales-senior detail + Gifsy reviewer): what was requested.
 *
 * MUST stay in sync with:
 *   - the backend map            api/src/common/rekyc-fields.ts
 *   - the ReKycFlags interface    api/src/admin-outlets/admin-outlets.service.ts
 *   - KYC_FIELD_TO_REKYCFLAGS     api/src/kyc/kyc.service.ts (group membership)
 *
 * NOTE: the previous ad-hoc wizard highlight referenced the WRONG keys for three
 * fields (`businessDoc`/`mobile`/`shopAddressDoc` instead of `gstCertificate`/
 * `mobileNumber`/`addressProof`), so those never highlighted. This map is the fix —
 * consume it via isWizardFieldFlagged/isWizardFieldEditable, never index reKycFlags
 * by a wizard key directly.
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

/** The 7 Gifsy field-verification groups (mirror of KYC_FIELD_TO_REKYCFLAGS). */
export type ReKycFieldGroup =
  | 'PAYMENT'
  | 'GST_VALIDATION'
  | 'GST_DOCUMENT'
  | 'ADDRESS'
  | 'ADDRESS_DOCUMENT'
  | 'BOARD_PHOTO'
  | 'OWNER_PHOTO';

export interface ReKycFieldDef {
  /** wizard `form` state key (text fields). Absent for document / identity flags. */
  formKey?: string;
  /** wizard document-slot key (DOC_TYPE_MAP key). Absent for text / identity flags. */
  docKey?: string;
  /** Prisma DocumentType for document flags (matches the KYC document `type`). Absent for text flags. */
  docType?: string;
  /** human label for badges / approver highlight. */
  label: string;
  /** Gifsy 7-field review group, or null when the flag has no group. */
  group: ReKycFieldGroup | null;
}

/** All 20 re-KYC flag keys, in a stable display order (identity → GST → address → payment → docs). */
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
 * The canonical definition per flag. `Record<ReKycFlagKey, …>` makes TypeScript enforce
 * that all 20 keys are present — a missing key is a compile error.
 *
 * `outletName` has NO wizard field: the outlet name lives on the Outlet master (edited by
 * the admin master-data upload), not the KYC wizard, so it can't be self-corrected here.
 * It is still surfaced in the approver highlight when flagged.
 */
export const REKYC_FIELDS: Record<ReKycFlagKey, ReKycFieldDef> = {
  outletName: { label: 'Outlet Name', group: null },
  ownerName: { formKey: 'partnerName', label: 'Owner Name', group: null },
  mobileNumber: { formKey: 'mobile', label: 'Mobile Number', group: null },
  gstNumber: { formKey: 'gstNumber', label: 'GST Number', group: 'GST_VALIDATION' },
  panNumber: { formKey: 'panNumber', label: 'PAN Number', group: 'GST_VALIDATION' },
  streetAddress: { formKey: 'address', label: 'Street Address', group: 'ADDRESS' },
  city: { formKey: 'city', label: 'City', group: 'ADDRESS' },
  pincode: { formKey: 'pincode', label: 'Pincode', group: 'ADDRESS' },
  state: { formKey: 'state', label: 'State', group: 'ADDRESS' },
  bankName: { formKey: 'bankName', label: 'Bank Name', group: 'PAYMENT' },
  accountHolderName: { formKey: 'accountHolderName', label: 'Account Holder Name', group: 'PAYMENT' },
  accountNumber: { formKey: 'accountNumber', label: 'Account Number', group: 'PAYMENT' },
  ifscCode: { formKey: 'ifscCode', label: 'IFSC Code', group: 'PAYMENT' },
  upiId: { formKey: 'upiId', label: 'UPI ID', group: 'PAYMENT' },
  gstCertificate: { docKey: 'businessDoc', docType: 'GST_CERTIFICATE', label: 'GST Certificate', group: 'GST_DOCUMENT' },
  ownerPhoto: { docKey: 'ownerPhoto', docType: 'SELFIE', label: 'Owner Photo', group: 'OWNER_PHOTO' },
  addressProof: { docKey: 'shopAddressDoc', docType: 'SHOP_ESTABLISHMENT', label: 'Shop & Establishment Proof', group: 'ADDRESS_DOCUMENT' },
  storeBoardPhoto: { docKey: 'storeBoardPhoto', docType: 'STORE_BOARD_PHOTO', label: 'Store Board Photo', group: 'BOARD_PHOTO' },
  cancelledCheque: { docKey: 'cheque', docType: 'CANCELLED_CHEQUE', label: 'Cancelled Cheque', group: 'PAYMENT' },
  selfDeclaration: { docKey: 'selfDeclaration', docType: 'SELF_DECLARATION', label: 'Self Declaration', group: 'ADDRESS_DOCUMENT' },
};

/** The raw shape stored on Outlet.reKycFlags (20 booleans + a remarks string). */
export type ReKycFlags =
  | (Partial<Record<ReKycFlagKey, boolean>> & { remarks?: string })
  | null
  | undefined;

/** True when at least one field boolean is set (ignores `remarks`). This — not a bare
 *  null check — is the "re-KYC pending" signal, because a flags object always carries a
 *  `remarks` key even when no field is flagged. */
export function hasReKycFlags(flags: ReKycFlags): boolean {
  if (!flags || typeof flags !== 'object') return false;
  return REKYC_FIELD_KEYS.some((k) => flags[k] === true);
}

/** The admin's free-text re-KYC remark, or '' if none. */
export function reKycRemarks(flags: ReKycFlags): string {
  return flags && typeof flags.remarks === 'string' ? flags.remarks : '';
}

/** The flagged keys (booleans that are true), in canonical order. */
export function flaggedKeys(flags: ReKycFlags): ReKycFlagKey[] {
  if (!flags) return [];
  return REKYC_FIELD_KEYS.filter((k) => flags[k] === true);
}

/** Is a wizard field (looked up by its form key OR doc key) flagged for re-KYC? */
export function isWizardFieldFlagged(flags: ReKycFlags, wizardKey: string): boolean {
  if (!hasReKycFlags(flags)) return false;
  return flaggedKeys(flags).some((k) => {
    const d = REKYC_FIELDS[k];
    return d.formKey === wizardKey || d.docKey === wizardKey;
  });
}

/**
 * Editability of a mapped KYC field during wizard re-entry:
 *   - no field flags present (first-time OR blanket rejection) → editable (full form)
 *   - field flags present → editable ONLY if THIS field is the one the admin flagged
 *
 * NOTE: this governs the MAPPED KYC data fields only. The consent step (OTP, signature,
 * terms) is always re-collected on resubmit and must stay active regardless.
 */
export function isWizardFieldEditable(flags: ReKycFlags, wizardKey: string): boolean {
  if (!hasReKycFlags(flags)) return true;
  return isWizardFieldFlagged(flags, wizardKey);
}

/** Human labels of the flagged fields (approver highlight + wizard summary). */
export function flaggedLabels(flags: ReKycFlags): string[] {
  return flaggedKeys(flags).map((k) => REKYC_FIELDS[k].label);
}

/** Prisma DocumentType values whose flag is set — to badge flagged document tabs/rows in the reviewer. */
export function flaggedDocTypes(flags: ReKycFlags): string[] {
  const types = new Set<string>();
  for (const k of flaggedKeys(flags)) {
    const t = REKYC_FIELDS[k].docType;
    if (t) types.add(t);
  }
  return [...types];
}

/** Flagged Gifsy review groups (dedup), for the 7-field reviewer highlight. */
export function flaggedGroups(flags: ReKycFlags): ReKycFieldGroup[] {
  const gs = new Set<ReKycFieldGroup>();
  for (const k of flaggedKeys(flags)) {
    const g = REKYC_FIELDS[k].group;
    if (g) gs.add(g);
  }
  return [...gs];
}
