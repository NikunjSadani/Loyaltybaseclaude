import type { HubbleVoucher } from './hubble.service';

/**
 * The recipient-facing credentials of a Hubble voucher (shared by RewardsService and Voucher Dispersal):
 *  - code = card number if present, else the PIN (a PIN-only card's PIN IS its code);
 *  - pin  = the PIN ONLY when BOTH a card number and a PIN are present (card+PIN products such as
 *           CARD_AND_PIN_NO_SECURED) — otherwise null (number-only / PIN-only: unchanged).
 * Values are trimmed; blank counts as absent.
 */
export function hubbleVoucherCredentials(voucher: HubbleVoucher | undefined | null): {
  code: string | null;
  pin: string | null;
} {
  if (!voucher) return { code: null, pin: null };
  const num = (voucher.cardNumber ?? '').toString().trim();
  const pin = (voucher.cardPin ?? '').toString().trim();
  return { code: num || pin || null, pin: num && pin ? pin : null };
}
