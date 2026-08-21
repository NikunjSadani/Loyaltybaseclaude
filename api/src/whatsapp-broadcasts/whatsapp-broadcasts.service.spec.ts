import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WhatsappBroadcastsService } from './whatsapp-broadcasts.service';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { WhatsappAudienceService } from './whatsapp-audience.service';
import { WhatsappSendWorker } from './whatsapp-send.worker';

const activeTemplate = {
  id: 't1',
  clientId: 'deoleo',
  status: 'ACTIVE',
  bodyText: 'Hi {{1}}',
  msg91TemplateName: 'tpl_welcome',
  languageCode: 'en',
  variableContract: [{ index: 1, label: 'Name' }],
};

const resolution = {
  recipients: [{ phone: '9830011252', fields: { ownerName: 'Asha' } }],
  recipientCount: 1,
  dedupedCount: 2,
  invalidCount: 1,
  suppressedCount: 0,
};

describe('WhatsappBroadcastsService', () => {
  let service: WhatsappBroadcastsService;

  const mockPrisma: any = {
    whatsappBroadcast: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    whatsappBroadcastRecipient: { createMany: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(async (arg: any) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(mockPrisma),
    ),
  };
  const mockTemplates = { getOwned: jest.fn() };
  const mockAudience = { resolveFilter: jest.fn(), resolveExcel: jest.fn() };
  const mockMsg91 = { sendWhatsappTemplate: jest.fn() };
  const mockWorker = { drain: jest.fn().mockResolvedValue(undefined) };

  const asGifsy = { sub: 'op1', clientId: 'deoleo', role: 'GIFSY_ADMIN' } as any;
  const asTenant = { sub: 't1', clientId: 'deoleo', role: 'CLIENT_ADMIN' } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappBroadcastsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WhatsappTemplatesService, useValue: mockTemplates },
        { provide: WhatsappAudienceService, useValue: mockAudience },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: WhatsappSendWorker, useValue: mockWorker },
      ],
    }).compile();
    service = module.get(WhatsappBroadcastsService);
    mockTemplates.getOwned.mockResolvedValue(activeTemplate);
    mockAudience.resolveFilter.mockResolvedValue(resolution);
    mockPrisma.whatsappBroadcast.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'b1', ...data }),
    );
    mockPrisma.whatsappBroadcastRecipient.createMany.mockResolvedValue({ count: 1 });
    // Default: no idempotency-dupe found (each test that needs one overrides this).
    mockPrisma.whatsappBroadcast.findFirst.mockResolvedValue(null);
  });

  describe('Gifsy-only data boundary', () => {
    it('403s a tenant CLIENT_ADMIN on preview (even though the route guard would too)', async () => {
      await expect(
        service.preview(asTenant, { templateId: 't1', mode: 'FILTER', scope: 'OUTLETS' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('403s a tenant CLIENT_ADMIN on create', async () => {
      await expect(
        service.create(asTenant, { title: 'X', templateId: 't1', mode: 'FILTER', scope: 'OUTLETS' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('preview', () => {
    it('returns count/dedup/invalid + a rendered sample (no rows written)', async () => {
      const res = await service.preview(asGifsy, {
        templateId: 't1',
        mode: 'FILTER',
        scope: 'OUTLETS',
        variableMapping: [{ index: 1, source: 'ownerName' }],
      } as any);
      expect(res.recipientCount).toBe(1);
      expect(res.deduped).toBe(2);
      expect(res.invalidCount).toBe(1);
      expect(res.sample[0]).toEqual({ phone: '9830011252', renderedBody: 'Hi Asha' });
      expect(mockPrisma.whatsappBroadcast.create).not.toHaveBeenCalled();
    });

    it('rejects an archived template', async () => {
      mockTemplates.getOwned.mockResolvedValue({ ...activeTemplate, status: 'ARCHIVED' });
      await expect(
        service.preview(asGifsy, { templateId: 't1', mode: 'FILTER', scope: 'OUTLETS' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('create', () => {
    it('writes the campaign + QUEUED rows (frozen vars), status SENDING, kicks the worker', async () => {
      const res = await service.create(asGifsy, {
        title: 'Diwali blast',
        templateId: 't1',
        mode: 'FILTER',
        scope: 'OUTLETS',
        variableMapping: [{ index: 1, source: 'ownerName' }],
      } as any);

      expect(res.broadcast.status).toBe('SENDING');
      expect(res.broadcast.recipientCount).toBe(1);
      expect(res.id).toBe('b1'); // FE routes on res.data.id
      const rows = mockPrisma.whatsappBroadcastRecipient.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ broadcastId: 'b1', clientId: 'deoleo', phone: '9830011252', status: 'QUEUED' });
      expect(rows[0].variables).toEqual(['Asha']); // frozen derived var
      expect(mockWorker.drain).toHaveBeenCalled();
    });

    it('idempotency: a duplicate create within the window returns the existing campaign', async () => {
      mockPrisma.whatsappBroadcast.findFirst.mockResolvedValue({ id: 'existing1', title: 'Diwali blast' });
      const res = await service.create(asGifsy, {
        title: 'Diwali blast',
        templateId: 't1',
        mode: 'FILTER',
        scope: 'OUTLETS',
      } as any);
      expect(res.id).toBe('existing1');
      expect(mockPrisma.whatsappBroadcast.create).not.toHaveBeenCalled();
    });

    it('409s when the live audience grew past the previewed expectedCount + tolerance', async () => {
      mockAudience.resolveFilter.mockResolvedValue({ ...resolution, recipientCount: 100, recipients: resolution.recipients });
      await expect(
        service.create(asGifsy, {
          title: 'Drift',
          templateId: 't1',
          mode: 'FILTER',
          scope: 'OUTLETS',
          expectedCount: 10,
        } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an audience beyond the max-recipient ceiling', async () => {
      process.env.WHATSAPP_MAX_RECIPIENTS = '50';
      mockAudience.resolveFilter.mockResolvedValue({ ...resolution, recipientCount: 51, recipients: resolution.recipients });
      await expect(
        service.create(asGifsy, { title: 'Too big', templateId: 't1', mode: 'FILTER', scope: 'OUTLETS' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      delete process.env.WHATSAPP_MAX_RECIPIENTS;
    });

    it('a future scheduledAt → status SCHEDULED and does NOT kick the worker', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const res = await service.create(asGifsy, {
        title: 'Later',
        templateId: 't1',
        mode: 'FILTER',
        scope: 'OUTLETS',
        scheduledAt: future,
      } as any);
      expect(res.broadcast.status).toBe('SCHEDULED');
      expect(mockWorker.drain).not.toHaveBeenCalled();
    });

    it('rejects an empty audience', async () => {
      mockAudience.resolveFilter.mockResolvedValue({ ...resolution, recipients: [], recipientCount: 0 });
      await expect(
        service.create(asGifsy, { title: 'X', templateId: 't1', mode: 'FILTER', scope: 'OUTLETS' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('flips a SCHEDULED broadcast to CANCELLED and SKIPs still-QUEUED rows', async () => {
      mockPrisma.whatsappBroadcast.findFirst.mockResolvedValue({ id: 'b1', clientId: 'deoleo', status: 'SCHEDULED' });
      mockPrisma.whatsappBroadcast.update.mockResolvedValue({ id: 'b1', status: 'CANCELLED' });
      mockPrisma.whatsappBroadcastRecipient.updateMany.mockResolvedValue({ count: 3 });

      const res = await service.cancel(asGifsy, 'b1');
      expect(res.broadcast.status).toBe('CANCELLED');
      expect(mockPrisma.whatsappBroadcastRecipient.updateMany).toHaveBeenCalledWith({
        where: { broadcastId: 'b1', clientId: 'deoleo', status: 'QUEUED' },
        data: { status: 'SKIPPED' },
      });
    });

    it('refuses to cancel a SENT broadcast', async () => {
      mockPrisma.whatsappBroadcast.findFirst.mockResolvedValue({ id: 'b1', clientId: 'deoleo', status: 'SENT' });
      await expect(service.cancel(asGifsy, 'b1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('response shapes (FE alignment)', () => {
    it('list returns { items } with a flat templateName', async () => {
      mockPrisma.whatsappBroadcast.findMany.mockResolvedValue([
        { id: 'b1', title: 'A', template: { name: 'Welcome' } },
      ]);
      const res = await service.list(asGifsy);
      expect(Array.isArray(res.items)).toBe(true);
      expect(res.items[0]).toMatchObject({ id: 'b1', templateName: 'Welcome' });
    });

    it('detail returns a FLAT campaign + funnel + failureReasons', async () => {
      mockPrisma.whatsappBroadcast.findFirst.mockResolvedValue({
        id: 'b1',
        title: 'A',
        status: 'SENDING',
        sentCount: 2,
        recipientCount: 3,
        template: { name: 'Welcome', msg91TemplateName: 'x', bodyText: 'Hi' },
      });
      mockPrisma.whatsappBroadcastRecipient.groupBy.mockResolvedValue([
        { status: 'SENT', _count: { _all: 2 } },
        { status: 'QUEUED', _count: { _all: 1 } },
      ]);
      mockPrisma.whatsappBroadcastRecipient.findMany.mockResolvedValue([]);
      const res: any = await service.detail(asGifsy, 'b1');
      expect(res.title).toBe('A'); // flat
      expect(res.status).toBe('SENDING');
      expect(res.sentCount).toBe(2);
      expect(res.templateName).toBe('Welcome');
      expect(res.queuedCount).toBe(1);
      expect(res.funnel.SENT).toBe(2);
      expect(Array.isArray(res.failureReasons)).toBe(true);
    });
  });

  describe('resendFailed — FAILED only + returns id', () => {
    it('targets status:FAILED ONLY (never SENT/undelivered) and returns the new id', async () => {
      mockPrisma.whatsappBroadcast.findFirst.mockResolvedValue({
        id: 'b1',
        clientId: 'deoleo',
        templateId: 't1',
        title: 'Orig',
        template: { id: 't1', status: 'ACTIVE' },
      });
      mockPrisma.whatsappBroadcastRecipient.findMany.mockResolvedValue([
        { phone: '9830011252', variables: ['Asha'] },
      ]);
      const res = await service.resendFailed(asGifsy, 'b1');
      expect(res.id).toBe('b1');
      const where = mockPrisma.whatsappBroadcastRecipient.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('FAILED');
      expect(where.OR).toBeUndefined();
    });
  });

  describe('testSend — only real dispatches count as sent', () => {
    it('counts a malformed (dropped) number as failed, not sent', async () => {
      mockMsg91.sendWhatsappTemplate.mockResolvedValue({ requestId: 'REQ' });
      const res = await service.testSend(asGifsy, {
        templateId: 't1',
        phones: ['9830011252', '123'], // second is malformed → would be dropped
      } as any);
      expect(res.sent).toBe(1);
      expect(res.failed).toBe(1);
      expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    });
  });
});
