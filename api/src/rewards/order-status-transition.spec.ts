import { RedemptionStatus } from '@prisma/client';
import { supersedePendingOrders, transitionOrderStatus } from './order-status-transition';

function makeTx() {
  return {
    redemptionOrder: {
      update: jest.fn().mockResolvedValue({ id: 'o1', status: 'X' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    redemptionStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('transitionOrderStatus — the single status-write choke point', () => {
  describe('unguarded (update) form', () => {
    it('updates the order with status + extra columns and returns the updated row', async () => {
      const tx = makeTx();
      const at = new Date('2026-05-01T00:00:00Z');
      const res = await transitionOrderStatus(tx as never, {
        orderId: 'o1',
        fromStatus: RedemptionStatus.PROCESSING,
        toStatus: RedemptionStatus.DISPATCHED,
        data: { dispatchedAt: at, trackingNumber: 'TN1' },
        changedById: 'u1',
        notes: 'n',
      });
      expect(tx.redemptionOrder.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { status: RedemptionStatus.DISPATCHED, dispatchedAt: at, trackingNumber: 'TN1' },
      });
      expect(res).toEqual({ id: 'o1', status: 'X' });
    });

    it('writes exactly one history row with from/to/actor/notes in the same tx', async () => {
      const tx = makeTx();
      await transitionOrderStatus(tx as never, {
        orderId: 'o1',
        fromStatus: RedemptionStatus.PROCESSING,
        toStatus: RedemptionStatus.DISPATCHED,
        changedById: 'u1',
        notes: 'n',
      });
      expect(tx.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
      expect(tx.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'o1',
          fromStatus: RedemptionStatus.PROCESSING,
          toStatus: RedemptionStatus.DISPATCHED,
          changedById: 'u1',
          notes: 'n',
        },
      });
    });

    it('defaults actor + notes to null and allows an unknown (null) fromStatus', async () => {
      const tx = makeTx();
      await transitionOrderStatus(tx as never, {
        orderId: 'o1',
        fromStatus: null,
        toStatus: RedemptionStatus.FAILED,
      });
      expect(tx.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: { orderId: 'o1', fromStatus: null, toStatus: RedemptionStatus.FAILED, changedById: null, notes: null },
      });
    });

    it('records NO history for a same-status no-op (from === to), but still applies the update', async () => {
      const tx = makeTx();
      await transitionOrderStatus(tx as never, {
        orderId: 'o1',
        fromStatus: RedemptionStatus.FAILED,
        toStatus: RedemptionStatus.FAILED,
      });
      expect(tx.redemptionOrder.update).toHaveBeenCalledTimes(1);
      expect(tx.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });

    it('a failing update writes no history (the error propagates → tx rolls back)', async () => {
      const tx = makeTx();
      tx.redemptionOrder.update.mockRejectedValueOnce(new Error('P2025'));
      await expect(
        transitionOrderStatus(tx as never, {
          orderId: 'o1',
          fromStatus: RedemptionStatus.PENDING,
          toStatus: RedemptionStatus.CANCELLED,
        }),
      ).rejects.toThrow('P2025');
      expect(tx.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('guarded (atomic claim / updateMany) form', () => {
    it('claims via updateMany({ id, ...guard }) and returns the count', async () => {
      const tx = makeTx();
      const res = await transitionOrderStatus(tx as never, {
        orderId: 'o1',
        guard: { status: RedemptionStatus.PENDING },
        fromStatus: RedemptionStatus.PENDING,
        toStatus: RedemptionStatus.CONFIRMED,
        data: { pointsDeducted: 100 },
        changedById: 'u1',
      });
      expect(tx.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: RedemptionStatus.PENDING },
        data: { status: RedemptionStatus.CONFIRMED, pointsDeducted: 100 },
      });
      expect(tx.redemptionOrder.update).not.toHaveBeenCalled();
      expect(res).toEqual({ count: 1 });
      expect(tx.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'o1',
          fromStatus: RedemptionStatus.PENDING,
          toStatus: RedemptionStatus.CONFIRMED,
          changedById: 'u1',
          notes: null,
        },
      });
    });

    it('a lost claim (count 0) writes NO history row', async () => {
      const tx = makeTx();
      tx.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await transitionOrderStatus(tx as never, {
        orderId: 'o1',
        guard: { status: RedemptionStatus.PENDING },
        fromStatus: RedemptionStatus.PENDING,
        toStatus: RedemptionStatus.CONFIRMED,
      });
      expect(res).toEqual({ count: 0 });
      expect(tx.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });
  });
});

describe('supersedePendingOrders — auto-cancel of abandoned PENDING orders', () => {
  it('cancels each PENDING order of the outlet via a per-order PENDING claim and records PENDING→CANCELLED', async () => {
    const tx = makeTx();
    tx.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const at = new Date('2026-05-01T00:00:00Z');
    await supersedePendingOrders(tx as never, 'p1', 'u1', at);
    expect(tx.redemptionOrder.findMany).toHaveBeenCalledWith({
      where: { partnerId: 'p1', status: 'PENDING' },
      select: { id: true },
      orderBy: { id: 'asc' }, // consistent lock order across concurrent redeems
    });
    expect(tx.redemptionOrder.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'a', partnerId: 'p1', status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: at },
    });
    expect(tx.redemptionOrder.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'b', partnerId: 'p1', status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: at },
    });
    expect(tx.redemptionStatusHistory.create).toHaveBeenCalledTimes(2);
    expect(tx.redemptionStatusHistory.create).toHaveBeenCalledWith({
      data: {
        orderId: 'a',
        fromStatus: 'PENDING',
        toStatus: 'CANCELLED',
        changedById: 'u1',
        notes: 'Superseded — OTP not completed',
      },
    });
  });

  it('no PENDING orders → no update and no history', async () => {
    const tx = makeTx();
    await supersedePendingOrders(tx as never, 'p1', 'u1', new Date());
    expect(tx.redemptionOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.redemptionStatusHistory.create).not.toHaveBeenCalled();
  });

  it('an order confirmed concurrently (claim count 0) gets no CANCELLED history row', async () => {
    const tx = makeTx();
    tx.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'a' }]);
    tx.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    await supersedePendingOrders(tx as never, 'p1', 'u1', new Date());
    expect(tx.redemptionStatusHistory.create).not.toHaveBeenCalled();
  });
});
