// TDD: WalletController
import { Test, TestingModule } from '@nestjs/testing';
import { WalletController } from './wallet.controller';
import { WalletService }    from './wallet.service';
import { EarnPointsDto }    from './dto/wallet.dto';

const mockService = {
  getBalance:      jest.fn(),
  getTransactions: jest.fn(),
  earnPoints:      jest.fn(),
};

const user = { sub: 'user_1', role: 'CHANNEL_PARTNER', clientId: 'deoleo' };

describe('WalletController', () => {
  let controller: WalletController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [{ provide: WalletService, useValue: mockService }],
    }).compile();
    controller = module.get<WalletController>(WalletController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('GET /wallet — returns own balance', async () => {
    mockService.getBalance.mockResolvedValue({ redeemablePoints: 500 });
    const result = await controller.getBalance(user as any);
    expect(mockService.getBalance).toHaveBeenCalledWith('user_1');
    expect(result.redeemablePoints).toBe(500);
  });

  it('GET /wallet/transactions — returns transaction history', async () => {
    mockService.getTransactions.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.getTransactions(user as any, {});
    expect(mockService.getTransactions).toHaveBeenCalledWith('user_1', expect.any(Object));
    expect(result.total).toBe(0);
  });

  it('POST /wallet/earn — admin manually earns points for partner', async () => {
    mockService.earnPoints.mockResolvedValue({ redeemablePoints: 600 });

    const dto: EarnPointsDto = {
      partnerId: 'cp_1',
      points:    100,
      description: 'Manual adjustment',
    };
    const result = await controller.earn(dto);

    expect(mockService.earnPoints).toHaveBeenCalledWith(dto);
    expect(result.redeemablePoints).toBe(600);
  });
});
