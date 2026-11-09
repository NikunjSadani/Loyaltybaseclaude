import { BadRequestException } from '@nestjs/common';
import { Prisma, RedemptionStatus } from '@prisma/client';

/**
 * VOUCHER WRITE INVARIANT (owner money rule) — the ONE server-side gate every voucher write
 * goes through (rewards updateOrder + transitionOrder — hence the bulk fulfilment upload and the
 * gift-catalogue dispatch controller — and the vendor portal updateFulfilment + transition):
 *
 *   A stored voucher code can never be cleared or replaced, except by
 *   POST /rewards/orders/:id/voucher-cancelled ("Voucher cancelled with vendor").
 *
 * Concretely, for an incoming voucherCode / voucherProvider:
 *  - omitted (undefined)      → no change;
 *  - null / blank after trim  → 400 (a "clear" is never a write — it would lift the refund block);
 *  - identical to the stored  → no-op (an idempotent re-send, e.g. a re-uploaded filled sheet);
 *  - a code when one is stored → 400 (no overwrite);
 *  - a NEW code only on a paid, open order: CONFIRMED / PROCESSING / DISPATCHED with
 *    pointsDeducted > 0 — and the write is a compare-and-set on exactly that (plus "no code
 *    stored"), so a concurrent refund / vendor-cancel / other write makes it lose (0 rows → 409);
 *  - a stored Hubble provider never changes, and 'Hubble' is never set by hand (integration only);
 *    a provider change on an order that already holds a code is refused like a code overwrite.
 */

export const VOUCHER_WRITABLE_STATUSES: readonly RedemptionStatus[] = [
  RedemptionStatus.CONFIRMED,
  RedemptionStatus.PROCESSING,
  RedemptionStatus.DISPATCHED,
];

export const VOUCHER_ALREADY_ISSUED_MESSAGE =
  "A voucher code is already issued; use 'Voucher cancelled with vendor' first.";
export const VOUCHER_BLANK_MESSAGE =
  "A voucher code / provider can't be cleared or blank — use 'Voucher cancelled with vendor' to cancel an issued code.";
export const VOUCHER_STATUS_MESSAGE =
  'A voucher code can only be issued on a confirmed, paid order (CONFIRMED / PROCESSING / DISPATCHED).';
export const HUBBLE_PROVIDER_MESSAGE =
  'The Hubble provider is set by the integration and cannot be changed by hand.';
export const VOUCHER_WRITE_CONFLICT_MESSAGE = 'The order changed — refresh and try again.';

export interface VoucherWriteInput {
  voucherCode?: string | null;
  voucherProvider?: string | null;
}

export interface VoucherOrderState {
  status: RedemptionStatus | string;
  voucherCode: string | null;
  voucherProvider: string | null;
  pointsDeducted: number;
}

export interface VoucherWritePlan {
  /** Only the voucher columns that actually change (trimmed). Spread into the write's `data`. */
  data: { voucherCode?: string; voucherProvider?: string };
  /** Claim predicate to AND into the write's `where` (null = no voucher write → no extra guard). */
  guard: Prisma.RedemptionOrderWhereInput | null;
}

const isBlank = (v: string | null | undefined) => v === null || (typeof v === 'string' && v.trim() === '');
const stored = (v: string | null | undefined) => (v != null && v !== '' ? v : null);

/**
 * Validate + plan the voucher part of a write against the order as READ. Throws 400 on a rule
 * violation; returns the columns to write and the CAS predicate the write must carry.
 */
export function planVoucherWrite(order: VoucherOrderState, input: VoucherWriteInput): VoucherWritePlan {
  const data: VoucherWritePlan['data'] = {};
  if (input.voucherCode === undefined && input.voucherProvider === undefined) return { data, guard: null };

  if (input.voucherCode !== undefined && isBlank(input.voucherCode)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);
  if (input.voucherProvider !== undefined && isBlank(input.voucherProvider)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);

  const storedCode = stored(order.voucherCode);
  const storedProvider = stored(order.voucherProvider);
  const code = input.voucherCode?.trim();
  const provider = input.voucherProvider?.trim();

  // Hubble: never relabel a stored Hubble provider; never hand-set 'Hubble'.
  if (provider !== undefined && provider !== storedProvider) {
    if (storedProvider === 'Hubble' || provider === 'Hubble') throw new BadRequestException(HUBBLE_PROVIDER_MESSAGE);
  }

  const codeChanges = code !== undefined && code !== storedCode;
  const providerChanges = provider !== undefined && provider !== storedProvider;
  if (!codeChanges && !providerChanges) return { data, guard: null }; // idempotent re-send

  // Anything that changes the voucher on an order that already holds a code is a replace.
  if (storedCode !== null) throw new BadRequestException(VOUCHER_ALREADY_ISSUED_MESSAGE);

  if (!VOUCHER_WRITABLE_STATUSES.includes(order.status as RedemptionStatus) || !(order.pointsDeducted > 0)) {
    throw new BadRequestException(VOUCHER_STATUS_MESSAGE);
  }

  if (codeChanges) data.voucherCode = code;
  if (providerChanges) data.voucherProvider = provider;
  return {
    data,
    guard: {
      AND: [
        { OR: [{ voucherCode: null }, { voucherCode: '' }] },
        { status: { in: [...VOUCHER_WRITABLE_STATUSES] } },
        { pointsDeducted: { gt: 0 } },
        // The provider read is part of the claim too (a concurrent Hubble stamp loses).
        storedProvider === null
          ? { OR: [{ voucherProvider: null }, { voucherProvider: '' }] }
          : { voucherProvider: storedProvider },
      ],
    },
  };
}

/** AND together optional claim predicates (undefined when there are none). */
export function combineGuards(
  ...guards: (Prisma.RedemptionOrderWhereInput | null | undefined)[]
): Prisma.RedemptionOrderWhereInput | undefined {
  const present = guards.filter((g): g is Prisma.RedemptionOrderWhereInput => !!g);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { AND: present };
}
