// TDD: LeaderboardAdminController
// Covers:
//   LCA1: POST /leaderboard/configs → createConfig
//   LCA2: GET /leaderboard/configs → listConfigs

import { Test, TestingModule }        from '@nestjs/testing';
import { LeaderboardAdminController } from './leaderboard-admin.controller';
import { LeaderboardService }         from './leaderboard.service';

const mockService = {
  listConfigs:  jest.fn(),
  createConfig: jest.fn(),
};

const adminUser = { sub: 'admin_1', role: 'CLIENT_ADMIN', clientId: 'client_a', phone: '9999999999', name: 'Admin' };

describe('LeaderboardAdminController', () => {
  let controller: LeaderboardAdminController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LeaderboardAdminController],
      providers:   [{ provide: LeaderboardService, useValue: mockService }],
    }).compile();
    controller = module.get<LeaderboardAdminController>(LeaderboardAdminController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('LCA1: POST /leaderboard/configs calls createConfig', async () => {
    const dto = { code: 'LB_M', name: 'Monthly', leaderboardType: 'POINTS_EARNED', period: 'MONTHLY', topN: 10 };
    mockService.createConfig.mockResolvedValue({ id: 'cfg_new', clientId: 'client_a', ...dto });

    const result = await controller.createConfig(adminUser as any, dto as any);

    expect(mockService.createConfig).toHaveBeenCalledWith('client_a', dto);
    expect(result).toHaveProperty('clientId', 'client_a');
  });

  it('LCA2: GET /leaderboard/configs calls listConfigs', async () => {
    mockService.listConfigs.mockResolvedValue([{ id: 'cfg_1' }, { id: 'cfg_2' }]);

    const result = await controller.listConfigs(adminUser as any);

    expect(mockService.listConfigs).toHaveBeenCalledWith('client_a');
    expect(result).toHaveLength(2);
  });
});
