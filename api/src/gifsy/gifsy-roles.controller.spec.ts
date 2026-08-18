// RBAC Option-X (P1) — GifsyRolesController delegation tests.
// Run: npx jest src/gifsy/gifsy-roles.controller.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { GifsyRolesController } from './gifsy-roles.controller';
import { GifsyRolesService } from './gifsy-roles.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const mockService = {
  listRoles: jest.fn(),
  createRole: jest.fn(),
  updateRole: jest.fn(),
  deleteRole: jest.fn(),
};

const USER = { role: 'GIFSY_ADMIN' } as unknown as JwtPayload;

describe('GifsyRolesController', () => {
  let controller: GifsyRolesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GifsyRolesController],
      providers: [{ provide: GifsyRolesService, useValue: mockService }, Reflector],
    }).compile();

    controller = module.get<GifsyRolesController>(GifsyRolesController);
    jest.clearAllMocks();
  });

  it('list → listRoles(user)', async () => {
    mockService.listRoles.mockResolvedValue([{ id: 'r1' }]);
    const result = await controller.list(USER);
    expect(mockService.listRoles).toHaveBeenCalledWith(USER);
    expect(result).toEqual([{ id: 'r1' }]);
  });

  it('create → createRole(user, dto)', async () => {
    const dto = { name: 'Ops', permissions: ['kyc:read'] };
    mockService.createRole.mockResolvedValue({ id: 'r2' });
    const result = await controller.create(USER, dto);
    expect(mockService.createRole).toHaveBeenCalledWith(USER, dto);
    expect(result).toEqual({ id: 'r2' });
  });

  it('update → updateRole(user, id, dto)', async () => {
    const dto = { name: 'Renamed' };
    mockService.updateRole.mockResolvedValue({ id: 'r3' });
    const result = await controller.update(USER, 'r3', dto);
    expect(mockService.updateRole).toHaveBeenCalledWith(USER, 'r3', dto);
    expect(result).toEqual({ id: 'r3' });
  });

  it('remove → deleteRole(user, id)', async () => {
    mockService.deleteRole.mockResolvedValue({ id: 'r4', deleted: true });
    const result = await controller.remove(USER, 'r4');
    expect(mockService.deleteRole).toHaveBeenCalledWith(USER, 'r4');
    expect(result).toEqual({ id: 'r4', deleted: true });
  });
});
