// RBAC Option-X (P1) — GifsyPermissionsController delegation test.
// Run: npx jest src/gifsy/gifsy-permissions.controller.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { GifsyPermissionsController } from './gifsy-permissions.controller';
import { GifsyRolesService } from './gifsy-roles.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const mockService = {
  getPermissionCatalog: jest.fn(),
};

const USER = { role: 'GIFSY_ADMIN' } as unknown as JwtPayload;

describe('GifsyPermissionsController', () => {
  let controller: GifsyPermissionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GifsyPermissionsController],
      providers: [{ provide: GifsyRolesService, useValue: mockService }, Reflector],
    }).compile();

    controller = module.get<GifsyPermissionsController>(GifsyPermissionsController);
    jest.clearAllMocks();
  });

  it('getPermissionCatalog → getPermissionCatalog(user)', () => {
    const catalog = { groups: [], reserved: [] };
    mockService.getPermissionCatalog.mockReturnValue(catalog);
    const result = controller.getPermissionCatalog(USER);
    expect(mockService.getPermissionCatalog).toHaveBeenCalledWith(USER);
    expect(result).toBe(catalog);
  });
});
