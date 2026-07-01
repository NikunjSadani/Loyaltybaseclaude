import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppController', () => {
  let appController: AppController;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn() };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  // ── Health check ───────────────────────────────────────────────────────────
  // H1: GET /health must exist and return { status: 'ok' }
  //     Used by Cloud Run liveness probes — without it the container will not
  //     be marked healthy and traffic won't be routed to it.
  describe('health', () => {
    it('H1: GET /health returns { status: "ok" }', () => {
      expect(appController.health()).toEqual({ status: 'ok' });
    });
  });

  // ── Readiness probe (Chunk O2) ───────────────────────────────────────────────
  // Liveness (/health) must NOT touch the DB; readiness (/health/ready) must.
  describe('health/ready', () => {
    it('returns { status: "ready", db: "up" } when the DB responds', async () => {
      prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await expect(appController.ready()).resolves.toEqual({
        status: 'ready',
        db: 'up',
      });
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('throws ServiceUnavailableException when the DB is down', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      await expect(appController.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
