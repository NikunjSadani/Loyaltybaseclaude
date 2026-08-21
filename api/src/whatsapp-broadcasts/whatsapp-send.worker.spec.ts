import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WhatsappSendWorker } from './whatsapp-send.worker';

const row = {
  id: 'r1',
  broadcastId: 'b1',
  phone: '9830011252',
  variables: ['Asha'],
  broadcast: { id: 'b1', template: { msg91TemplateName: 'tpl', languageCode: 'en' } },
};

describe('WhatsappSendWorker', () => {
  let worker: WhatsappSendWorker;

  const mockPrisma: any = {
    whatsappBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    whatsappBroadcastRecipient: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const mockMsg91 = { sendWhatsappTemplate: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappSendWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    worker = module.get(WhatsappSendWorker);
    process.env.WHATSAPP_WORKER_ENABLED = 'true';
  });

  afterAll(() => {
    delete process.env.WHATSAPP_WORKER_ENABLED;
  });

  it('is a no-op when the worker flag is off', async () => {
    process.env.WHATSAPP_WORKER_ENABLED = 'false';
    await worker.drain();
    expect(mockPrisma.whatsappBroadcastRecipient.findMany).not.toHaveBeenCalled();
  });

  it('claims a row (count===1), sends with crqid=row.id, marks SENT, increments sentCount', async () => {
    mockPrisma.whatsappBroadcastRecipient.findMany.mockResolvedValue([row]);
    mockPrisma.whatsappBroadcastRecipient.updateMany.mockResolvedValue({ count: 1 }); // claim wins
    mockMsg91.sendWhatsappTemplate.mockResolvedValue({ requestId: 'REQ1' });

    await worker.drain();

    // crqid = the row id, language from the template
    expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith('9830011252', 'tpl', ['Asha'], {
      crqid: 'r1',
      languageCode: 'en',
    });
    expect(mockPrisma.whatsappBroadcastRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'SENT', sentAt: expect.any(Date), msg91RequestId: 'REQ1' },
    });
    expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { sentCount: { increment: 1 } },
    });
  });

  it('a losing claim (count===0) does NOT send (no double-send)', async () => {
    mockPrisma.whatsappBroadcastRecipient.findMany.mockResolvedValue([row]);
    mockPrisma.whatsappBroadcastRecipient.updateMany.mockResolvedValue({ count: 0 }); // lost the claim

    await worker.drain();
    expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it('a send failure marks the row FAILED + increments failedCount (batch continues)', async () => {
    mockPrisma.whatsappBroadcastRecipient.findMany.mockResolvedValue([row]);
    mockPrisma.whatsappBroadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
    mockMsg91.sendWhatsappTemplate.mockRejectedValue(new Error('MSG91 down'));

    await worker.drain();
    expect(mockPrisma.whatsappBroadcastRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'FAILED', errorReason: expect.stringContaining('MSG91 down') },
    });
    expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { failedCount: { increment: 1 } },
    });
  });
});
