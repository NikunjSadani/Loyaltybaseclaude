// TDD: PayoutsController
import { Test, TestingModule } from '@nestjs/testing';
import { PayoutsController } from './payouts.controller';
import { PayoutsService }    from './payouts.service';
import { WalletService }     from '../wallet/wallet.service';
import { RequestPayoutDto, CreateBatchDto, UploadResultsDto } from './dto/payouts.dto';

const mockService = {
  requestPayout:        jest.fn(),
  listPayouts:          jest.fn(),
  createBatch:          jest.fn(),
  uploadPayoutResults:  jest.fn(),
};

const user = { sub: 'user_1', role: 'CHANNEL_PARTNER', clientId: 'deoleo' };
const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };

describe('PayoutsController', () => {
  let controller: PayoutsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayoutsController],
      providers: [
        { provide: PayoutsService, useValue: mockService },
        { provide: WalletService,  useValue: {} },
      ],
    }).compile();
    controller = module.get<PayoutsController>(PayoutsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /payouts — partner requests payout', async () => {
    mockService.requestPayout.mockResolvedValue({ id: 'payout_1', status: 'PENDING' });

    const dto: RequestPayoutDto = {
      amountPaise:       50000,
      bankAccountNumber: '1234567890',
      ifscCode:          'HDFC0001234',
      beneficiaryName:   'Owner A',
    };
    const result = await controller.request(dto, user as any);

    expect(mockService.requestPayout).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 50000, clientId: 'deoleo', partnerId: 'user_1' }),
    );
    expect(result.status).toBe('PENDING');
  });

  it('GET /payouts — lists own payouts', async () => {
    mockService.listPayouts.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.list(user as any, {});
    expect(mockService.listPayouts).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'user_1' }),
    );
    expect(result.total).toBe(0);
  });

  it('POST /payouts/batches — admin creates batch', async () => {
    mockService.createBatch.mockResolvedValue({ id: 'batch_1', status: 'DRAFT' });

    const dto: CreateBatchDto = { notes: 'June batch' };
    const result = await controller.createBatch(dto, admin as any);

    expect(mockService.createBatch).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'June batch', clientId: 'deoleo' }),
    );
    expect(result.status).toBe('DRAFT');
  });

  it('POST /payouts/batches/:id/results — admin uploads UTR results', async () => {
    mockService.uploadPayoutResults.mockResolvedValue({ successCount: 2, failureCount: 0, errors: [] });

    const dto: UploadResultsDto = {
      rows: [
        { payoutTransactionId: 'txn_1', status: 'SUCCESS', utrNumber: 'UTR123' },
        { payoutTransactionId: 'txn_2', status: 'FAILED',  failureReason: 'Insufficient funds' },
      ],
    };
    const result = await controller.uploadResults('batch_1', dto, admin as any);

    expect(mockService.uploadPayoutResults).toHaveBeenCalledWith('batch_1', dto.rows, 'admin_1');
    expect(result.successCount).toBe(2);
  });
});
