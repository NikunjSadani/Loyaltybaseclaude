/**
 * KYC "shop board name vs address proof name do not match" document gating.
 *
 * The Address Proof upload is ALWAYS required — regardless of the mismatch
 * declaration or the tenant's `kycAddressProofWaiver` feature. The waiver's ONLY
 * effect is to drop the extra signed SELF-DECLARATION document that a rep would
 * otherwise have to download, fill, sign, and upload when they declare that the
 * shop-board name and the address-proof name differ:
 *
 *   - waiver OFF (default / every non-waiver tenant): a declared mismatch requires
 *     the signed self-declaration document (the address proof is still required too);
 *   - waiver ON  (e.g. Deoleo): a declared mismatch requires NO self-declaration —
 *     but the Address Proof upload remains mandatory.
 *
 * These are pure predicates so the gating is unit-testable and can't silently
 * regress to "the address proof becomes optional".
 */

/** The Address Proof upload is unconditionally required on the new-KYC form. */
export function isAddressProofRequired(): boolean {
  return true;
}

/**
 * Whether the signed self-declaration document is required. Only when the rep
 * declares the name mismatch AND the tenant does NOT have the waiver feature.
 */
export function isSelfDeclarationRequired(
  waiverEnabled: boolean | undefined,
  nameMismatch: boolean,
): boolean {
  return nameMismatch && !waiverEnabled;
}
