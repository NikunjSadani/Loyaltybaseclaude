// TDD: UsersService

import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';

const mockPrisma = {
  user: {
    findFirst:  jest.fn(),
    findMany:   jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    count:      jest.fn(),
  },
};

const mockUser = {
  id: 'user_1', clientId: 'deoleo', name: 'Amit Sharma',
  phone: '9876543210', role: 'RETAILER', status: 'ACTIVE',
  deletedAt: null,
};

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createUser', () => {
    it('should create a user successfully', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null); // no duplicate
      mockPrisma.user.create.mockResolvedValue(mockUser);

      const result = await service.createUser({
        clientId: 'deoleo', name: 'Amit Sharma',
        phone: '9876543210', role: 'RETAILER',
      });
      expect(result.id).toBe('user_1');
      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('should throw ConflictException if phone already exists for this client', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser); // duplicate
      await expect(service.createUser({
        clientId: 'deoleo', name: 'Test', phone: '9876543210', role: 'RETAILER',
      })).rejects.toThrow(ConflictException);
    });

    it('should allow same phone on a DIFFERENT client (multi-tenant)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null); // no conflict for this client
      mockPrisma.user.create.mockResolvedValue({ ...mockUser, clientId: 'client2' });

      const result = await service.createUser({
        clientId: 'client2', name: 'Test', phone: '9876543210', role: 'RETAILER',
      });
      expect(result.clientId).toBe('client2');
    });
  });

  describe('findById', () => {
    it('should return user when found', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser);
      const result = await service.findById('user_1', 'deoleo');
      expect(result.id).toBe('user_1');
    });

    it('should throw NotFoundException when user not found', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.findById('missing', 'deoleo')).rejects.toThrow(NotFoundException);
    });

    it('should NOT return user from different client (tenant isolation)', async () => {
      // Prisma query includes clientId filter — mock returns null for wrong client
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.findById('user_1', 'other-client')).rejects.toThrow(NotFoundException);

      // Verify clientId was passed in the where clause
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ clientId: 'other-client' }),
        }),
      );
    });
  });

  describe('updateUser', () => {
    it('should update allowed fields', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({ ...mockUser, name: 'New Name' });

      const result = await service.updateUser('user_1', 'deoleo', { name: 'New Name' });
      expect(result.name).toBe('New Name');
    });

    it('should throw ForbiddenException if trying to change clientId', async () => {
      await expect(
        service.updateUser('user_1', 'deoleo', { clientId: 'other' } as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('softDeleteUser', () => {
    it('should set deletedAt instead of hard deleting', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({ ...mockUser, deletedAt: new Date() });

      await service.softDeleteUser('user_1', 'deoleo');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });
  });
});
