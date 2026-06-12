// TDD: SchemesController
import { Test, TestingModule } from '@nestjs/testing';
import { SchemesController } from './schemes.controller';
import { SchemesService }    from './schemes.service';
import { CreateSchemeDto }   from './dto/schemes.dto';

const mockService = {
  createScheme:    jest.fn(),
  listSchemes:     jest.fn(),
  activateScheme:  jest.fn(),
  pauseScheme:     jest.fn(),
};

const user  = { sub: 'user_1',  role: 'CHANNEL_PARTNER', clientId: 'deoleo' };
const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN',     clientId: 'deoleo' };

describe('SchemesController', () => {
  let controller: SchemesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SchemesController],
      providers: [{ provide: SchemesService, useValue: mockService }],
    }).compile();
    controller = module.get<SchemesController>(SchemesController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /schemes — admin creates a scheme', async () => {
    mockService.createScheme.mockResolvedValue({ id: 'scheme_1', code: 'DIWALI25', status: 'DRAFT' });

    const dto: CreateSchemeDto = {
      code:        'DIWALI25',
      name:        'Diwali 2025',
      schemeType:  'PURCHASE_INCENTIVE',
      rewardType:  'POINTS',
      startDate:   '2025-10-01',
      endDate:     '2025-10-31',
      fixedPoints: 50,
    };
    const result = await controller.create(dto, admin as any);

    expect(mockService.createScheme).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DIWALI25', clientId: 'deoleo' }),
    );
    expect(result.status).toBe('DRAFT');
  });

  it('GET /schemes — lists schemes', async () => {
    mockService.listSchemes.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.list(user as any, {});
    expect(mockService.listSchemes).toHaveBeenCalledWith('deoleo', expect.any(Object));
    expect(result.total).toBe(0);
  });

  it('PATCH /schemes/:id/activate — activates a scheme', async () => {
    mockService.activateScheme.mockResolvedValue({ id: 'scheme_1', status: 'ACTIVE' });
    const result = await controller.activate('scheme_1', admin as any);
    expect(mockService.activateScheme).toHaveBeenCalledWith('scheme_1', 'deoleo');
    expect(result.status).toBe('ACTIVE');
  });

  it('PATCH /schemes/:id/pause — pauses a scheme', async () => {
    mockService.pauseScheme.mockResolvedValue({ id: 'scheme_1', status: 'PAUSED' });
    const result = await controller.pause('scheme_1', admin as any);
    expect(mockService.pauseScheme).toHaveBeenCalledWith('scheme_1', 'deoleo');
    expect(result.status).toBe('PAUSED');
  });
});
