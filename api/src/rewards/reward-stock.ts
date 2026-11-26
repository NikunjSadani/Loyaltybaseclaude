import { BadRequestException } from '@nestjs/common';
import { Prisma, RedemptionStatus } from '@prisma/client';

/**
 * REWARD STOCK HISTORY (owner-approved 2026-11-26, platform-wide, all clients).
 *
 * The ONLY places that change RewardCatalog.stockQuantity, each writing its RewardStockMovement row in the SAME
 * transaction client as the stock write (no stock change without its history row, no history row without the change):
 *
 *   takeStockForOrder        — confirm (confirmRedeem / confirmRedeemForOutlet): guarded decrement + REDEEMED row
 *   returnStockForOrder      — every move to CANCELLED / FAILED / RETURNED (called by transitionOrderStatus, the single
 *                              order-status write path, so EVERY refund path — admin / vendor / bulk sheet / Hubble /
 *                              payout UTR=FAILED — is covered): +quantity + RETURNED row, ONCE per order
 *   recordStockEdit          — admin / vendor / publish create + edit: OPENING (first figure) or ADJUSTED (old → new)
 *   returnReviewedOrderStock — an admin's "Return to stock" on an order confirmed before stock history existed
 *
 * Pre-release orders (confirmed before the reward's first ledger row) carry no REDEEMED row, so we cannot PROVE stock
 * was taken: they are NEVER auto-returned. Instead a RewardStockReview row lists them for an admin to decide.
 *
 * Supersedes the 2026-08-19 rule "stock is never restored on cancel / return / failed".
 */
type Tx = Prisma.TransactionClient;

export const STOCK_BASELINE_REASON = 'Baseline at go-live of stock history';
/** OPENING written for a reward that ALREADY tracked stock but had no ledger row yet (its earlier take is unknown). */
export const STOCK_GAP_OPENING_REASON = 'Opening stock (first change recorded by stock history)';
export const STOCK_BACK_IN_STOCK_NOTE = 'Back in stock: status changed from Out of stock to Active';
export const STOCK_OUT_OF_STOCK_NOTE = 'Stock reached 0: status set to Out of stock';

const REFUND_STATUSES: ReadonlySet<RedemptionStatus> = new Set([
  RedemptionStatus.CANCELLED,
  RedemptionStatus.FAILED,
  RedemptionStatus.RETURNED,
]);

const STATUS_WORD: Record<string, string> = {
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  RETURNED: 'returned',
};

const clip = (s: string) => s.slice(0, 500);

/**
 * Guarantee the reward has a starting point in the ledger before a movement is appended. A reward that already
 * tracked stock but has no row (e.g. created by the previous API build in the minutes between the migration and
 * the new code going live) gets an OPENING row at `balanceBefore`, so the history always adds up.
 */
async function ensureOpening(
  tx: Tx,
  reward: { id: string; clientId: string },
  balanceBefore: number | null,
  actorId: string | null,
): Promise<boolean> {
  const existing = await tx.rewardStockMovement.findFirst({
    where: { rewardId: reward.id },
    select: { id: true },
  });
  if (existing) return true;
  if (balanceBefore == null) return false;
  await tx.rewardStockMovement.create({
    data: {
      clientId: reward.clientId,
      rewardId: reward.id,
      type: 'OPENING',
      quantity: balanceBefore,
      balanceAfter: balanceBefore,
      reason: STOCK_GAP_OPENING_REASON,
      actorId,
    },
  });
  return true;
}

/**
 * Confirm-time stock take. Guarded decrement (WHERE stock >= quantity → the last unit can't be oversold), the
 * OUT_OF_STOCK flip at 0 (unchanged rule), and the REDEEMED row — all in the caller's confirm transaction, so a
 * later failure rolls all of it back. Throws 400 "Reward is out of stock" (same as before) when the claim loses.
 */
export async function takeStockForOrder(
  tx: Tx,
  args: { rewardId: string; orderId: string; orderNumber: string; quantity: number; actorId: string | null },
): Promise<void> {
  const stockClaim = await tx.rewardCatalog.updateMany({
    where: { id: args.rewardId, stockQuantity: { gte: args.quantity } },
    data: { stockQuantity: { decrement: args.quantity } },
  });
  if (stockClaim.count === 0) {
    throw new BadRequestException('Reward is out of stock');
  }
  // Read under the row lock our decrement holds → the exact post-decrement figure.
  const fresh = await tx.rewardCatalog.findFirst({
    where: { id: args.rewardId },
    select: { stockQuantity: true, clientId: true },
  });
  let reason = `Redeemed on order ${args.orderNumber}`;
  if (fresh?.stockQuantity != null && fresh.stockQuantity <= 0) {
    // Only an ACTIVE item flips: an admin pause (INACTIVE / DISCONTINUED) set concurrently is never overwritten
    // with OUT_OF_STOCK — which a later return would otherwise turn back into ACTIVE.
    const flip = await tx.rewardCatalog.updateMany({
      where: { id: args.rewardId, status: 'ACTIVE' },
      data: { status: 'OUT_OF_STOCK' },
    });
    if (flip.count > 0) reason = `${reason}. ${STOCK_OUT_OF_STOCK_NOTE}`;
  }
  if (!fresh?.clientId) return; // row vanished under the lock — impossible; nothing to attribute the row to
  const balanceAfter = fresh.stockQuantity ?? null;
  await ensureOpening(
    tx,
    { id: args.rewardId, clientId: fresh.clientId },
    balanceAfter != null ? balanceAfter + args.quantity : null,
    args.actorId,
  );
  await tx.rewardStockMovement.create({
    data: {
      clientId: fresh.clientId,
      rewardId: args.rewardId,
      type: 'REDEEMED',
      quantity: -args.quantity,
      balanceAfter,
      orderId: args.orderId,
      reason: clip(reason),
      actorId: args.actorId,
    },
  });
}

/** Add `quantity` back to a tracked reward + flip a sold-out item back to ACTIVE. Null = the reward no longer tracks stock. */
async function addBack(
  tx: Tx,
  rewardId: string,
  quantity: number,
): Promise<{ balanceAfter: number; clientId: string; backInStock: boolean } | null> {
  const before = await tx.rewardCatalog.findFirst({
    where: { id: rewardId },
    select: { stockQuantity: true, status: true, clientId: true },
  });
  if (!before || before.stockQuantity == null) return null;
  const inc = await tx.rewardCatalog.updateMany({
    where: { id: rewardId, stockQuantity: { not: null } },
    data: { stockQuantity: { increment: quantity } },
  });
  if (inc.count === 0) return null;
  // Read under the row lock our increment holds (a concurrent return / confirm waits on it).
  const after = await tx.rewardCatalog.findFirst({
    where: { id: rewardId },
    select: { stockQuantity: true, status: true },
  });
  const balanceAfter = after?.stockQuantity ?? before.stockQuantity + quantity;
  // Only an item that SOLD OUT (status OUT_OF_STOCK, stock was 0) comes back automatically. A manual pause
  // (OUT_OF_STOCK with stock left), INACTIVE or DISCONTINUED is never resurrected.
  const backInStock =
    after?.status === 'OUT_OF_STOCK' && balanceAfter > 0 && balanceAfter - quantity <= 0;
  if (backInStock) {
    await tx.rewardCatalog.updateMany({
      where: { id: rewardId, status: 'OUT_OF_STOCK' },
      data: { status: 'ACTIVE' },
    });
  }
  return { balanceAfter, clientId: before.clientId, backInStock };
}

/**
 * For an order with NO REDEEMED row: true only when the ledger proves the reward was UNTRACKED (unlimited) when the
 * order was confirmed — the new code writes REDEEMED for every take, so a tracked reward without one means the
 * take (if any) happened outside the ledger (before go-live, or by the old build during the deploy).
 *   - latest ledger row at/before the confirm moment has balanceAfter null (tracking was off) → not taken
 *   - no ledger row yet at that moment, and the reward's FIRST row is a creation / "tracking turned on" OPENING
 *     (not the go-live baseline, not a gap-fill opening) → the reward was untracked before it → not taken
 *   - otherwise → uncertain
 * Confirm moment = the order's first CONFIRMED status-history row; legacy orders without one fall back to the
 * order's creation time (earlier than any confirm, so the check stays on the cautious side).
 */
async function provablyNotTaken(tx: Tx, rewardId: string, orderId: string, orderCreatedAt: Date): Promise<boolean> {
  const confirmedRow = await tx.redemptionStatusHistory.findFirst({
    where: { orderId, toStatus: RedemptionStatus.CONFIRMED },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!confirmedRow) {
    // No CONFIRMED history row. Every confirm since the status timeline shipped (old build included) writes one,
    // so an order placed AFTER the reward's ledger began was simply never confirmed (e.g. a PENDING order
    // failed via a fromStatus-null path) → stock never taken. An order placed before it is legacy → uncertain.
    const firstRow = await tx.rewardStockMovement.findFirst({
      where: { rewardId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { createdAt: true },
    });
    if (firstRow && orderCreatedAt >= firstRow.createdAt) return true;
  }
  const confirmedAt = confirmedRow?.createdAt ?? orderCreatedAt;
  const latestBefore = await tx.rewardStockMovement.findFirst({
    where: { rewardId, createdAt: { lte: confirmedAt } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });
  if (latestBefore) return latestBefore.balanceAfter == null;
  const first = await tx.rewardStockMovement.findFirst({
    where: { rewardId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { type: true, reason: true },
  });
  if (!first) return false; // tracked reward with no ledger at all → its takes are unknown
  const unknownBefore = first.reason === STOCK_BASELINE_REASON || first.reason === STOCK_GAP_OPENING_REASON;
  return first.type === 'OPENING' && !unknownBefore;
}

/**
 * Called by transitionOrderStatus after a move to CANCELLED / FAILED / RETURNED actually landed (same tx; the
 * order row is locked by that write, so two concurrent refunds of ONE order serialize here and the second sees
 * the first's RETURNED row). Idempotent: never returns stock twice for the same order.
 *   - a REDEEMED row exists, no RETURNED row → add the taken quantity back + RETURNED row.
 *   - no REDEEMED row → nothing to do when the ledger proves the reward was untracked at confirm time
 *     (provablyNotTaken); otherwise (confirmed before stock history, or by the old build during the deploy)
 *     → RewardStockReview row, no auto-return.
 */
export async function returnStockForOrder(
  tx: Tx,
  args: { orderId: string; fromStatus: RedemptionStatus | null; toStatus: RedemptionStatus; actorId: string | null },
): Promise<void> {
  if (!REFUND_STATUSES.has(args.toStatus)) return;
  // A PENDING order was never confirmed → stock was never taken (also keeps the hot supersede path query-free).
  if (args.fromStatus === RedemptionStatus.PENDING) return;

  const moves = await tx.rewardStockMovement.findMany({
    where: { orderId: args.orderId, type: { in: ['REDEEMED', 'RETURNED'] } },
    select: { type: true, quantity: true, rewardId: true },
  });
  if (moves.some((m) => m.type === 'RETURNED')) return; // already returned once — never twice
  const taken = moves.find((m) => m.type === 'REDEEMED');
  const word = STATUS_WORD[args.toStatus] ?? args.toStatus.toLowerCase();

  const order = await tx.redemptionOrder.findFirst({
    where: { id: args.orderId },
    select: {
      orderNumber: true, rewardId: true, quantity: true, createdAt: true,
      reward: { select: { stockQuantity: true, clientId: true } },
    },
  });
  if (!order) return;

  if (taken) {
    const qty = Math.abs(taken.quantity);
    const res = await addBack(tx, taken.rewardId, qty);
    if (!res) return; // the reward was switched to unlimited since — there is no stock figure to return into
    await tx.rewardStockMovement.create({
      data: {
        clientId: res.clientId,
        rewardId: taken.rewardId,
        type: 'RETURNED',
        quantity: qty,
        balanceAfter: res.balanceAfter,
        orderId: args.orderId,
        reason: clip(`Order ${order.orderNumber} ${word}${res.backInStock ? `. ${STOCK_BACK_IN_STOCK_NOTE}` : ''}`),
        actorId: args.actorId,
      },
    });
    return;
  }

  // No REDEEMED row. Stock was PROVABLY not taken only when, per the ledger, the reward did not track stock at
  // the moment the order was confirmed. Anything else (confirmed before stock history, or by the previous API
  // build in the deploy window after the baseline) is uncertain → review, never a silent skip.
  const reward = order.reward;
  if (!reward || reward.stockQuantity == null) return; // reward does not track stock now → nothing to return into
  if (await provablyNotTaken(tx, order.rewardId, args.orderId, order.createdAt)) return;

  // We cannot tell whether stock was taken. Do NOT auto-return: list it for an admin (shown loudly on the
  // catalogue screen and in the reward's Stock history).
  await tx.rewardStockReview.createMany({
    data: [
      {
        clientId: reward.clientId,
        rewardId: order.rewardId,
        orderId: args.orderId,
        orderNumber: order.orderNumber,
        quantity: order.quantity,
        orderStatus: args.toStatus,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Admin "Return to stock" on a reviewed pre-release order. Caller holds the review claim (OPEN → RETURNED) in
 * the same tx. Throws when the reward no longer tracks stock or the order already got its stock back.
 */
export async function returnReviewedOrderStock(
  tx: Tx,
  args: { rewardId: string; orderId: string; orderNumber: string; quantity: number; actorId: string; note: string | null },
): Promise<{ balanceAfter: number; backInStock: boolean }> {
  const already = await tx.rewardStockMovement.findFirst({
    where: { orderId: args.orderId, type: 'RETURNED' },
    select: { id: true },
  });
  if (already) throw new BadRequestException('Stock for this order was already returned.');
  const res = await addBack(tx, args.rewardId, args.quantity);
  if (!res) {
    throw new BadRequestException(
      'This reward no longer tracks stock (unlimited), so there is nothing to return to. Choose "Keep as is".',
    );
  }
  await ensureOpening(tx, { id: args.rewardId, clientId: res.clientId }, res.balanceAfter - args.quantity, args.actorId);
  const base = `Order ${args.orderNumber}: returned after review (order was confirmed before stock history started)`;
  await tx.rewardStockMovement.create({
    data: {
      clientId: res.clientId,
      rewardId: args.rewardId,
      type: 'RETURNED',
      quantity: args.quantity,
      balanceAfter: res.balanceAfter,
      orderId: args.orderId,
      reason: clip(
        [base, args.note?.trim() ? `Note: ${args.note.trim()}` : '', res.backInStock ? STOCK_BACK_IN_STOCK_NOTE : '']
          .filter(Boolean)
          .join('. '),
      ),
      actorId: args.actorId,
    },
  });
  return res;
}

/**
 * A create or edit that sets stockQuantity (admin catalogue, vendor portal, platform publish). `oldQty` is the
 * value read UNDER THE ROW LOCK in the same tx (null for a create / an untracked reward). No-op when unchanged.
 *   first figure ever (no ledger rows)          → OPENING (a tracked reward with no row also gets its old figure first)
 *   unlimited → N                               → ADJUSTED (+N, "tracking turned on")
 *   N → unlimited                               → ADJUSTED (−N, balanceAfter null, "tracking turned off")
 *   N → M                                       → ADJUSTED (M − N)
 */
export async function recordStockEdit(
  tx: Tx,
  args: {
    rewardId: string;
    clientId: string;
    oldQty: number | null;
    newQty: number | null;
    actorId: string | null;
    source: string; // e.g. 'catalogue edit', 'vendor portal', 'platform publish'
    reason?: string | null;
  },
): Promise<void> {
  const { oldQty, newQty } = args;
  if (oldQty === newQty) return;
  const note = args.reason?.trim() ? ` Reason: ${args.reason.trim()}` : '';
  const hasHistory = await ensureOpening(tx, { id: args.rewardId, clientId: args.clientId }, oldQty, args.actorId);

  if (!hasHistory) {
    // Nothing recorded before and the reward was untracked → this is its first figure.
    if (newQty == null) return;
    await tx.rewardStockMovement.create({
      data: {
        clientId: args.clientId,
        rewardId: args.rewardId,
        type: 'OPENING',
        quantity: newQty,
        balanceAfter: newQty,
        reason: clip(`Opening stock set (${args.source})${note ? `.${note}` : ''}`),
        actorId: args.actorId,
      },
    });
    return;
  }

  let quantity: number;
  let reason: string;
  if (oldQty == null) {
    quantity = newQty as number;
    reason = `Stock tracking turned on (was unlimited): set to ${newQty} (${args.source})`;
  } else if (newQty == null) {
    // −old so the history keeps adding up (opening − redeemed + returned + adjusted = current) across off / on.
    quantity = -oldQty;
    reason = `Stock tracking turned off (now unlimited); was ${oldQty} (${args.source})`;
  } else {
    quantity = newQty - oldQty;
    reason = `Stock changed ${oldQty} → ${newQty} (${args.source})`;
  }
  await tx.rewardStockMovement.create({
    data: {
      clientId: args.clientId,
      rewardId: args.rewardId,
      type: 'ADJUSTED',
      quantity,
      balanceAfter: newQty,
      reason: clip(`${reason}${note ? `.${note}` : ''}`),
      actorId: args.actorId,
    },
  });
}

/** Lock a reward row for an edit and return its stock under that lock (Postgres row lock until the tx ends). */
export async function lockRewardStock(tx: Tx, rewardId: string): Promise<number | null> {
  const rows = await tx.$queryRaw<{ stockQuantity: number | null }[]>`
    SELECT "stockQuantity" FROM "reward_catalog" WHERE "id" = ${rewardId} FOR UPDATE`;
  return rows[0]?.stockQuantity ?? null;
}
