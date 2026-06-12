// TDD: RewardsAdminController
// Covers:
//   CA1: POST /rewards/catalog → createCatalogItem
//   CA2: PATCH /rewards/catalog/:id → updateCatalogItem
//   CA3: DELETE /rewards/catalog/:id → softDeleteCatalogItem
//   CA4: GET /rewards/catalog/admin → listAdminCatalog

import { Test, TestingModule } from '@nestjs/testing';
import { RewardsAdminController } from './rewards-admin.controller';
import { RewardsService }         from './rewards.service';

const mockService = {
  listAdminCatalog:    jest.fn(),
  createCatalogItem:   jest.fn(),
  updateCatalogItem:   jest.fn(),
  softDeleteCatalogItem: jest.fn(),
};

const adminUser = { sub: 'admin_1', role: 'CLIENT_ADMIN', clientId: 'client_a', phone: '9999999999', name: 'Admin' };

describe('RewardsAdminController', () => {
  let controller: RewardsAdminController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RewardsAdminController],
      providers:   [{ provide: RewardsService, useValue: mockService }],
    }).compile();
    controller = module.get<RewardsAdminController>(RewardsAdminController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('CA1: POST /rewards/catalog calls createCatalogItem with clientId', async () => {
    const dto = { categoryId: 'cat_1', code: 'RWD999', name: 'Gift Card', pointsCost: 200, redemptionMode: 'GIFT_CARD' };
    mockService.createCatalogItem.mockResolvedValue({ id: 'rwd_new', ...dto });

    const result = await controller.createItem(adminUser as any, dto as any);

    expect(mockService.createCatalogItem).toHaveBeenCalledWith('client_a', dto);
    expect(result).toHaveProperty('id', 'rwd_new');
  });

  it('CA2: PATCH /rewards/catalog/:id calls updateCatalogItem', async () => {
    mockService.updateCatalogItem.mockResolvedValue({ id: 'rwd_1', name: 'Updated' });

    const result = await controller.updateItem('rwd_1', adminUser as any, { name: 'Updated' } as any);

    expect(mockService.updateCatalogItem).toHaveBeenCalledWith('rwd_1', 'client_a', { name: 'Updated' });
    expect(result).toHaveProperty('name', 'Updated');
  });

  it('CA3: DELETE /rewards/catalog/:id calls softDeleteCatalogItem', async () => {
    mockService.softDeleteCatalogItem.mockResolvedValue({ id: 'rwd_1', deletedAt: new Date() });

    await controller.deleteItem('rwd_1', adminUser as any);

    expect(mockService.softDeleteCatalogItem).toHaveBeenCalledWith('rwd_1', 'client_a');
  });

  it('CA4: GET /rewards/catalog/admin calls listAdminCatalog', async () => {
    mockService.listAdminCatalog.mockResolvedValue({ items: [], total: 0 });

    const result = await controller.listAdmin(adminUser as any, undefined, undefined, undefined);

    expect(mockService.listAdminCatalog).toHaveBeenCalledWith('client_a', expect.any(Object));
    expect(result.total).toBe(0);
  });
});
