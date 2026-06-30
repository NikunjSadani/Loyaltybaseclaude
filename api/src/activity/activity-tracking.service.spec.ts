import { ActivityTrackingService } from './activity-tracking.service';

describe('ActivityTrackingService', () => {
  describe('istDateKey', () => {
    it('returns the IST calendar date for an instant before the IST midnight roll', () => {
      // 2026-06-30T18:00:00Z = 2026-06-30 23:30 IST → still June 30 (IST)
      expect(ActivityTrackingService.istDateKey(new Date('2026-06-30T18:00:00Z'))).toBe('2026-06-30');
    });

    it('rolls to the next IST day after 18:30Z (00:00 IST)', () => {
      // 2026-06-30T20:00:00Z = 2026-07-01 01:30 IST → July 1 (IST), not June 30
      expect(ActivityTrackingService.istDateKey(new Date('2026-06-30T20:00:00Z'))).toBe('2026-07-01');
    });

    it('handles the exact IST midnight boundary (18:30Z)', () => {
      expect(ActivityTrackingService.istDateKey(new Date('2026-06-30T18:30:00Z'))).toBe('2026-07-01');
    });
  });

  describe('markActive', () => {
    function makePrisma() {
      return { userActivityDay: { upsert: jest.fn().mockResolvedValue({}) } } as any;
    }

    it('writes one upsert on the first hit and dedupes subsequent same-day hits', async () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);

      svc.markActive('user_1', 'deoleo');
      svc.markActive('user_1', 'deoleo');
      svc.markActive('user_1', 'deoleo');
      await Promise.resolve();

      expect(prisma.userActivityDay.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.userActivityDay.upsert.mock.calls[0][0];
      expect(arg.where.userId_activityDate.userId).toBe('user_1');
      expect(arg.create).toMatchObject({ userId: 'user_1', clientId: 'deoleo' });
    });

    it('writes separately for distinct users on the same day', async () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);

      svc.markActive('user_1', 'deoleo');
      svc.markActive('user_2', 'deoleo');
      await Promise.resolve();

      expect(prisma.userActivityDay.upsert).toHaveBeenCalledTimes(2);
    });

    it('never throws when the DB write rejects, and frees the key for retry', async () => {
      const prisma = {
        userActivityDay: { upsert: jest.fn().mockRejectedValue(new Error('db down')) },
      } as any;
      const svc = new ActivityTrackingService(prisma);

      expect(() => svc.markActive('user_1', 'deoleo')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      // After the failure the dedupe key is dropped, so the next hit retries.
      svc.markActive('user_1', 'deoleo');
      expect(prisma.userActivityDay.upsert).toHaveBeenCalledTimes(2);
    });
  });
});
