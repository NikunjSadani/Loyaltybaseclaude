import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
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
  //
  // RED: AppController has no health() method yet — will fail until added.

  describe('health', () => {
    it('H1: GET /health returns { status: "ok" }', () => {
      expect(appController.health()).toEqual({ status: 'ok' });
    });
  });
});
