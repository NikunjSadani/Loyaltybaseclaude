// TDD: VisibilityAdminController
// Covers:
//   VCA1: POST /visibility/programs → createProgram
//   VCA2: PATCH /visibility/programs/:id → updateProgram
//   VCA3: GET /visibility/programs → listPrograms

import { Test, TestingModule }       from '@nestjs/testing';
import { VisibilityAdminController } from './visibility-admin.controller';
import { VisibilityService }         from './visibility.service';

const mockService = {
  listPrograms:  jest.fn(),
  createProgram: jest.fn(),
  updateProgram: jest.fn(),
};

const adminUser = { sub: 'admin_1', role: 'CLIENT_ADMIN', clientId: 'client_a', phone: '9999999999', name: 'Admin' };

describe('VisibilityAdminController', () => {
  let controller: VisibilityAdminController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VisibilityAdminController],
      providers:   [{ provide: VisibilityService, useValue: mockService }],
    }).compile();
    controller = module.get<VisibilityAdminController>(VisibilityAdminController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('VCA1: POST /visibility/programs calls createProgram', async () => {
    const dto = { code: 'VIS001', name: 'Q2 Drive', startDate: '2026-07-01', endDate: '2026-09-30', pointsPerSubmission: 50 };
    mockService.createProgram.mockResolvedValue({ id: 'prg_new', status: 'DRAFT', ...dto });

    const result = await controller.createProgram(adminUser as any, dto as any);

    expect(mockService.createProgram).toHaveBeenCalledWith('client_a', 'admin_1', dto);
    expect(result).toHaveProperty('status', 'DRAFT');
  });

  it('VCA2: PATCH /visibility/programs/:id calls updateProgram', async () => {
    mockService.updateProgram.mockResolvedValue({ id: 'prg_1', status: 'ACTIVE' });

    const result = await controller.updateProgram('prg_1', adminUser as any, { status: 'ACTIVE' } as any);

    expect(mockService.updateProgram).toHaveBeenCalledWith('prg_1', 'client_a', { status: 'ACTIVE' });
    expect(result).toHaveProperty('status', 'ACTIVE');
  });

  it('VCA3: GET /visibility/programs calls listPrograms', async () => {
    mockService.listPrograms.mockResolvedValue({ data: [], total: 0 });

    const result = await controller.listPrograms(adminUser as any, undefined, undefined, undefined);

    expect(mockService.listPrograms).toHaveBeenCalledWith('client_a', expect.any(Object));
    expect(result.total).toBe(0);
  });
});
