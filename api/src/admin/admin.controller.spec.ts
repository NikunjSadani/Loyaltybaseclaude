// TDD: AdminController  (client onboarding + outlet-type-config routes)
// Tests written BEFORE implementation.

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { TenantService }   from '../tenant/tenant.service';
import { UsersService }    from '../users/users.service';
import { OutletTypeConfigService } from './outlet-type-config.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockTenantService = {
  resolveClient:      jest.fn(),
  upsertClientConfig: jest.fn(),
  listAllClients:     jest.fn(),
};

const mockUsersService = {
  createUser: jest.fn(),
  listUsers:  jest.fn(),
};

const mockOutletTypeConfigService = {
  getAll:  jest.fn(),
  upsert:  jest.fn(),
};

const gifsyAdmin  = { sub: 'u_admin', role: 'GIFSY_ADMIN',  clientId: 'gifsy' };
const clientAdmin = { sub: 'u_ca',    role: 'CLIENT_ADMIN',  clientId: 'deoleo' };

const sampleClientConfig = {
  slug:     'deoleo',
  name:     'Deoleo India',
  features: { loyalty: true, visibility: true, leaderboard: false, schemes: true, selfEnrollment: false, targets: true, rewards: false, tds: false },
  branding: { primaryColor: '#FF5733', displayName: 'Deoleo' },
  isActive: true,
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AdminController', () => {
  let controller: AdminController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: TenantService,            useValue: mockTenantService },
        { provide: UsersService,             useValue: mockUsersService  },
        { provide: OutletTypeConfigService,  useValue: mockOutletTypeConfigService },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  // ── A. Client listing ──────────────────────────────────────────────────────

  describe('A – GET /admin/clients', () => {
    it('A1: returns all clients via TenantService.listAllClients', async () => {
      mockTenantService.listAllClients.mockResolvedValue([sampleClientConfig]);

      const result = await controller.listClients(gifsyAdmin as any);
      expect(mockTenantService.listAllClients).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('deoleo');
    });
  });

  // ── B. Get single client ───────────────────────────────────────────────────

  describe('B – GET /admin/clients/:slug', () => {
    it('B1: delegates to TenantService.resolveClient', async () => {
      mockTenantService.resolveClient.mockResolvedValue(sampleClientConfig);

      const result = await controller.getClient('deoleo', gifsyAdmin as any);
      expect(mockTenantService.resolveClient).toHaveBeenCalledWith('deoleo');
      expect(result.slug).toBe('deoleo');
    });

    it('B2: propagates NotFoundException from the service', async () => {
      mockTenantService.resolveClient.mockRejectedValue(new NotFoundException());

      await expect(controller.getClient('unknown', gifsyAdmin as any)).rejects.toThrow(NotFoundException);
    });
  });

  // ── C. Upsert client config ────────────────────────────────────────────────

  describe('C – POST /admin/clients', () => {
    it('C1: calls upsertClientConfig with slug from body', async () => {
      mockTenantService.upsertClientConfig.mockResolvedValue(undefined);

      await controller.upsertClient(sampleClientConfig as any, gifsyAdmin as any);
      expect(mockTenantService.upsertClientConfig).toHaveBeenCalledWith(
        'deoleo',
        sampleClientConfig,
      );
    });

    it('C2: returns { ok: true, slug } on success', async () => {
      mockTenantService.upsertClientConfig.mockResolvedValue(undefined);

      const result = await controller.upsertClient(sampleClientConfig as any, gifsyAdmin as any);
      expect(result).toEqual({ ok: true, slug: 'deoleo' });
    });
  });

  // ── D. Create client user ──────────────────────────────────────────────────

  describe('D – POST /admin/clients/:slug/users', () => {
    const newUserBody = { name: 'Alice', phone: '9876543210', role: 'CLIENT_ADMIN', email: 'alice@deoleo.com' };

    it('D1: calls UsersService.createUser with slug as clientId', async () => {
      mockUsersService.createUser.mockResolvedValue({ id: 'u_new', ...newUserBody, clientId: 'deoleo' });

      await controller.createClientUser('deoleo', newUserBody as any, gifsyAdmin as any);
      expect(mockUsersService.createUser).toHaveBeenCalledWith({
        ...newUserBody,
        clientId: 'deoleo',
      });
    });

    it('D2: returns the created user', async () => {
      const created = { id: 'u_new', ...newUserBody, clientId: 'deoleo' };
      mockUsersService.createUser.mockResolvedValue(created);

      const result = await controller.createClientUser('deoleo', newUserBody as any, gifsyAdmin as any);
      expect(result.id).toBe('u_new');
    });
  });

  // ── E. List client users ───────────────────────────────────────────────────

  describe('E – GET /admin/clients/:slug/users', () => {
    it('E1: returns users scoped to the slug clientId', async () => {
      mockUsersService.listUsers.mockResolvedValue({ data: [], total: 0, page: 1 });

      const result = await controller.listClientUsers('deoleo', {}, gifsyAdmin as any);
      expect(mockUsersService.listUsers).toHaveBeenCalledWith('deoleo', expect.any(Object));
      expect(result.total).toBe(0);
    });
  });

  // ── F. Outlet type configs ─────────────────────────────────────────────────

  describe('F – GET /admin/clients/:slug/outlet-type-configs', () => {
    it('F1: GIFSY_ADMIN can read configs for any client', async () => {
      mockOutletTypeConfigService.getAll.mockResolvedValue([]);

      await controller.getOutletTypeConfigs('deoleo', gifsyAdmin as any);
      expect(mockOutletTypeConfigService.getAll).toHaveBeenCalledWith('deoleo');
    });

    it('F2: CLIENT_ADMIN can read configs for their own client', async () => {
      mockOutletTypeConfigService.getAll.mockResolvedValue([]);

      await controller.getOutletTypeConfigs('deoleo', clientAdmin as any);
      expect(mockOutletTypeConfigService.getAll).toHaveBeenCalledWith('deoleo');
    });

    it('F3: CLIENT_ADMIN blocked from reading another client slug', async () => {
      await expect(
        controller.getOutletTypeConfigs('other-client', clientAdmin as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── G. Upsert outlet type config ───────────────────────────────────────────

  describe('G – PUT /admin/clients/:slug/outlet-type-configs/:code', () => {
    const patch = { isEnabled: false, schemesEnabled: false };

    it('G1: GIFSY_ADMIN can update any client config', async () => {
      mockOutletTypeConfigService.upsert.mockResolvedValue({ outletTypeCode: 'RETAILER', isEnabled: false });

      await controller.upsertOutletTypeConfig('deoleo', 'RETAILER', patch as any, gifsyAdmin as any);
      expect(mockOutletTypeConfigService.upsert).toHaveBeenCalledWith('deoleo', 'RETAILER', patch);
    });

    it('G2: CLIENT_ADMIN can update their own client config', async () => {
      mockOutletTypeConfigService.upsert.mockResolvedValue({ outletTypeCode: 'RETAILER', isEnabled: false });

      await controller.upsertOutletTypeConfig('deoleo', 'RETAILER', patch as any, clientAdmin as any);
      expect(mockOutletTypeConfigService.upsert).toHaveBeenCalledWith('deoleo', 'RETAILER', patch);
    });

    it('G3: CLIENT_ADMIN blocked from updating another client slug', async () => {
      await expect(
        controller.upsertOutletTypeConfig('other-client', 'RETAILER', patch as any, clientAdmin as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('G4: returns the updated config', async () => {
      const updated = { outletTypeCode: 'RETAILER', clientId: 'deoleo', isEnabled: false };
      mockOutletTypeConfigService.upsert.mockResolvedValue(updated);

      const result = await controller.upsertOutletTypeConfig('deoleo', 'RETAILER', patch as any, gifsyAdmin as any);
      expect(result.isEnabled).toBe(false);
    });
  });
});
