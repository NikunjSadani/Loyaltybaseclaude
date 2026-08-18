// Integration tests for GifsyStaffController — verifies delegation to the service.
// Run: npx jest --no-coverage src/gifsy/gifsy-staff.controller.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { GifsyStaffController } from './gifsy-staff.controller';
import { GifsyStaffService } from './gifsy-staff.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockStaffService = {
  listStaff: jest.fn(),
  createStaff: jest.fn(),
  updateStaff: jest.fn(),
};

const user: JwtPayload = {
  sub: 'owner_1',
  role: 'GIFSY_ADMIN',
  clientId: 'gifsy',
  phone: '9999999999',
  name: 'Owner',
};

describe('GifsyStaffController', () => {
  let controller: GifsyStaffController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GifsyStaffController],
      providers: [
        { provide: GifsyStaffService, useValue: mockStaffService },
        Reflector,
      ],
    }).compile();

    controller = module.get<GifsyStaffController>(GifsyStaffController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('GET / delegates to listStaff with the JWT payload', async () => {
    mockStaffService.listStaff.mockResolvedValue([{ id: 'u1' }]);
    const res = await controller.list(user);
    expect(mockStaffService.listStaff).toHaveBeenCalledWith(user);
    expect(res).toEqual([{ id: 'u1' }]);
  });

  it('POST / delegates to createStaff with the DTO', async () => {
    const dto = { name: 'Alice', phone: '9000000001', gifsyRoleId: 'r1' };
    mockStaffService.createStaff.mockResolvedValue({ id: 'u1' });
    const res = await controller.create(user, dto);
    expect(mockStaffService.createStaff).toHaveBeenCalledWith(user, dto);
    expect(res).toEqual({ id: 'u1' });
  });

  it('PATCH :id delegates to updateStaff with id and DTO', async () => {
    const dto = { status: 'INACTIVE' as const };
    mockStaffService.updateStaff.mockResolvedValue({ id: 'u1' });
    const res = await controller.update(user, 'u1', dto);
    expect(mockStaffService.updateStaff).toHaveBeenCalledWith(user, 'u1', dto);
    expect(res).toEqual({ id: 'u1' });
  });
});
