// TDD: TargetsController
import { Test, TestingModule } from '@nestjs/testing';
import { TargetsController } from './targets.controller';
import { TargetsService }    from './targets.service';
import { UpsertTargetsDto }  from './dto/targets.dto';

const mockService = {
  upsertTargets: jest.fn(),
  listTargets:   jest.fn(),
};

const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };
const user  = { sub: 'user_1',  role: 'CHANNEL_PARTNER', clientId: 'deoleo' };

describe('TargetsController', () => {
  let controller: TargetsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TargetsController],
      providers: [{ provide: TargetsService, useValue: mockService }],
    }).compile();
    controller = module.get<TargetsController>(TargetsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /targets/upsert — admin upserts targets from Excel rows', async () => {
    mockService.upsertTargets.mockResolvedValue({ upserted: 2, errors: [] });

    const dto: UpsertTargetsDto = {
      schemeId: 'scheme_1',
      rows: [
        { partnerId: 'cp_1', periodStartDate: '2025-06-01', periodEndDate: '2025-06-30', targetValuePaise: 100000 },
        { partnerId: 'cp_2', periodStartDate: '2025-06-01', periodEndDate: '2025-06-30', targetValuePaise: 200000 },
      ],
    };
    const result = await controller.upsert(dto);

    expect(mockService.upsertTargets).toHaveBeenCalledWith('scheme_1', dto.rows);
    expect(result.upserted).toBe(2);
  });

  it('GET /targets — partner sees own targets', async () => {
    mockService.listTargets.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.list(user as any, {});
    expect(mockService.listTargets).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'user_1' }),
    );
    expect(result.total).toBe(0);
  });

  it('GET /targets — admin can filter by partnerId', async () => {
    mockService.listTargets.mockResolvedValue({ data: [], total: 0 });
    await controller.list(admin as any, { partnerId: 'cp_1' });
    expect(mockService.listTargets).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'cp_1' }),
    );
  });
});
