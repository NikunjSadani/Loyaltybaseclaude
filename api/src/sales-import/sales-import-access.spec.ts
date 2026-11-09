import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { assertSalesImportAccess, isSalesImportEnabledUncached } from './sales-import-access';

const user = (over: Partial<JwtPayload> = {}): JwtPayload =>
  ({ sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'tenant-a', phone: '9', name: 'A', ...over }) as JwtPayload;

function deps(opts: { cached?: Record<string, unknown> | Error; row?: unknown | Error } = {}) {
  const resolveClient = jest.fn(async () => {
    if (opts.cached instanceof Error) throw opts.cached;
    return { features: opts.cached ?? {} } as never;
  });
  const findUnique = jest.fn(async () => {
    if (opts.row instanceof Error) throw opts.row;
    return opts.row ?? null;
  });
  return { tenant: { resolveClient }, prisma: { client: { findUnique } } as never, resolveClient, findUnique };
}

describe('assertSalesImportAccess', () => {
  it('un-assumed GIFSY_ADMIN → 400, before any flag read', async () => {
    const d = deps({ cached: { salesImport: true } });
    await expect(assertSalesImportAccess(user({ role: 'GIFSY_ADMIN', clientId: 'gifsy' }), d, { write: false }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(d.resolveClient).not.toHaveBeenCalled();
    expect(d.findUnique).not.toHaveBeenCalled();
  });

  it('un-assumed GIFSY_STAFF → 400', async () => {
    await expect(assertSalesImportAccess(user({ role: 'GIFSY_STAFF', clientId: 'gifsy' }), deps(), { write: true }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('flag absent (Deoleo) → 403 on read and on write', async () => {
    await expect(assertSalesImportAccess(user(), deps({ cached: {} }), { write: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      assertSalesImportAccess(user(), deps({ row: { status: 'ACTIVE', features: { walletModule: true } } }), { write: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('flag truthy-but-not-true ("yes") → 403', async () => {
    await expect(assertSalesImportAccess(user(), deps({ cached: { salesImport: 'yes' } }), { write: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CLIENT_ADMIN + flag on → ok (read uses the cached config, write the uncached row)', async () => {
    const r = deps({ cached: { salesImport: true } });
    await expect(assertSalesImportAccess(user(), r, { write: false })).resolves.toBeUndefined();
    expect(r.resolveClient).toHaveBeenCalledWith('tenant-a');
    expect(r.findUnique).not.toHaveBeenCalled();

    const w = deps({ row: { status: 'ACTIVE', features: { salesImport: true } } });
    await expect(assertSalesImportAccess(user(), w, { write: true })).resolves.toBeUndefined();
    expect(w.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'tenant-a' } }));
    expect(w.resolveClient).not.toHaveBeenCalled();
  });

  it('write ignores a STALE cached ON: the uncached row says OFF → 403', async () => {
    const d = deps({ cached: { salesImport: true }, row: { status: 'ACTIVE', features: { salesImport: false } } });
    await expect(assertSalesImportAccess(user(), d, { write: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assumed GIFSY_ADMIN + flag on → ok, scoped to the assumed tenant', async () => {
    const d = deps({ row: { status: 'ACTIVE', features: { salesImport: true } } });
    await expect(
      assertSalesImportAccess(user({ role: 'GIFSY_ADMIN', clientId: 'tenant-b', assumed: true }), d, { write: true }),
    ).resolves.toBeUndefined();
    expect(d.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'tenant-b' } }));
  });

  it('read path fails closed when the tenant cannot be resolved', async () => {
    await expect(assertSalesImportAccess(user(), deps({ cached: new Error('db') }), { write: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('isSalesImportEnabledUncached (fail-closed)', () => {
  const p = (row: unknown | Error) => deps({ row }).prisma;
  it.each([
    ['missing row', null, false],
    ['INACTIVE client', { status: 'INACTIVE', features: { salesImport: true } }, false],
    ['features not an object', { status: 'ACTIVE', features: [true] }, false],
    ['flag string', { status: 'ACTIVE', features: { salesImport: 'true' } }, false],
    ['ONBOARDING + flag on', { status: 'ONBOARDING', features: { salesImport: true } }, true],
    ['ACTIVE + flag on', { status: 'ACTIVE', features: { salesImport: true } }, true],
  ])('%s → %p', async (_n, row, expected) => {
    await expect(isSalesImportEnabledUncached(p(row), 'tenant-a')).resolves.toBe(expected);
  });
  it('read error → false', async () => {
    await expect(isSalesImportEnabledUncached(p(new Error('boom')), 'tenant-a')).resolves.toBe(false);
  });
});
