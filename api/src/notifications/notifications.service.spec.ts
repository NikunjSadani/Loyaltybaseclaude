import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  notificationQueue: { create: jest.fn() },
};

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(NotificationsService);
  });

  it('enqueues a QUEUED notification row and returns its id', async () => {
    mockPrisma.notificationQueue.create.mockResolvedValue({ id: 'n1' });
    const res = await service.enqueue({
      userId: 'u1',
      channel: 'WHATSAPP',
      body: 'Your KYC is approved',
      recipientPhone: '+919999999999',
      variables: { name: 'Asha' },
    });
    expect(res).toEqual({ id: 'n1' });
    const data = mockPrisma.notificationQueue.create.mock.calls[0][0].data;
    expect(data.status).toBe('QUEUED');
    expect(data.channel).toBe('WHATSAPP');
    expect(data.userId).toBe('u1');
    expect(data.body).toBe('Your KYC is approved');
  });
});
