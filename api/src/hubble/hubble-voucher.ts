import type { HubbleVoucher } from './hubble.service';

/**
 * Hubble products whose REDEEMABLE credential is the value Hubble returns as `cardPin`; the
 * `cardNumber` it also returns is only the issuer's internal serial and is useless to the
 * recipient. Amazon Pay is the known case: its "PIN" IS the Amazon gift-card claim code
 * (e.g. XXXX-XXXXXX-XXXX) — showing "<serial> | PIN: <claim code>" confused the first prod
 * recipient (2026-11-16). For these products the recipient gets the claim code ALONE, as "the code".
 *
 * Default = the Amazon Pay product id used on both staging and prod. Extend per environment with
 * HUBBLE_CLAIM_CODE_PRODUCT_IDS (comma-separated product ids) — e.g. if a different Amazon SKU is
 * configured in the catalogue or VOUCHER_DISPERSAL_BRANDS — with no code change.
 * Every OTHER product is unchanged (card number + PIN both sent when both exist — the safe
 * default: nothing redeemable is ever dropped).
 */
export const DEFAULT_CLAIM_CODE_PRODUCT_IDS: readonly string[] = ['01HDRPKWFE2SMVM54TWD8S1927'];

export function claimCodeProductIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.HUBBLE_CLAIM_CODE_PRODUCT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_CLAIM_CODE_PRODUCT_IDS, ...extra]);
}

/**
 * The recipient-facing credentials of a Hubble voucher (shared by RewardsService and Voucher Dispersal):
 *  - CLAIM-CODE product (productId in claimCodeProductIds, e.g. Amazon Pay): code = the PIN (the claim
 *    code) when present, else the card number; pin = null — the serial is never shown to the recipient.
 *  - every other product:
 *    - code = card number if present, else the PIN (a PIN-only card's PIN IS its code);
 *    - pin  = the PIN ONLY when BOTH a card number and a PIN are present (card+PIN products such as
 *             CARD_AND_PIN_NO_SECURED) — otherwise null (number-only / PIN-only: unchanged).
 * Values are trimmed; blank counts as absent. productId omitted/unknown → the generic rule.
 */
export function hubbleVoucherCredentials(
  voucher: HubbleVoucher | undefined | null,
  productId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): {
  code: string | null;
  pin: string | null;
  /**
   * Set when a CLAIM-CODE product arrived WITHOUT its claim code (cardPin) and the card number was
   * used instead — the recipient may get an unusable serial. Callers MUST surface it loudly
   * (error log + audit), never silently (owner rule: no silent pass-through).
   */
  claimCodeMissing?: true;
} {
  if (!voucher) return { code: null, pin: null };
  const num = (voucher.cardNumber ?? '').toString().trim();
  const pin = (voucher.cardPin ?? '').toString().trim();
  const pid = (productId ?? '').trim();
  if (pid && claimCodeProductIds(env).has(pid)) {
    if (!pin && num) return { code: num, pin: null, claimCodeMissing: true };
    return { code: pin || null, pin: null };
  }
  return { code: num || pin || null, pin: num && pin ? pin : null };
}
