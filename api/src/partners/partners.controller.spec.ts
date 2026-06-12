// TDD: PartnersController
import { Test, TestingModule } from '@nestjs/testing';
import { PartnersController } from './partners.controller';
import { PartnersService }    from './partners.service';
import { CreatePartnerDto }   from './dto/partners.dto';

const mockService = {
  createPartner:  jest.fn(),
  findById:       jest.fn(),
  findByUserId:   jest.fn(),
  listPartners:   jest.fn(),
};

const user = { sub: 'user_1', role: 'CHANNEL_PARTNER', clientId: 'deoleo' };

describe('PartnersController', () => {
  let controller: PartnersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PartnersController],
      providers:   [{ provide: PartnersService, useValue: mockService }],
    }).compile();
    controller = module.get<PartnersController>(PartnersController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /partners — creates a partner', async () => {
    mockService.createPartner.mockResolvedValue({ id: 'cp_1', partnerCode: 'RT-ABCD' });

    const dto: CreatePartnerDto = {
      partnerClassCode: 'CP_01',
      businessName: 'Shop A',
      ownerName: 'Owner A',
      phone: '9876543210',
    };
    const result = await controller.create(dto, user as any);

    expect(mockService.createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'Shop A', clientId: 'deoleo' }),
    );
    expect(result.partnerCode).toBe('RT-ABCD');
  });

  it('GET /partners/me — should return partner for current user', async () => {
    mockService.findByUserId.mockResolvedValue({ id: 'cp_1' });
    const result = await controller.getMyProfile(user as any);
    expect(mockService.findByUserId).toHaveBeenCalledWith('user_1', 'deoleo');
    expect(result).toEqual({ id: 'cp_1' });
  });

  it('GET /partners/:id — should return partner by id', async () => {
    mockService.findById.mockResolvedValue({ id: 'cp_1' });
    const result = await controller.findOne('cp_1', user as any);
    expect(result).toEqual({ id: 'cp_1' });
  });

  it('GET /partners — should return list (admin only)', async () => {
    mockService.listPartners.mockResolvedValue({ data: [], total: 0, page: 1 });
    const result = await controller.list(user as any, {});
    expect(result.total).toBe(0);
  });
});
