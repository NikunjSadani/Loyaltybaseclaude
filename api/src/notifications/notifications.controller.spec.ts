import { NotificationsController } from './notifications.controller';
import { JwtPayload } from '../common/decorators/current-user.decorator';

/**
 * NotificationsController — thin JWT-scoped feed API. Every route MUST scope to the
 * authenticated user's `sub` (never a body/param userId), which is the ownership
 * guarantee: a caller can only ever reach their own rows. These tests assert that
 * wiring — the controller forwards `user.sub` and the query params to the service.
 */
describe('NotificationsController', () => {
  const userA: JwtPayload = { sub: 'userA', role: 'PARTNER', clientId: 'c1', phone: '', name: '' };
  const userB: JwtPayload = { sub: 'userB', role: 'PARTNER', clientId: 'c1', phone: '', name: '' };

  let service: {
    listFeed: jest.Mock;
    unreadCount: jest.Mock;
    markRead: jest.Mock;
    markAllRead: jest.Mock;
  };
  let controller: NotificationsController;

  beforeEach(() => {
    service = {
      listFeed: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      unreadCount: jest.fn().mockResolvedValue({ count: 0 }),
      markRead: jest.fn().mockResolvedValue({ id: 'x', readAt: new Date() }),
      markAllRead: jest.fn().mockResolvedValue({ updated: 0 }),
    };
    controller = new NotificationsController(service as any);
  });

  describe('GET /notifications', () => {
    it('scopes the feed to the caller and passes cursor + limit', async () => {
      await controller.list(userA, { cursor: 'cur', limit: 10 });
      expect(service.listFeed).toHaveBeenCalledWith('userA', 'cur', 10);
    });

    it('defaults limit to 25 when omitted', async () => {
      await controller.list(userA, {});
      expect(service.listFeed).toHaveBeenCalledWith('userA', undefined, 25);
    });

    it('uses the JWT sub even for a different user (isolation)', async () => {
      await controller.list(userB, {});
      expect(service.listFeed).toHaveBeenCalledWith('userB', undefined, 25);
    });
  });

  describe('GET /notifications/unread-count', () => {
    it('scopes the count to the caller', async () => {
      await controller.unreadCount(userA);
      expect(service.unreadCount).toHaveBeenCalledWith('userA');
    });
  });

  describe('POST /notifications/:id/read', () => {
    it('marks read scoped to the caller (ownership enforced in the service)', async () => {
      await controller.markRead(userA, 'n1');
      expect(service.markRead).toHaveBeenCalledWith('userA', 'n1');
    });
  });

  describe('POST /notifications/read-all', () => {
    it('marks all read scoped to the caller', async () => {
      await controller.markAllRead(userA);
      expect(service.markAllRead).toHaveBeenCalledWith('userA');
    });
  });
});
