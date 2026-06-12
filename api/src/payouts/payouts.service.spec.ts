// TDD: PayoutsService
// Covers: TDS calculation, min payout guard, bank transfer creation, batch management

import { Test, TestingModule } from '@nestjs/testing';
import { PayoutsService } from './payouts.service';
import { PrismaService }  from '../prisma/prisma.service';
import { WalletService }  from '../wallet/wallet.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const mockPrisma = {
  payoutTransaction: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn() },
  payoutBatch:       { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  channelPartner:    { findFirst: jest.fn() },
  wallet:            { findFirst: jest.fn() },
};

const mockWallet = {
  burnPoints: jest.fn(),
  earnPoints: jest.fn(),
  getBalance: jest.fn(),
  getTransactions: jest.fn(),
};

const partner = { id: 'cp_1', clientId: 'deoleo', panNumber: 'ABCDE1234F', ownerName: 'Test Owner' };
const wallet  = { id: 'wallet_1', partnerId: 'cp_1', redeemablePoints: 5000 };

describe('PayoutsService', () => {
  let service: PayoutsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
      ],
    }).compile();
    service = module.get<PayoutsService>(PayoutsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // â”€â”€ TDS calculation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('calculateTds', () => {
    it('should return 0 TDS for amounts below single-transaction threshold (â‚¹30,000)', () => {
      // â‚¹29,999 = 2,999,900 paise â€” below threshold
      const result = service.calculateTds(2_999_900, 0);
      expect(result.tdsApplicable).toBe(false);
      expect(result.tdsPaise).toBe(0);
    });

    it('should apply 2% TDS for a single transaction >= â‚¹30,000', () => {
      // â‚¹30,000 = 3,000,000 paise
      const result = service.calculateTds(3_000_000, 0);
      expect(result.tdsApplicable).toBe(true);
      expect(result.tdsPaise).toBe(60_000);  // 2% of â‚¹30,000 = â‚¹600 = 60,000 paise
    });

    it('should apply 2% TDS when annual total crosses â‚¹1,00,000 threshold', () => {
      // Single txn = â‚¹20,000 (below single threshold) but annual already = â‚¹85,000
      // After this txn: annual = â‚¹1,05,000 â†’ TDS applies to the full â‚¹20,000
      const result = service.calculateTds(2_000_000, 8_500_000);
      expect(result.tdsApplicable).toBe(true);
      expect(result.tdsPaise).toBe(40_000);  // 2% of â‚¹20,000
    });

    it('should NOT apply TDS if annual total stays below â‚¹1,00,000', () => {
      // Single txn = â‚¹20,000, annual so far = â‚¹60,000 â†’ after = â‚¹80,000 â†’ below
      const result = service.calculateTds(2_000_000, 6_000_000);
      expect(result.tdsApplicable).toBe(false);
      expect(result.tdsPaise).toBe(0);
    });
  });

  // â”€â”€ Minimum payout guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('requestPayout', () => {
    it('should throw BadRequestException if amount is below minimum (â‚¹100)', async () => {
      // â‚¹99 = 9,900 paise
      await expect(
        service.requestPayout({ partnerId: 'cp_1', clientId: 'deoleo', amountPaise: 9_900, bankAccountNumber: 'ACC1', ifscCode: 'IFSC0001', beneficiaryName: 'Test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create a PENDING payout transaction for valid bank transfer', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 5000 });
      mockPrisma.payoutTransaction.aggregate.mockResolvedValue({ _sum: { amountPaise: 0 } });
      mockPrisma.payoutTransaction.create.mockResolvedValue({
        id: 'payout_1', status: 'PENDING', amountPaise: 100_000,
        tdsApplicable: false, tdsPaise: 0, netAmountPaise: 100_000,
      });
      mockWallet.burnPoints.mockResolvedValue({});

      const result = await service.requestPayout({
        partnerId:         'cp_1',
        clientId:          'deoleo',
        amountPaise:       100_000,   // ₹1,000
        bankAccountNumber: 'ACC123456',
        ifscCode:          'SBIN0001234',
        beneficiaryName:   'Test Owner',
      });

      expect(result.status).toBe('PENDING');
      expect(result.netAmountPaise).toBe(100_000);
    });

    it('should burn wallet points equal to the requested amount (in points) on payout request', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 5000 });
      mockPrisma.payoutTransaction.aggregate.mockResolvedValue({ _sum: { amountPaise: 0 } });
      mockPrisma.payoutTransaction.create.mockResolvedValue({
        id: 'payout_burn', status: 'PENDING', amountPaise: 100_000,
        tdsApplicable: false, tdsPaise: 0, netAmountPaise: 100_000,
      });
      mockWallet.burnPoints.mockResolvedValue({});

      await service.requestPayout({
        partnerId: 'cp_1', clientId: 'deoleo',
        amountPaise: 100_000,  // ₹1,000 = 1,000 points
        bankAccountNumber: 'ACC123456', ifscCode: 'SBIN0001234',
        beneficiaryName: 'Test Owner',
      });

      // 100,000 paise ÷ 100 = 1,000 points burned
      expect(mockWallet.burnPoints).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId:     'cp_1',
          points:        1000,
          referenceType: 'PAYOUT',
          referenceId:   'payout_burn',
        }),
      );
    });

    it('should apply TDS when cumulative annual payouts cross ₹1,00,000 threshold', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 50000 });
      mockPrisma.payoutTransaction.aggregate.mockResolvedValue({ _sum: { amountPaise: 8_500_000 } });
      mockPrisma.payoutTransaction.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'payout_3', status: 'PENDING', ...data }),
      );
      mockWallet.burnPoints.mockResolvedValue({});

      const result = await service.requestPayout({
        partnerId: 'cp_1', clientId: 'deoleo',
        amountPaise: 2_000_000,
        bankAccountNumber: 'ACC123456', ifscCode: 'SBIN0001234',
        beneficiaryName: 'Test Owner',
      });

      expect(result.tdsApplicable).toBe(true);
      expect(result.tdsPaise).toBe(40_000);
      expect(result.netAmountPaise).toBe(1_960_000);
    });

    it('should deduct TDS from netAmountPaise for large payouts', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 50000 });
      mockPrisma.payoutTransaction.aggregate.mockResolvedValue({ _sum: { amountPaise: 0 } });
      mockPrisma.payoutTransaction.create.mockResolvedValue({
        id: 'payout_2', status: 'PENDING',
        amountPaise: 3_000_000, tdsApplicable: true,
        tdsPaise: 60_000, netAmountPaise: 2_940_000,
      });
      mockWallet.burnPoints.mockResolvedValue({});

      const result = await service.requestPayout({
        partnerId:         'cp_1',
        clientId:          'deoleo',
        amountPaise:       3_000_000,
        bankAccountNumber: 'ACC123456',
        ifscCode:          'SBIN0001234',
        beneficiaryName:   'Test Owner',
      });

      expect(result.tdsApplicable).toBe(true);
      expect(result.tdsPaise).toBe(60_000);
      expect(result.netAmountPaise).toBe(2_940_000);
    });
  });

  // â”€â”€ List payouts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('listPayouts', () => {
    it('should return paginated payout list for a partner', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([{ id: 'payout_1' }]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(1);

      const result = await service.listPayouts({ partnerId: 'cp_1' });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // â”€â”€ Batch creation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('createBatch', () => {
    it('should create a batch and link pending transactions', async () => {
      const pending = [
        { id: 'p_1', amountPaise: 100_000, netAmountPaise: 100_000, partnerId: 'cp_1' },
        { id: 'p_2', amountPaise: 200_000, netAmountPaise: 196_000, partnerId: 'cp_2' },
      ];
      mockPrisma.payoutTransaction.findMany.mockResolvedValue(pending);
      mockPrisma.payoutBatch.create.mockResolvedValue({
        id: 'batch_1', status: 'DRAFT', transactionCount: 2, totalAmountPaise: 296_000,
      });
      mockPrisma.payoutTransaction.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.createBatch({ clientId: 'deoleo', createdByUserId: 'admin_1' });
      expect(result.transactionCount).toBe(2);
      expect(mockPrisma.payoutTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ batchId: 'batch_1' }) }),
      );
    });

    it('should throw BadRequestException if no pending transactions exist', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      await expect(
        service.createBatch({ clientId: 'deoleo', createdByUserId: 'admin_1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // â”€â”€ Upload payout results (UTR / failure) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('uploadPayoutResults', () => {
    it('should mark transactions SUCCESS with UTR and payment date', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'batch_1', status: 'PROCESSING' });
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue({ id: 'p_1', batchId: 'batch_1' });
      mockPrisma.payoutTransaction.update.mockResolvedValue({ id: 'p_1', status: 'SUCCESS' as const });
      mockPrisma.payoutBatch.update.mockResolvedValue({});

      const rows = [
        { transactionId: 'p_1', status: 'SUCCESS' as const, utrNumber: 'UTR123456', paymentDate: '2026-07-05' },
      ];

      const result = await service.uploadPayoutResults('batch_1', rows, 'admin_1');
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);
    });

    it('should mark transactions FAILED with failure reason', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'batch_1', status: 'PROCESSING' });
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue({ id: 'p_2', batchId: 'batch_1' });
      mockPrisma.payoutTransaction.update.mockResolvedValue({ id: 'p_2', status: 'FAILED' as const });
      mockPrisma.payoutBatch.update.mockResolvedValue({});

      const rows = [
        { transactionId: 'p_2', status: 'FAILED' as const, failureReason: 'Invalid account number', paymentDate: '2026-07-05' },
      ];

      const result = await service.uploadPayoutResults('batch_1', rows, 'admin_1');
      expect(result.failureCount).toBe(1);
    });
  });

  // ── TDS business rule constants ───────────────────────────────────────────────

  describe('TDS constants (194C)', () => {
    it('single-transaction threshold is ₹30,000 (3,000,000 paise)', () => {
      // Access via calculateTds: just below threshold → no TDS
      expect(service.calculateTds(2_999_999, 0).tdsApplicable).toBe(false);
      // At threshold → TDS applies
      expect(service.calculateTds(3_000_000, 0).tdsApplicable).toBe(true);
    });

    it('annual threshold is ₹1,00,000 (10,000,000 paise)', () => {
      // Just below annual → no TDS for small txn
      expect(service.calculateTds(1_000_000, 8_999_999).tdsApplicable).toBe(false);
      // Crosses annual → TDS applies
      expect(service.calculateTds(1_000_000, 9_000_001).tdsApplicable).toBe(true);
    });

    it('TDS rate is 2% (194C for partnerships/companies)', () => {
      const { tdsPaise } = service.calculateTds(3_000_000, 0);
      expect(tdsPaise).toBe(60_000); // 2% of ₹30,000
    });
  });
});
