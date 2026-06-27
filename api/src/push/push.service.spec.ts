import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PushSubscriptionService } from './push-subscription.service';
import { PushSenderService } from './push-sender.service';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webpush = require('web-push') as {
  setVapidDetails: jest.Mock;
  sendNotification: jest.Mock;
};

const mockPrisma = {
  pushSubscription: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
  },
};

describe('PushSubscriptionService — tenant isolation contract', () => {
  let service: PushSubscriptionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushSubscriptionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(PushSubscriptionService);
  });

  it('upserts keyed on the unique endpoint, taking userId/clientId from params (never the body)', async () => {
    mockPrisma.pushSubscription.upsert.mockResolvedValue({ id: 's1' });
    const res = await service.upsert({
      userId: 'u1',
      clientId: 'deoleo',
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
      userAgent: 'UA',
    });
    expect(res).toEqual({ id: 's1' });
    const arg = mockPrisma.pushSubscription.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ endpoint: 'https://push.example/abc' });
    // Both create and update set userId/clientId from the (JWT-derived) params.
    expect(arg.create.userId).toBe('u1');
    expect(arg.create.clientId).toBe('deoleo');
    expect(arg.update.userId).toBe('u1');
    expect(arg.update.clientId).toBe('deoleo');
  });

  it('remove() is scoped to {userId, endpoint} — a user cannot delete another user\'s row', async () => {
    mockPrisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
    await service.remove('u1', 'https://push.example/abc');
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', endpoint: 'https://push.example/abc' },
    });
  });

  it('listByUser() reads only the caller\'s (tenant-bound) subscriptions', () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([]);
    service.listByUser('u1');
    expect(mockPrisma.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });
});

describe('PushSenderService', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  // The constructor reads process.env directly, so instantiate per-test (after
  // setting env) rather than via Nest DI — avoids resetModules token-identity churn.
  function makeSender() {
    return new PushSenderService(mockPrisma as unknown as PrismaService);
  }

  it('is a no-op (returns 0, never queries) when VAPID is unconfigured', async () => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    const sender = makeSender();
    const n = await sender.sendToUser('u1', { title: 'T', body: 'B' });
    expect(n).toBe(0);
    expect(mockPrisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });

  it('sends to the user\'s endpoints, prunes a 410-Gone endpoint, and isolates per-sub errors', async () => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:ops@gifsy.in',
    };
    mockPrisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'live', endpoint: 'e1', p256dh: 'p', auth: 'a' },
      { id: 'dead', endpoint: 'e2', p256dh: 'p', auth: 'a' },
    ]);
    mockPrisma.pushSubscription.delete.mockResolvedValue({});
    webpush.sendNotification
      .mockResolvedValueOnce({}) // live endpoint accepts
      .mockRejectedValueOnce({ statusCode: 410 }); // dead endpoint → prune

    const sender = await makeSender();
    const n = await sender.sendToUser('u1', { title: 'T', body: 'B', url: '/sales' });

    expect(n).toBe(1); // only the live endpoint counted
    expect(mockPrisma.pushSubscription.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(mockPrisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'dead' } });
  });
});
