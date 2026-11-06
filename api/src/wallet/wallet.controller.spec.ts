// Unit tests for WalletController — the scheduler-driven expiry sweep endpoint.
// Mirrors the push-drain shared-secret pattern: FAIL-CLOSED when EXPIRE_SWEEP_SECRET
// is unset, constant-time secret compare, and a successful sweep delegating to
// WalletService.expireDuePoints(). EXPIRE_SWEEP_SECRET is set/restored per-test.
// Run: npx jest src/wallet/wallet.controller.spec.ts

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { StatementQueryDto } from './dto/wallet.dto';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';

describe('WalletController — statement', () => {
  it('GET statement has the same guards as GET transactions (partner roles + wallet:read)', () => {
    const h = WalletController.prototype.statement;
    expect(Reflect.getMetadata(ROLES_KEY, h)).toEqual(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
    expect(Reflect.getMetadata(ROLES_KEY, h)).toEqual(
      Reflect.getMetadata(ROLES_KEY, WalletController.prototype.listTransactions),
    );
    expect(Reflect.getMetadata(PERMISSION_KEY, h)).toBe('wallet:read');
  });

  it('passes the query and the x-active-partner-id selector through to the service', async () => {
    const statement = jest.fn().mockResolvedValue({ rows: [] });
    const controller = new WalletController({ statement } as unknown as WalletService);
    const user = { sub: 'u1', clientId: 'c1' } as JwtPayload;
    await controller.statement(user, { from: '2026-04', to: '2026-06' }, 'sib1');
    expect(statement).toHaveBeenCalledWith(user, { from: '2026-04', to: '2026-06' }, 'sib1');
  });

  describe('StatementQueryDto', () => {
    const errs = async (input: Record<string, unknown>) =>
      (await validate(plainToInstance(StatementQueryDto, input))).map((e) => e.property);

    it('accepts no params and a valid YYYY-MM pair', async () => {
      expect(await errs({})).toEqual([]);
      expect(await errs({ from: '2026-04', to: '2026-12' })).toEqual([]);
    });

    it.each(['2026-4', '2026-13', '2026-00', '26-04', '2026-04-01', 'abc'])(
      'rejects the malformed month %s',
      async (bad) => {
        expect(await errs({ from: bad, to: '2026-04' })).toEqual(['from']);
        expect(await errs({ from: '2026-04', to: bad })).toEqual(['to']);
      },
    );
  });
});

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
