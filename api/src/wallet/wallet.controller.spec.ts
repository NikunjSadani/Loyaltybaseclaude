// Unit tests for WalletController — the scheduler-driven expiry sweep endpoint.
// Mirrors the push-drain shared-secret pattern: FAIL-CLOSED when EXPIRE_SWEEP_SECRET
// is unset, constant-time secret compare, and a successful sweep delegating to
// WalletService.expireDuePoints(). EXPIRE_SWEEP_SECRET is set/restored per-test.
// Run: npx jest src/wallet/wallet.controller.spec.ts

import { ForbiddenException } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

describe('WalletController — expireSweep', () => {
  let controller: WalletController;
  const expireDuePoints = jest.fn();
  const wallet = { expireDuePoints } as unknown as WalletService;

  const ORIGINAL = process.env.EXPIRE_SWEEP_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WalletController(wallet);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EXPIRE_SWEEP_SECRET;
    else process.env.EXPIRE_SWEEP_SECRET = ORIGINAL;
  });

  it('fail-closed: missing EXPIRE_SWEEP_SECRET → ForbiddenException, never sweeps', async () => {
    delete process.env.EXPIRE_SWEEP_SECRET;
    await expect(controller.expireSweep('anything')).rejects.toBeInstanceOf(ForbiddenException);
    expect(expireDuePoints).not.toHaveBeenCalled();
  });

  it('wrong secret → ForbiddenException, never sweeps', async () => {
    process.env.EXPIRE_SWEEP_SECRET = 'correct-secret';
    await expect(controller.expireSweep('wrong-secret')).rejects.toBeInstanceOf(ForbiddenException);
    expect(expireDuePoints).not.toHaveBeenCalled();
  });

  it('missing header (undefined) → ForbiddenException, never sweeps', async () => {
    process.env.EXPIRE_SWEEP_SECRET = 'correct-secret';
    await expect(controller.expireSweep(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(expireDuePoints).not.toHaveBeenCalled();
  });

  it('correct secret → calls expireDuePoints and returns { ok: true, ...result }', async () => {
    process.env.EXPIRE_SWEEP_SECRET = 'correct-secret';
    expireDuePoints.mockResolvedValue({ expiredLots: 3, expiredPoints: 450 });
    const res = await controller.expireSweep('correct-secret');
    expect(expireDuePoints).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, expiredLots: 3, expiredPoints: 450 });
  });
});
