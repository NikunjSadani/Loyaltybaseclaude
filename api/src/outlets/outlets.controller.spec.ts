// TDD: OutletsController
import { Test, TestingModule } from '@nestjs/testing';
import { OutletsController } from './outlets.controller';
import { OutletsService }    from './outlets.service';
import { CreateOutletDto }   from './dto/outlets.dto';

const mockService = {
  createOutlet: jest.fn(),
  listOutlets:  jest.fn(),
  findById:     jest.fn(),
  deleteOutlet: jest.fn(),
};

const user = { sub: 'user_1', role: 'SALES_ISR', clientId: 'deoleo' };

describe('OutletsController', () => {
  let controller: OutletsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OutletsController],
      providers: [{ provide: OutletsService, useValue: mockService }],
    }).compile();
    controller = module.get<OutletsController>(OutletsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /outlets — creates an outlet', async () => {
    mockService.createOutlet.mockResolvedValue({ id: 'outlet_1', outletCode: 'RT-XYZ1' });

    const dto: CreateOutletDto = {
      partnerId:    'cp_1',
      outletTypeId: 'ot_1',
      name:         'Main Shop',
      addressLine1: '12, MG Road',
      city:         'Mumbai',
      state:        'Maharashtra',
      pincode:      '400001',
    };
    const result = await controller.create(dto, user as any);

    expect(mockService.createOutlet).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'cp_1', name: 'Main Shop' }),
    );
    expect(result.outletCode).toBe('RT-XYZ1');
  });

  it('GET /outlets — lists outlets with filters', async () => {
    mockService.listOutlets.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.list(user as any, { partnerId: 'cp_1' });
    expect(mockService.listOutlets).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'cp_1' }),
    );
    expect(result.total).toBe(0);
  });

  it('GET /outlets/:id — returns outlet by id', async () => {
    mockService.findById.mockResolvedValue({ id: 'outlet_1' });
    const result = await controller.findOne('outlet_1');
    expect(mockService.findById).toHaveBeenCalledWith('outlet_1');
    expect(result).toEqual({ id: 'outlet_1' });
  });

  it('DELETE /outlets/:id — soft-deletes outlet', async () => {
    mockService.deleteOutlet.mockResolvedValue(undefined);
    await controller.remove('outlet_1', 'cp_1');
    expect(mockService.deleteOutlet).toHaveBeenCalledWith('outlet_1', 'cp_1');
  });
});
