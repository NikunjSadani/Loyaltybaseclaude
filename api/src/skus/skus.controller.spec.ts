// TDD: SkusController
import { Test, TestingModule } from '@nestjs/testing';
import { SkusController } from './skus.controller';
import { SkusService }    from './skus.service';
import { CreateSkuDto }   from './dto/skus.dto';

const mockService = {
  createSku: jest.fn(),
  listSkus:  jest.fn(),
  findById:  jest.fn(),
  deleteSku: jest.fn(),
};

const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };
const user  = { sub: 'user_1',  role: 'CHANNEL_PARTNER', clientId: 'deoleo' };

describe('SkusController', () => {
  let controller: SkusController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SkusController],
      providers: [{ provide: SkusService, useValue: mockService }],
    }).compile();
    controller = module.get<SkusController>(SkusController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /skus — admin creates a SKU', async () => {
    mockService.createSku.mockResolvedValue({ id: 'sku_1', skuCode: 'SKU-001' });

    const dto: CreateSkuDto = {
      skuCode:   'SKU-001',
      name:      'Premium Widget',
      uom:       'PCS',
      mrpPaise:  50000,
    };
    const result = await controller.create(dto, admin as any);

    expect(mockService.createSku).toHaveBeenCalledWith(
      expect.objectContaining({ skuCode: 'SKU-001', clientId: 'deoleo' }),
    );
    expect(result.skuCode).toBe('SKU-001');
  });

  it('GET /skus — lists SKUs for client', async () => {
    mockService.listSkus.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.list(user as any, {});
    expect(mockService.listSkus).toHaveBeenCalledWith('deoleo', expect.any(Object));
    expect(result.total).toBe(0);
  });

  it('GET /skus/:id — returns SKU by id', async () => {
    mockService.findById.mockResolvedValue({ id: 'sku_1' });
    const result = await controller.findOne('sku_1', user as any);
    expect(mockService.findById).toHaveBeenCalledWith('sku_1', 'deoleo');
    expect(result).toEqual({ id: 'sku_1' });
  });

  it('DELETE /skus/:id — admin deletes a SKU', async () => {
    mockService.deleteSku.mockResolvedValue(undefined);
    await controller.remove('sku_1', admin as any);
    expect(mockService.deleteSku).toHaveBeenCalledWith('sku_1', 'deoleo');
  });
});
