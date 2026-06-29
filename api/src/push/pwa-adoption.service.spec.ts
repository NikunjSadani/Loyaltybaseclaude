import { PwaAdoptionService } from './pwa-adoption.service';

const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function makeService() {
  const prisma = {
    pwaInstall: { upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
    pushSubscription: { findMany: jest.fn() },
  };
  const service = new PwaAdoptionService(prisma as never);
  return { service, prisma };
}

describe('PwaAdoptionService', () => {
  describe('recordInstall', () => {
    it('upserts on (userId, platform), stamps clientId, refreshes lastSeenAt', async () => {
      const { service, prisma } = makeService();
      const res = await service.recordInstall('u1', 'deoleo', 'ANDROID', ANDROID);
      expect(res).toEqual({ ok: true });
      const arg = prisma.pwaInstall.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ userId_platform: { userId: 'u1', platform: 'ANDROID' } });
      expect(arg.create).toMatchObject({ userId: 'u1', clientId: 'deoleo', platform: 'ANDROID', userAgent: ANDROID });
      expect(arg.update).toMatchObject({ clientId: 'deoleo', userAgent: ANDROID });
      expect(arg.create.lastSeenAt).toBeInstanceOf(Date);
      expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
    });
  });

  describe('adoption', () => {
    it('scopes both queries by the caller clientId', async () => {
      const { service, prisma } = makeService();
      prisma.pushSubscription.findMany.mockResolvedValue([]);
      prisma.pwaInstall.findMany.mockResolvedValue([]);
      await service.adoption('deoleo');
      expect(prisma.pushSubscription.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo' });
      expect(prisma.pwaInstall.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo' });
    });

    it('counts distinct subscribed users + devices, and buckets by role and OS', async () => {
      const { service, prisma } = makeService();
      // u1 has 2 Android devices (SALES_ISR); u2 one iOS (SALES_SO).
      prisma.pushSubscription.findMany.mockResolvedValue([
        { userId: 'u1', userAgent: ANDROID, user: { role: 'SALES_ISR' } },
        { userId: 'u1', userAgent: ANDROID, user: { role: 'SALES_ISR' } },
        { userId: 'u2', userAgent: IOS, user: { role: 'SALES_SO' } },
      ]);
      prisma.pwaInstall.findMany.mockResolvedValue([]);
      const r = await service.adoption('deoleo');
      expect(r.subscribed.users).toBe(2); // distinct users
      expect(r.subscribed.devices).toBe(3); // rows
      expect(r.subscribed.byRole).toEqual(
        expect.arrayContaining([
          { role: 'SALES_ISR', users: 1 },
          { role: 'SALES_SO', users: 1 },
        ]),
      );
      const android = r.subscribed.byOs.find((o) => o.os === 'Android');
      const ios = r.subscribed.byOs.find((o) => o.os === 'iOS');
      expect(android?.users).toBe(1); // u1 (deduped across 2 devices)
      expect(ios?.users).toBe(1);
    });

    it('buckets a desktop userAgent as Desktop and a junk one as Other', async () => {
      const { service, prisma } = makeService();
      prisma.pushSubscription.findMany.mockResolvedValue([
        { userId: 'd1', userAgent: DESKTOP, user: { role: 'CLIENT_ADMIN' } },
        { userId: 'x1', userAgent: 'curl/8.0', user: { role: 'CLIENT_ADMIN' } },
      ]);
      prisma.pwaInstall.findMany.mockResolvedValue([]);
      const r = await service.adoption('deoleo');
      expect(r.subscribed.byOs.find((o) => o.os === 'Desktop')?.users).toBe(1);
      expect(r.subscribed.byOs.find((o) => o.os === 'Other')?.users).toBe(1);
    });

    it('counts distinct installed users + buckets by platform', async () => {
      const { service, prisma } = makeService();
      prisma.pushSubscription.findMany.mockResolvedValue([]);
      prisma.pwaInstall.findMany.mockResolvedValue([
        { userId: 'u1', platform: 'ANDROID' },
        { userId: 'u2', platform: 'ANDROID' },
        { userId: 'u3', platform: 'IOS' },
      ]);
      const r = await service.adoption('deoleo');
      expect(r.installed.users).toBe(3);
      expect(r.installed.byPlatform).toEqual(
        expect.arrayContaining([
          { platform: 'ANDROID', users: 2 },
          { platform: 'IOS', users: 1 },
        ]),
      );
    });

    it('returns zeros for an empty tenant', async () => {
      const { service, prisma } = makeService();
      prisma.pushSubscription.findMany.mockResolvedValue([]);
      prisma.pwaInstall.findMany.mockResolvedValue([]);
      const r = await service.adoption('empty');
      expect(r.subscribed.users).toBe(0);
      expect(r.subscribed.devices).toBe(0);
      expect(r.installed.users).toBe(0);
      expect(r.subscribed.byRole).toEqual([]);
      expect(r.installed.byPlatform).toEqual([]);
    });
  });
});
