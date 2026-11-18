/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — owner decision on M1 (2026-11-18: release REJECTED only) + fixes from the full
 * re-review of HEAD (L3 null name, L4 committedRupees, L5 lock-transaction options + finish loop, L8 order).
 */
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ADMIN, confirmBody, file, finished, setup } from './dispersal-test-kit.test-spec';
import { CAMPAIGN_LOCK_TX } from './voucher-dispersal.processor';
import { EditDispersalCampaignDto } from './dto/voucher-dispersal.dto';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

/** Budget 10,000; 10 rows × ₹1,000; the last 4 turned into BUY_FAILED rows of `source` whose reference reached Hubble. */
async function sixBoughtFourFailed(source: 'REJECTED' | 'HUBBLE_FAILED') {
  const t = setup();
  const rows = Array.from({ length: 10 }, (_, i) => [`98765432${10 + i}`, `P${i}`, 1000, 'Amazon Pay']);
  const id = await finished(t, rows, 10000);
  for (const r of t.rows.slice(6)) {
    Object.assign(r, {
      status: 'BUY_FAILED', buyFailureSource: source, buyFailureReason: 'x', referenceSentAt: new Date(), voucherCode: null, boughtAt: null,
    });
  }
  t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
  return { t, id };
}

describe('M1 owner decision: REJECTED failures stop counting; HUBBLE_FAILED keeps counting', () => {
  it('6 bought + 4 REJECTED → floor ₹6,000; a batch of 4 × ₹1,000 is confirmable and actually bought (the claim guard agrees)', async () => {
    const { t, id } = await sixBoughtFourFailed('REJECTED');
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.budgetUsage).toEqual({ spentRupees: 6000, withHubbleRupees: 0, failedMayCompleteRupees: 0, queuedRupees: 0, floorRupees: 6000 });
    expect(d.summary.budgetFloorRupees).toBe(6000);
    const b = await t.svc.uploadBatch(ADMIN, id, file(Array.from({ length: 4 }, (_, i) => [`90000000${10 + i}`, `N${i}`, 1000, 'Amazon Pay'])));
    expect(b.summary).toMatchObject({ alreadyCommittedRupees: 6000, remainingBudgetRupees: 4000, overBudget: false });
    await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b));
    await t.processor.drain({ campaignId: id });
    expect(t.rows.filter((r) => r.batchNumber === 2).map((r) => r.status)).toEqual(['BOUGHT', 'BOUGHT', 'BOUGHT', 'BOUGHT']);
    // The budget can now be lowered to ₹10,000 at most (= spent), not below.
    await expect(t.svc.editCampaign(ADMIN, id, { budgetRupees: 9999 })).rejects.toThrow(/can't go below ₹10,000/);
  });

  it('6 bought + 4 HUBBLE_FAILED → those still count (floor ₹10,000); the same batch is refused — raise the budget', async () => {
    const { t, id } = await sixBoughtFourFailed('HUBBLE_FAILED');
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.budgetUsage).toEqual({ spentRupees: 6000, withHubbleRupees: 0, failedMayCompleteRupees: 4000, queuedRupees: 0, floorRupees: 10000 });
    const b = await t.svc.uploadBatch(ADMIN, id, file(Array.from({ length: 4 }, (_, i) => [`90000000${10 + i}`, `N${i}`, 1000, 'Amazon Pay'])));
    expect(b.summary).toMatchObject({ remainingBudgetRupees: 0, overBudget: true });
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toThrow(/Raise the budget/);
  });
});

describe('L3: a null name / budget is a 400, never a 500', () => {
  it('the DTO refuses null', async () => {
    const e1 = await validate(plainToInstance(EditDispersalCampaignDto, { name: null }));
    expect(e1.map((e) => e.property)).toContain('name');
    const e2 = await validate(plainToInstance(EditDispersalCampaignDto, { budgetRupees: null }));
    expect(e2.map((e) => e.property)).toContain('budgetRupees');
    expect(await validate(plainToInstance(EditDispersalCampaignDto, { name: 'ok' }))).toEqual([]);
  });

  it('the service refuses null too (defence in depth)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    await expect(t.svc.editCampaign(ADMIN, id, { name: null } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.svc.editCampaign(ADMIN, id, { budgetRupees: null } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('L4: the detail reply has no second "committed" figure that disagrees with the shared rule', () => {
  it('summary.committedRupees is gone; budgetUsage is the only breakdown', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).not.toHaveProperty('committedRupees');
    expect(d.summary.budgetUsage.floorRupees).toBe(1000);
  });
});

describe('L5: campaign-lock transactions share explicit timeout / maxWait; one failing settle never stops the rest', () => {
  it('edit / batch upload / confirm / discard / settle pass CAMPAIGN_LOCK_TX', async () => {
    expect(CAMPAIGN_LOCK_TX).toEqual({ timeout: 30_000, maxWait: 25_000 });
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const opts = () => t.prisma.$transaction.mock.calls.at(-1)[1];
    await t.svc.editCampaign(ADMIN, id, { budgetRupees: 20000 });
    expect(opts()).toEqual(CAMPAIGN_LOCK_TX);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    expect(opts()).toEqual(CAMPAIGN_LOCK_TX);
    await t.svc.discardBatch(ADMIN, id, 2);
    expect(opts()).toEqual(CAMPAIGN_LOCK_TX);
    const c = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    await t.svc.confirmBatch(ADMIN, id, c.batchNumber, confirmBody(c));
    expect(opts()).toEqual(CAMPAIGN_LOCK_TX);
    await t.processor.settleCampaign(id);
    expect(opts()).toEqual(CAMPAIGN_LOCK_TX);
    expect(b.batchNumber).toBe(2);
  });

  it('finishCampaigns logs a failing settle and moves on to the next campaign', async () => {
    const t = setup();
    const settle = jest.spyOn(t.processor, 'settleCampaign');
    settle.mockRejectedValueOnce(new Error('P2028 transaction timeout')).mockResolvedValueOnce(true);
    const n = await t.processor.finishCampaigns(undefined, ['campA', 'campB']);
    expect(settle.mock.calls.map((c) => c[0])).toEqual(['campA', 'campB']);
    expect(n).toBe(1);
  });
});

describe('L8: confirm reports a changed preview before the budget', () => {
  it('batch confirm with stale numbers AND over budget → "The preview changed"', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 1200);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    await expect(t.svc.confirmBatch(ADMIN, id, 2, { ...confirmBody(b), expectedValidCount: 5 })).rejects.toThrow(/The preview changed/);
  });

  it('first-file confirm with stale numbers AND over budget → "The preview changed"', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay'], ['9876543211', 'B', 800, 'Amazon Pay']]));
    await expect(t.svc.confirm(ADMIN, c.id, { ...confirmBody(p), expectedValidCount: 9 })).rejects.toThrow(/The preview changed/);
  });
});
