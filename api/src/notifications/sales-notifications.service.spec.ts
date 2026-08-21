import { SalesNotificationsService } from './sales-notifications.service';

/**
 * Unit tests for SalesNotificationsService.
 *
 * Follows the plain-mock style: both deps (PrismaService, NotificationsService)
 * are plain objects cast as `any`, no Nest TestingModule. The hierarchy helper
 * `firstActiveApproverId` is NOT mocked — it runs for real against the node
 * lists we feed via `salesUser.findMany`, so the mocked rows are shaped to drive it.
 */
describe('SalesNotificationsService', () => {
  let notifications: { enqueue: jest.Mock; writeInApp: jest.Mock };
  let prisma: {
    salesUser: { findFirst: jest.Mock; findMany: jest.Mock };
    salesUserAssignment: { findFirst: jest.Mock; findMany: jest.Mock };
    outlet: { findFirst: jest.Mock };
  };
  let service: SalesNotificationsService;

  beforeEach(() => {
    notifications = {
      enqueue: jest.fn().mockResolvedValue({ id: 'n1' }),
      writeInApp: jest.fn().mockResolvedValue({ id: 'n1' }),
    };
    prisma = {
      salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
      salesUserAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
      outlet: { findFirst: jest.fn() },
    };
    // NotificationsService is resolved lazily via ModuleRef in onModuleInit (breaks a
    // provider cycle) — provide a ModuleRef stub whose get() returns the mock, then init.
    const moduleRef = { get: jest.fn().mockReturnValue(notifications) };
    service = new SalesNotificationsService(prisma as any, moduleRef as any);
    service.onModuleInit();
  });

  /* ── Event 1: outletsAssigned ──────────────────────────────────────────── */

  describe('outletsAssigned', () => {
    it('does NOT enqueue when count <= 0', async () => {
      await service.outletsAssigned('c1', 'su1', 0);
      await service.outletsAssigned('c1', 'su1', -3);
      expect(notifications.enqueue).not.toHaveBeenCalled();
      expect(prisma.salesUser.findFirst).not.toHaveBeenCalled();
    });

    it('enqueues a singular PUSH when count is 1 and the rep resolves', async () => {
      prisma.salesUser.findFirst.mockResolvedValue({ userId: 'u1' });

      await service.outletsAssigned('c1', 'su1', 1);

      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      const arg = notifications.enqueue.mock.calls[0][0];
      expect(arg).toMatchObject({ userId: 'u1', channel: 'PUSH', subject: 'New KYC assigned' });
      expect(arg.body).toContain('1');
      expect(arg.body).toContain('outlet');
      expect(arg.body).not.toContain('outlets');
      expect(arg.variables).toEqual({ url: '/sales/kyc' });
    });

    it('enqueues a plural PUSH when count is > 1', async () => {
      prisma.salesUser.findFirst.mockResolvedValue({ userId: 'u1' });

      await service.outletsAssigned('c1', 'su1', 5);

      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      const arg = notifications.enqueue.mock.calls[0][0];
      expect(arg.userId).toBe('u1');
      expect(arg.channel).toBe('PUSH');
      expect(arg.body).toContain('5');
      expect(arg.body).toContain('outlets');
    });

    it('does NOT enqueue when the rep is not found (wrong tenant / deleted)', async () => {
      prisma.salesUser.findFirst.mockResolvedValue(null);

      await service.outletsAssigned('c1', 'su1', 3);

      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('swallows a thrown findFirst (fire-and-forget) and resolves', async () => {
      prisma.salesUser.findFirst.mockRejectedValue(new Error('db down'));

      await expect(service.outletsAssigned('c1', 'su1', 2)).resolves.toBeUndefined();
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });
  });

  /* ── Event 2: kycSubmittedForApproval ──────────────────────────────────── */

  describe('kycSubmittedForApproval', () => {
    it('enqueues to the first active manager up the chain', async () => {
      // 1st findFirst: resolve submitter s1. 2nd findFirst: map approver m1 -> userId mu1.
      prisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 's1' })
        .mockResolvedValueOnce({ userId: 'mu1' });
      // tenantNodes: s1 reports to active m1.
      prisma.salesUser.findMany.mockResolvedValue([
        { id: 's1', reportingToId: 'm1', isActive: true },
        { id: 'm1', reportingToId: null, isActive: true },
      ]);

      await service.kycSubmittedForApproval('c1', 'login-s1', 'Acme Store (XSR-9)');

      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      const arg = notifications.enqueue.mock.calls[0][0];
      expect(arg).toMatchObject({
        userId: 'mu1',
        channel: 'PUSH',
        subject: 'KYC pending approval',
      });
      expect(arg.body).toContain('Acme Store (XSR-9)');
      expect(arg.variables).toEqual({ url: '/sales/kyc' });
    });

    it('does NOT enqueue when the submitter is not a sales user', async () => {
      prisma.salesUser.findFirst.mockResolvedValue(null);

      await service.kycSubmittedForApproval('c1', 'login-x', 'Acme Store');

      expect(notifications.enqueue).not.toHaveBeenCalled();
      // never walks the hierarchy
      expect(prisma.salesUser.findMany).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when there is no active manager up the chain', async () => {
      prisma.salesUser.findFirst.mockResolvedValueOnce({ id: 's1' });
      // s1 has no manager (reportingToId null) → firstActiveApproverId returns null.
      prisma.salesUser.findMany.mockResolvedValue([
        { id: 's1', reportingToId: null, isActive: true },
      ]);

      await service.kycSubmittedForApproval('c1', 'login-s1', 'Acme Store');

      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('swallows a thrown findMany and resolves', async () => {
      prisma.salesUser.findFirst.mockResolvedValueOnce({ id: 's1' });
      prisma.salesUser.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.kycSubmittedForApproval('c1', 'login-s1', 'Acme Store'),
      ).resolves.toBeUndefined();
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });
  });

  /* ── Event 3: kycBounced ───────────────────────────────────────────────── */

  describe('kycBounced', () => {
    it('does NOT enqueue when partnerId is null', async () => {
      await service.kycBounced('c1', null, 'REJECTED', 'bad docs');
      expect(notifications.enqueue).not.toHaveBeenCalled();
      expect(prisma.outlet.findFirst).not.toHaveBeenCalled();
    });

    it('enqueues a REJECTED push (with reason tail) to the responsible rep', async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme Store' });
      prisma.salesUserAssignment.findFirst.mockResolvedValue({
        salesUser: { id: 's1', userId: 'u1' },
      });

      await service.kycBounced('c1', 'p1', 'REJECTED', 'Blurry GSTIN');

      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      const arg = notifications.enqueue.mock.calls[0][0];
      expect(arg).toMatchObject({
        userId: 'u1',
        channel: 'PUSH',
        subject: 'KYC rejected',
      });
      expect(arg.body).toContain('rejected');
      expect(arg.body).toContain('Blurry GSTIN');
      expect(arg.body).toContain('Reason:');
    });

    it('enqueues a RE_UPLOAD_REQUIRED push with the re-upload subject/body', async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme Store' });
      prisma.salesUserAssignment.findFirst.mockResolvedValue({
        salesUser: { id: 's1', userId: 'u1' },
      });

      await service.kycBounced('c1', 'p1', 'RE_UPLOAD_REQUIRED', 'Missing page 2');

      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      const arg = notifications.enqueue.mock.calls[0][0];
      expect(arg.userId).toBe('u1');
      expect(arg.subject).toBe('KYC re-upload required');
      expect(arg.body).toContain('re-upload');
      expect(arg.body).toContain('Missing page 2');
    });

    it('omits the "Reason:" tail when reason is null', async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme Store' });
      prisma.salesUserAssignment.findFirst.mockResolvedValue({
        salesUser: { id: 's1', userId: 'u1' },
      });

      await service.kycBounced('c1', 'p1', 'REJECTED', null);

      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue.mock.calls[0][0].body).not.toContain('Reason:');
    });

    it('does NOT enqueue when the outlet is not found', async () => {
      prisma.outlet.findFirst.mockResolvedValue(null);

      await service.kycBounced('c1', 'p1', 'REJECTED', 'bad');

      expect(notifications.enqueue).not.toHaveBeenCalled();
      expect(prisma.salesUserAssignment.findFirst).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when there is no active assignment', async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', name: 'Acme Store' });
      prisma.salesUserAssignment.findFirst.mockResolvedValue(null);

      await service.kycBounced('c1', 'p1', 'REJECTED', 'bad');

      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('swallows a thrown outlet.findFirst (fire-and-forget) and resolves', async () => {
      prisma.outlet.findFirst.mockRejectedValue(new Error('db down'));

      await expect(
        service.kycBounced('c1', 'p1', 'REJECTED', 'bad'),
      ).resolves.toBeUndefined();
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });
  });

  /* ── Event 4: targetsUploaded ──────────────────────────────────────────── */

  describe('targetsUploaded', () => {
    it('does NOT enqueue for an empty outlet set', async () => {
      await service.targetsUploaded('c1', []);
      expect(notifications.enqueue).not.toHaveBeenCalled();
      expect(prisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
    });

    it('enqueues exactly twice (deduped XSR + SO) for two outlets covered by the same rep', async () => {
      // Two outlets, both assigned to the same XSR s1/u1.
      prisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUser: { id: 's1', userId: 'u1' } },
        { salesUser: { id: 's1', userId: 'u1' } },
      ]);
      // tenantNodes (call 1) + id->userId map (call 2). Superset rows satisfy both selects.
      prisma.salesUser.findMany.mockResolvedValue([
        { id: 's1', reportingToId: 'm1', isActive: true, userId: 'u1' },
        { id: 'm1', reportingToId: null, isActive: true, userId: 'mu1' },
      ]);

      await service.targetsUploaded('c1', ['o1', 'o2']);

      // u1 (the XSR, deduped from 2 outlets) + mu1 (the SO) = 2 pushes, NOT 4.
      expect(notifications.enqueue).toHaveBeenCalledTimes(2);
      const recipients = notifications.enqueue.mock.calls.map((c) => c[0].userId).sort();
      expect(recipients).toEqual(['mu1', 'u1']);
      notifications.enqueue.mock.calls.forEach(([arg]) => {
        expect(arg).toMatchObject({ channel: 'PUSH', subject: 'New targets uploaded' });
        expect(arg.variables).toEqual({ url: '/sales/dashboard' });
      });
    });

    it('does NOT enqueue when no assignments are found', async () => {
      prisma.salesUserAssignment.findMany.mockResolvedValue([]);

      await service.targetsUploaded('c1', ['o1']);

      expect(notifications.enqueue).not.toHaveBeenCalled();
      expect(prisma.salesUser.findMany).not.toHaveBeenCalled();
    });

    it('swallows a thrown assignment.findMany and resolves', async () => {
      prisma.salesUserAssignment.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.targetsUploaded('c1', ['o1'])).resolves.toBeUndefined();
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });
  });
});
