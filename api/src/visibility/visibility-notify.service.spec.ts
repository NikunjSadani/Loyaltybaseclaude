/**
 * Unit tests for visibility-notify.service.ts — the WEEKLY Visibility (POSM) reminder.
 *
 * Covers pending detection + per-rep aggregation + the notification-eligibility edges:
 *   - an outlet already APPROVED this window is excluded (via the findMany NOT filter);
 *   - a due/rejected outlet notifies its allowed-level assigned rep;
 *   - an assigned rep whose level is NOT in allowedSalesLevels is skipped for push;
 *   - an outlet with no active assignment is skipped for push (still counts as pending);
 *   - per-rep aggregation → ONE push per rep (count = pending outlets for that rep);
 *   - a non-PHOTO_APPROVAL tenant is skipped entirely;
 *   - an empty outlet scope short-circuits (no outlet query).
 *
 * Prisma / Tenant / TenantSettings / Notifications mocked.
 * Run: npx jest src/visibility/visibility-notify.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { VisibilityNotifyService } from './visibility-notify.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';

const mockPrisma = {
  programSetting: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
};
const mockTenant = {
  resolveVisibilityCaptureMode: jest.fn(),
  resolveClient: jest.fn(),
};
const mockSettings = { getEffectiveSettings: jest.fn() };
const mockNotifications = { enqueue: jest.fn() };

const config = {
  outletScope: ['SSS'],
  frequencyPerMonth: 1,
  allowedSalesLevels: ['SO'],
  geoFence: { enabled: true, radiusMeters: 50 },
};

/** An outlet row shaped like the service's findMany select, assigned to a rep of `level`. */
function outletAssignedTo(userId: string | null, level?: string) {
  return {
    id: `o-${userId ?? 'none'}-${Math.random()}`,
    salesAssignments:
      userId === null
        ? []
        : [{ salesUser: { userId, hierarchyLevel: { code: level } } }],
  };
}

describe('VisibilityNotifyService', () => {
  let service: VisibilityNotifyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.programSetting.findMany.mockResolvedValue([{ clientId: 't1' }]);
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
    mockTenant.resolveClient.mockResolvedValue({ branding: { displayName: 'Deoleo' } });
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: config });
    mockNotifications.enqueue.mockResolvedValue({ id: 'q1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityNotifyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get(VisibilityNotifyService);
  });

  it('excludes already-APPROVED-this-window outlets at the query level (NOT filter)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    await service.runWeeklyReminder();
    const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    // Addressable-universe mirror (no isActive; kycIntent OR-wrapped) + scope + NOT approved.
    expect(where).toMatchObject({
      clientId: 't1',
      deletedAt: null,
      deactivatedAt: null,
      outletType: { code: { in: ['SSS'] } },
    });
    expect(where.OR).toEqual([{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }]);
    expect(where.NOT).toEqual({
      visibilityCaptures: { some: { windowKey: expect.any(String), status: 'APPROVED' } },
    });
    expect(where.isActive).toBeUndefined();
  });

  it('notifies the allowed-level assigned rep of a pending (due/rejected) outlet', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletAssignedTo('u1', 'SO')]);
    const res = await service.runWeeklyReminder();

    expect(mockNotifications.enqueue).toHaveBeenCalledTimes(1);
    const arg = mockNotifications.enqueue.mock.calls[0][0];
    expect(arg).toMatchObject({
      userId: 'u1',
      channel: 'PUSH',
      subject: 'Deoleo Visibility',
      variables: { url: '/sales/visibility' },
    });
    expect(arg.body).toContain('1 outlet');
    expect(res).toEqual({ tenants: 1, repsNotified: 1, outletsPending: 1 });
  });

  it('skips (for push) a pending outlet whose assigned rep is NOT an allowed level', async () => {
    // 'XSR' is not in allowedSalesLevels (['SO']) → no natural front-line capturer to push.
    mockPrisma.outlet.findMany.mockResolvedValue([outletAssignedTo('u9', 'XSR')]);
    const res = await service.runWeeklyReminder();

    expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    // Still counted in the coverage gap, but nobody is notified.
    expect(res).toEqual({ tenants: 1, repsNotified: 0, outletsPending: 1 });
  });

  it('skips (for push) a pending outlet with no active assignment (still a pending count)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletAssignedTo(null)]);
    const res = await service.runWeeklyReminder();

    expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    expect(res).toEqual({ tenants: 1, repsNotified: 0, outletsPending: 1 });
  });

  it('L3: never enqueues a push for a rep with a null/empty userId (no enqueuePush(null,…))', async () => {
    // A rep row with a null login (defence-in-depth) must be skipped, not pushed.
    mockPrisma.outlet.findMany.mockResolvedValue([outletAssignedTo(null as unknown as string, 'SO')]);
    // outletAssignedTo(null) yields an empty salesAssignments array, so simulate the
    // other shape too: an assignment present but its salesUser.userId is null.
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o-nulluser', salesAssignments: [{ salesUser: { userId: null, hierarchyLevel: { code: 'SO' } } }] },
    ]);
    const res = await service.runWeeklyReminder();
    expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    expect(res).toEqual({ tenants: 1, repsNotified: 0, outletsPending: 1 });
  });

  it('aggregates per rep: ONE push per rep with the pending-outlet count', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([
      outletAssignedTo('u1', 'SO'),
      outletAssignedTo('u1', 'SO'),
      outletAssignedTo('u2', 'SO'),
    ]);
    const res = await service.runWeeklyReminder();

    expect(mockNotifications.enqueue).toHaveBeenCalledTimes(2); // one per distinct rep
    const byUser = Object.fromEntries(
      mockNotifications.enqueue.mock.calls.map((c) => [c[0].userId, c[0].body]),
    );
    expect(byUser['u1']).toContain('2 outlets'); // aggregated
    expect(byUser['u2']).toContain('1 outlet');
    expect(res).toEqual({ tenants: 1, repsNotified: 2, outletsPending: 3 });
  });

  it('skips a tenant whose capture mode is not PHOTO_APPROVAL (no outlet query, no push)', async () => {
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
    const res = await service.runWeeklyReminder();

    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
    expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    expect(res).toEqual({ tenants: 0, repsNotified: 0, outletsPending: 0 });
  });

  it('short-circuits a tenant with an empty outlet scope (no outlet query)', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({
      visibilityConfig: { ...config, outletScope: [] },
    });
    const res = await service.runWeeklyReminder();

    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
    expect(res).toEqual({ tenants: 1, repsNotified: 0, outletsPending: 0 });
  });

  it('a per-tenant failure is swallowed (never aborts the whole pass)', async () => {
    mockPrisma.programSetting.findMany.mockResolvedValue([{ clientId: 't1' }, { clientId: 't2' }]);
    mockSettings.getEffectiveSettings
      .mockRejectedValueOnce(new Error('boom')) // t1 blows up
      .mockResolvedValueOnce({ visibilityConfig: config }); // t2 ok
    mockPrisma.outlet.findMany.mockResolvedValue([outletAssignedTo('u1', 'SO')]);

    const res = await service.runWeeklyReminder();
    // t1 counted (eligible) but errored → 0 contribution; t2 notified 1.
    expect(res.repsNotified).toBe(1);
    expect(res.outletsPending).toBe(1);
  });

  it('only iterates tenants with visibilityEnabled=true (program_settings filter)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    await service.runWeeklyReminder();
    expect(mockPrisma.programSetting.findMany).toHaveBeenCalledWith({
      where: { settingKey: 'visibilityEnabled', settingValue: { equals: true } },
      select: { clientId: true },
    });
  });
});
