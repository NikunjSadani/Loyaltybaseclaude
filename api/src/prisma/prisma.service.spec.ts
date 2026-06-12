// TDD: PrismaService
// Uses jest.mock to avoid real DB connection in unit tests

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

// Mock the PrismaClient to avoid real DB connection
jest.mock('@prisma/client', () => {
  const mPrismaClient = jest.fn().mockImplementation(() => ({
    $connect:    jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $on:         jest.fn(),
    user:               { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
    channelPartner:     { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    kycSubmission:      { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    scheme:             { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    wallet:             { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    payoutTransaction:  { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    otpCode:            { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    userSession:        { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    adminConfig:        { findMany: jest.fn(), upsert: jest.fn() },
  }));
  return { PrismaClient: mPrismaClient };
});

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should expose $connect and $disconnect', () => {
    expect(typeof service.$connect).toBe('function');
    expect(typeof service.$disconnect).toBe('function');
  });

  it('should expose all required Prisma models', () => {
    expect(service.user).toBeDefined();
    expect(service.channelPartner).toBeDefined();
    expect(service.kycSubmission).toBeDefined();
    expect(service.scheme).toBeDefined();
    expect(service.wallet).toBeDefined();
    expect(service.payoutTransaction).toBeDefined();
    expect(service.otpCode).toBeDefined();
  });
});
