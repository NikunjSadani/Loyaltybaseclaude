import { BadRequestException } from '@nestjs/common';
import type { HubbleProduct } from '../hubble/hubble.service';

/**
 * Per-brand Hubble gift-card amounts (owner-approved 2026-11-11, platform-wide code,
 * effective only for tenants with features.hubbleVoucherEnabled — Bajaj).
 *
 * A Hubble GIFT_CARD catalogue item may carry `metadata.hubbleDenominations: number[]`
 * (whole rupees, ascending) — the amounts the admin chose to offer. Such an item is stored
 * in the FREE_AMOUNT shape (pointsCost 0, points band = [min, max] amount × rate) so every
 * existing variable-amount consumer keeps working, and the redeem paths additionally require
 * the amount to be ONE of the listed values. Pure functions only (no DB / HTTP) — the
 * RewardsService composes them.
 */

const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** The admin-chosen amounts on a catalogue item's metadata ([] when none / malformed). */
export function extractHubbleDenominations(metadata: unknown): number[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const v = (metadata as Record<string, unknown>).hubbleDenominations;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0);
}

/** Validate + canonicalise an admin-supplied amounts list: whole positive rupees, unique, ascending. */
export function normaliseHubbleDenominations(input: unknown[]): number[] {
  const out = new Set<number>();
  for (const x of input) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0) {
      throw new BadRequestException('Gift card amounts must be whole rupees greater than 0.');
    }
    out.add(x);
  }
  if (out.size === 0) throw new BadRequestException('Choose at least one amount to offer.');
  if (out.size > 50) throw new BadRequestException('Offer at most 50 amounts per gift card.');
  return [...out].sort((a, b) => a - b);
}

/**
 * Member-facing projection of the Hubble config (the raw metadata — incl. the productId —
 * is never sent to a member). Returns {} for any non-Hubble item, so a non-Hubble tenant's
 * catalogue response is byte-identical.
 *   amountOptions — the selectable ₹ amounts (only when the admin chose a list)
 */
export function memberHubbleFields(
  metadata: unknown,
  redemptionMode: string | null | undefined,
): { amountOptions?: number[] } {
  if (redemptionMode !== 'GIFT_CARD') return {};
  const denoms = extractHubbleDenominations(metadata);
  return denoms.length ? { amountOptions: denoms } : {};
}

/** A FIXED brand whose face values Hubble did not return — the list is UNKNOWN, not empty. */
export function isFixedListUnknown(product: HubbleProduct): boolean {
  return product.denominationType === 'FIXED' && product.denominations.length === 0;
}

/**
 * True when Hubble can issue ONE voucher of `amount` rupees for this product. FIXED with a known
 * list → must be on it; FIXED with an UNKNOWN list → any whole rupee within the known min/max
 * (Hubble validates the face value itself); FLEXIBLE → whole rupee within min–max.
 */
export function isAmountIssuable(product: HubbleProduct, amount: number): boolean {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  if (product.denominationType === 'FIXED' && !isFixedListUnknown(product)) {
    return product.denominations.includes(amount);
  }
  if (product.minValue != null && amount < product.minValue) return false;
  if (product.maxValue != null && amount > product.maxValue) return false;
  return true;
}

function describeProductAmounts(product: HubbleProduct): string {
  if (product.denominationType === 'FIXED') {
    return product.denominations.length
      ? `fixed amounts only: ${product.denominations.map(fmt).join(', ')}`
      : "fixed amounts only (Hubble didn't return them — enter the amounts Hubble shows for this brand)";
  }
  const lo = product.minValue != null ? fmt(product.minValue) : 'any';
  const hi = product.maxValue != null ? fmt(product.maxValue) : 'any';
  return `any whole-rupee amount from ${lo} to ${hi}`;
}

/**
 * Save-time validation of a Hubble GIFT_CARD item against the LIVE product. Throws a 400 with
 * an admin-readable message on any mismatch. Returns the points band to persist when an
 * amounts list is set (it OVERRIDES any client-sent band), else null (band unchanged).
 *
 *  - amounts list set   → every amount issuable (FIXED: in Hubble's list; FLEXIBLE: within its
 *                         min–max), every amount ≥ the tenant's minimum voucher amount, and the
 *                         band derives as [round(min × rate), round(max × rate)].
 *  - free band, no list → FIXED product: refused (a typed amount can't be guaranteed to be a
 *                         face value — pick amounts). FLEXIBLE: the band (in ₹ = points ÷ rate)
 *                         must sit inside Hubble's min–max.
 *  - fixed price        → the selling value must be a whole rupee Hubble can issue.
 */
export function validateHubbleItemAmounts(
  product: HubbleProduct,
  input: {
    denominations: number[] | null;
    minRedemptionPoints: number | null | undefined;
    maxRedemptionPoints: number | null | undefined;
    sellingValuePaise: number | null | undefined;
    conversionRate: number;
    minVoucherFreeAmount: number;
  },
): { minRedemptionPoints: number; maxRedemptionPoints: number } | null {
  const rate = input.conversionRate;
  const brand = product.name || product.productId;

  if (input.denominations && input.denominations.length) {
    const bad = input.denominations.filter((d) => !isAmountIssuable(product, d));
    if (bad.length) {
      throw new BadRequestException(
        `${brand} on Hubble can't issue ${bad.map(fmt).join(', ')} — it allows ${describeProductAmounts(product)}.`,
      );
    }
    const floor = input.minVoucherFreeAmount || 0;
    const belowFloor = input.denominations.filter((d) => d < floor);
    if (belowFloor.length) {
      throw new BadRequestException(
        `${belowFloor.map(fmt).join(', ')} is below this program's minimum voucher amount (${fmt(floor)}) — members could never redeem it.`,
      );
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException('The tenant conversion rate is not configured, so points for these amounts cannot be set.');
    }
    const min = Math.round(input.denominations[0] * rate);
    const max = Math.round(input.denominations[input.denominations.length - 1] * rate);
    if (min < 1) {
      throw new BadRequestException('The smallest amount resolves to 0 points at this conversion rate — choose a larger amount.');
    }
    return { minRedemptionPoints: min, maxRedemptionPoints: max };
  }

  const isBand = input.minRedemptionPoints != null || input.maxRedemptionPoints != null;
  if (isBand) {
    if (product.denominationType === 'FIXED') {
      throw new BadRequestException(
        `${brand} on Hubble issues ${describeProductAmounts(product)}. Load the brand from Hubble and choose which amounts to offer instead of a free range.`,
      );
    }
    if (!Number.isFinite(rate) || rate <= 0) return null; // the existing guards report the rate problem
    const eps = 1e-9;
    const minInr = input.minRedemptionPoints != null ? input.minRedemptionPoints / rate : null;
    const maxInr = input.maxRedemptionPoints != null ? input.maxRedemptionPoints / rate : null;
    if (
      (minInr != null && product.minValue != null && minInr < product.minValue - eps) ||
      (maxInr != null && product.maxValue != null && maxInr > product.maxValue + eps)
    ) {
      throw new BadRequestException(
        `The amount range must sit inside what ${brand} on Hubble allows (${describeProductAmounts(product)}).`,
      );
    }
    return null;
  }

  if (input.sellingValuePaise != null) {
    const rupees = input.sellingValuePaise / 100;
    if (!isAmountIssuable(product, rupees)) {
      throw new BadRequestException(
        `${brand} on Hubble can't issue a ${Number.isInteger(rupees) ? fmt(rupees) : `₹${rupees}`} voucher — it allows ${describeProductAmounts(product)}.`,
      );
    }
  }
  return null;
}
