import { ConflictException } from '@nestjs/common';
import { Prisma, RedemptionOrder, RedemptionStatus } from '@prisma/client';
import { PAN_NORMALISE_SQL } from '../tds/tds-194r.shared';
import { returnStockForOrder } from './reward-stock';

/**
 * THE single write path for `RedemptionOrder.status` (order-timeline plan, owner D1).
 *
 * Every status change — partner confirm, admin/vendor transition, Hubble, cash UTR upload,
 * auto-supersede / OTP-fail cancel — goes through `transitionOrderStatus`, which updates the
 * order AND inserts its `RedemptionStatusHistory` row in the SAME transaction client, so the
 * partner's order timeline always has a dated row for every transition (forward-only: no
 * backfill of legacy gaps).
 *
 * Two forms:
 *  - UNGUARDED (`guard` omitted): `redemptionOrder.update({ where: { id } })` — throws if the
 *    row is missing, returns the updated row. History is skipped only for a same-status no-op
 *    (`fromStatus === toStatus`), e.g. re-marking an already-FAILED order FAILED.
 *  - GUARDED (`guard` set): an atomic claim `updateMany({ where: { id, ...guard } })` — returns
 *    `{ count }`; history is written ONLY when the claim won (count > 0), so a lost race / an
 *    idempotent re-run never leaves a phantom row.
 *  - COMPARE-AND-SET (`transitionOrderStatusOrConflict`, below): the guarded form keyed on the
 *    status the caller read; a lost claim throws 409. Used by the manual admin + vendor
 *    transitions so a stale read / concurrent click can never apply two transitions.
 *
 * Callers keep their own money logic (refund claims, debits) untouched; this owns the status
 * column + its audit row + the STOCK RETURN on a move to CANCELLED / FAILED / RETURNED
 * (reward-stock.ts returnStockForOrder — once per order, same tx). `fromStatus: null` = "not known at the call site" (the
 * member timeline uses `toStatus` only). Never put member-visible text in `notes` — it is
 * ops-only and the member `/track` projection never selects it.
 */
type Tx = Prisma.TransactionClient;

interface TransitionCommon {
  orderId: string;
  fromStatus: RedemptionStatus | null;
  toStatus: RedemptionStatus;
  changedById?: string | null;
  notes?: string | null;
}

export interface UnguardedTransition extends TransitionCommon {
  guard?: undefined;
  /** Extra columns written with the status (never `status` itself). */
  data?: Omit<Prisma.RedemptionOrderUpdateInput, 'status'>;
}

export interface GuardedTransition extends TransitionCommon {
  /** Extra `where` conditions ANDed with `{ id: orderId }` — the atomic claim predicate. */
  guard: Prisma.RedemptionOrderWhereInput;
  data?: Omit<Prisma.RedemptionOrderUpdateManyMutationInput, 'status'>;
}

export function transitionOrderStatus(tx: Tx, args: GuardedTransition): Promise<{ count: number }>;
export function transitionOrderStatus(tx: Tx, args: UnguardedTransition): Promise<RedemptionOrder>;
export async function transitionOrderStatus(
  tx: Tx,
  args: GuardedTransition | UnguardedTransition,
): Promise<{ count: number } | RedemptionOrder> {
  const { orderId, fromStatus, toStatus } = args;
  const history = () =>
    tx.redemptionStatusHistory.create({
      data: {
        orderId,
        fromStatus,
        toStatus,
        changedById: args.changedById ?? null,
        notes: args.notes ?? null,
      },
    });

  // STOCK RETURN (owner 2026-11-26): every move to CANCELLED / FAILED / RETURNED gives the order's taken stock back,
  // once, in this same tx — every refund path writes its status through here, so none can skip it.
  const stockReturn = () =>
    REFUND_TARGET_STATUSES.has(toStatus)
      ? returnStockForOrder(tx, { orderId, fromStatus, toStatus, actorId: args.changedById ?? null })
      : Promise.resolve();

  if (args.guard) {
    const claim = await tx.redemptionOrder.updateMany({
      where: { id: orderId, ...args.guard },
      data: { status: toStatus, ...(args.data ?? {}) },
    });
    if (claim.count > 0) {
      await history();
      if (toStatus === RedemptionStatus.DELIVERED) await snapshotPayee(tx, orderId);
      await stockReturn();
    }
    return claim;
  }

  const updated = await tx.redemptionOrder.update({
    where: { id: orderId },
    data: { status: toStatus, ...(args.data ?? {}) },
  });
  if (fromStatus !== toStatus) await history();
  if (toStatus === RedemptionStatus.DELIVERED) await snapshotPayee(tx, orderId);
  if (fromStatus !== toStatus) await stockReturn();
  return updated;
}

/**
 * TDS payee SNAPSHOT at delivery (owner rule 2026-11-18: TDS is keyed by PAN; a PAN change splits the year
 * at the change). Records the partner's normalised PAN (upper/trim) — or, without a real PAN, the no-PAN
 * owner key `__NO_PAN__:<partnerId>` — on the order, in the same tx as the DELIVERED move. Same rule as
 * the 20261118180000_tds_payee_snapshot backfill. Write-once: an order that already has a payeePan keeps it.
 */
async function snapshotPayee(tx: Tx, orderId: string): Promise<void> {
  const pan = PAN_NORMALISE_SQL('p."panNumber"');
  // A-L2: a plain prefix compare (left(...) <> '__NO_PAN__'), no LIKE escaping.
  await tx.$executeRaw(
    Prisma.sql(
      [
        `UPDATE "redemption_orders" AS r SET "payeePartnerId" = r."partnerId", "payeePan" = CASE WHEN p."panNumber" IS NOT NULL AND ${pan} <> '' AND left(${pan}, 10) <> '__NO_PAN__' THEN ${pan} ELSE '__NO_PAN__:' || r."partnerId" END FROM "channel_partners" AS p WHERE r."id" = `,
        // Only while not yet snapshotted: a DELIVERED → DELIVERED re-transition never re-keys the order.
        ` AND r."payeePan" IS NULL AND p."id" = r."partnerId"`,
      ],
      orderId,
    ),
  );
}

export const ORDER_STATUS_CONFLICT_MESSAGE = 'Order status changed — refresh and try again';

/**
 * ISSUED-VOUCHER REFUND BLOCK (owner money rule, all voucher providers).
 *
 * A voucher code is a live bearer credential the member already holds: refunding the points
 * (CANCELLED / RETURNED / FAILED) while it stands is a double benefit. Every refund edge on an
 * order with an issued code is therefore rejected until ops records "Voucher cancelled with
 * vendor" (RewardsService.voucherCancelledWithVendor), which clears the code under audit.
 * The status claim additionally carries NO_ISSUED_VOUCHER_GUARD so a code set concurrently
 * (between the read and the write) makes the refund lose with a 409 instead of slipping through.
 */
export const REFUND_TARGET_STATUSES: ReadonlySet<RedemptionStatus> = new Set([
  RedemptionStatus.CANCELLED,
  RedemptionStatus.RETURNED,
  RedemptionStatus.FAILED,
]);

export const VOUCHER_ISSUED_REFUND_BLOCK_MESSAGE =
  "A voucher code was issued for this order. Record 'Voucher cancelled with vendor' first, then refund.";

/**
 * True when a voucher code is stored on the order. ONE notion everywhere (here, planVoucherWrite,
 * the FE): null, '' and whitespace-only are all "no code".
 */
export function hasIssuedVoucher(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.trim() !== '';
}

/** Claim predicate: the row holds NO issued voucher code (null / '') at write time. */
export const NO_ISSUED_VOUCHER_GUARD: Prisma.RedemptionOrderWhereInput = {
  OR: [{ voucherCode: null }, { voucherCode: '' }],
};

/**
 * The no-issued-voucher claim for a row whose code was READ as `readCode`. Identical to
 * NO_ISSUED_VOUCHER_GUARD, except for a legacy whitespace-only value ("no code" by
 * hasIssuedVoucher): Prisma can't trim, so the claim pins that exact value instead — the read
 * check and the claim then agree (no permanent 409 loop), and a real code written concurrently
 * still makes the claim lose.
 */
export function noIssuedVoucherGuard(readCode: string | null | undefined): Prisma.RedemptionOrderWhereInput {
  if (typeof readCode === 'string' && readCode !== '' && readCode.trim() === '') {
    return { voucherCode: readCode };
  }
  return NO_ISSUED_VOUCHER_GUARD;
}

export interface CompareAndSetTransition {
  orderId: string;
  /** The status the caller READ and validated the edge against. The write only lands if the
   *  row is still in exactly this status (compare-and-set); it is also the history `fromStatus`. */
  expectedFrom: RedemptionStatus;
  toStatus: RedemptionStatus;
  /** Optional extra claim conditions ANDed with `{ id, status: expectedFrom }` (e.g. vendor scope). */
  extraGuard?: Prisma.RedemptionOrderWhereInput;
  data?: Omit<Prisma.RedemptionOrderUpdateManyMutationInput, 'status'>;
  changedById?: string | null;
  notes?: string | null;
}

/**
 * Read → validate → WRITE race guard for the manual (admin / vendor) transitions.
 *
 * The caller reads the order, validates `expectedFrom → toStatus` against its edge map, then calls
 * this INSIDE its `$transaction`. The status write is an atomic compare-and-set on the status that
 * was read (`updateMany where { id, status: expectedFrom }`): if a concurrent transition (or any
 * other writer) moved the order in between, the claim matches 0 rows and this throws a 409
 * `ConflictException` — rolling back the caller's tx, so NO history row and NO money side effect
 * runs for the loser. Call it BEFORE any side effect in the same tx: once it returns, the winner
 * holds the row lock for the rest of the tx. Returns the post-update row (read under that lock).
 */
export async function transitionOrderStatusOrConflict(
  tx: Tx,
  args: CompareAndSetTransition,
): Promise<RedemptionOrder> {
  const claim = await transitionOrderStatus(tx, {
    orderId: args.orderId,
    guard: { ...(args.extraGuard ?? {}), status: args.expectedFrom },
    fromStatus: args.expectedFrom,
    toStatus: args.toStatus,
    data: args.data,
    changedById: args.changedById,
    notes: args.notes,
  });
  if (claim.count === 0) throw new ConflictException(ORDER_STATUS_CONFLICT_MESSAGE);
  return tx.redemptionOrder.findUniqueOrThrow({ where: { id: args.orderId } });
}

/**
 * Single-active-OTP rule (redeem / redeemForOutlet): cancel the OUTLET's abandoned PENDING
 * orders (never debited → no refund). Same predicate as before (`partnerId` + `PENDING`),
 * applied as a per-order guarded claim so each cancelled order gets exactly one
 * `PENDING → CANCELLED` history row, and an order confirmed concurrently gets none.
 */
export async function supersedePendingOrders(
  tx: Tx,
  partnerId: string,
  changedById: string | null,
  now: Date,
): Promise<void> {
  const where = { partnerId, status: 'PENDING' as const };
  // Claim in id order so two concurrent redeems lock rows in the same order (no deadlock).
  const pending = await tx.redemptionOrder.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
  for (const { id } of pending) {
    await transitionOrderStatus(tx, {
      orderId: id,
      guard: where,
      fromStatus: RedemptionStatus.PENDING,
      toStatus: RedemptionStatus.CANCELLED,
      data: { cancelledAt: now },
      changedById,
      notes: 'Superseded — OTP not completed',
    });
  }
}
