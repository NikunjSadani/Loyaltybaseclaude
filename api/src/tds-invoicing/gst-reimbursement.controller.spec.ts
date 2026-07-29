/**
 * Unit tests for GstReimbursementController — delegation + RBAC wiring (D5).
 * The release screen is GIFSY_ADMIN-only; RolesGuard (global) enforces the @Roles metadata,
 * so a CLIENT_ADMIN is denied (403) before the handler runs. We assert the class carries the
 * GIFSY_ADMIN-only @Roles metadata and that RolesGuard denies a CLIENT_ADMIN against it.
 * Run: npx jest src/tds-invoicing/gst-reimbursement.controller.spec.ts
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GstReimbursementController } from './gst-reimbursement.controller';
import { GstReimbursementService } from './gst-reimbursement.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const svc = { list: jest.fn(), release: jest.fn() };
const GIFSY: JwtPayload = { sub: 'op', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'Op' };

/** Build an ExecutionContext whose handler/class resolve to the given controller class. */
function ctxFor(user: JwtPayload, cls: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => cls,
    getClass: () => cls,
  } as never;
}

describe('GstReimbursementController', () => {
  let controller: GstReimbursementController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new GstReimbursementController(svc as unknown as GstReimbursementService);
  });

  it('is declared GIFSY_ADMIN-only (class @Roles metadata)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, GstReimbursementController);
    expect(roles).toEqual(['GIFSY_ADMIN']);
  });

  it('RolesGuard denies a CLIENT_ADMIN against the GIFSY_ADMIN-only class', () => {
    const guard = new RolesGuard(new Reflector());
    const clientAdmin: JwtPayload = { ...GIFSY, role: 'CLIENT_ADMIN', clientId: 'deoleo' };
    expect(() => guard.canActivate(ctxFor(clientAdmin, GstReimbursementController))).toThrow(
      ForbiddenException,
    );
  });

  it('delegates list + release to the service (un-assumed GIFSY honours ?clientId=)', async () => {
    svc.list.mockResolvedValue({ count: 0 });
    svc.release.mockResolvedValue({ status: 'RELEASED' });
    await controller.list(GIFSY, { status: 'HELD', clientId: 'clientb' } as never);
    await controller.release(GIFSY, 'r1', { proofUrl: 'u', releasePayoutRef: 'x' });
    expect(svc.list).toHaveBeenCalledWith({ status: 'HELD', clientId: 'clientb' });
    expect(svc.release).toHaveBeenCalledWith(GIFSY, 'r1', { proofUrl: 'u', releasePayoutRef: 'x' });
  });

  it('an ASSUMED operator is pinned to their assumed tenant — ?clientId= is ignored', async () => {
    svc.list.mockResolvedValue({ count: 0 });
    const assumed: JwtPayload = { ...GIFSY, clientId: 'deoleo', assumed: true };
    await controller.list(assumed, { status: 'HELD', clientId: 'clientb' } as never);
    expect(svc.list).toHaveBeenCalledWith({ status: 'HELD', clientId: 'deoleo' });
  });
});
