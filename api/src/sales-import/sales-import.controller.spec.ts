import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { SalesImportController } from './sales-import.controller';
import { SalesImportPartGuard } from './sales-import-access';
import { DRAIN_COMBOS_REFRESH_BUDGET_MS, SalesImportDrainController } from './sales-import-drain.controller';

const ADMIN = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'A' };
const UNASSUMED_GIFSY = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'G' };

function make(flag: boolean) {
  const uploads = {
    createUpload: jest.fn().mockResolvedValue({ importId: 'i', partSize: 1, partCount: 1 }),
    putPart: jest.fn().mockResolvedValue({ partsReceived: 1 }),
    complete: jest.fn().mockResolvedValue({}),
    reprocess: jest.fn().mockResolvedValue({}),
    cancel: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({}),
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: jest.fn().mockResolvedValue({}),
    combos: jest.fn().mockResolvedValue({}),
    unmatchedCsv: jest.fn(),
    errorsXlsx: jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), filename: 'e.xlsx' }),
  };
  const prisma = { client: { findUnique: jest.fn().mockResolvedValue({ features: { salesImport: flag }, status: 'ACTIVE' }) } };
  const tenant = { resolveClient: jest.fn().mockResolvedValue({ id: 't1', features: { salesImport: flag } }) };
  const gifsyRoles = { getPermissions: jest.fn().mockResolvedValue(new Set()) };
  const ctrl = new SalesImportController({} as never, tenant as never, prisma as never, uploads as never, gifsyRoles as never);
  return { ctrl, uploads, prisma, tenant, gifsyRoles };
}

describe('SalesImportController', () => {
  it('flag OFF → 403 before any service call (writes read the flag uncached)', async () => {
    const { ctrl, uploads, prisma } = make(false);
    await expect(ctrl.createUpload(ADMIN, { filename: 'a.csv', sizeBytes: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.remove(ADMIN, 'i')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.cancel(ADMIN, 'i')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.client.findUnique).toHaveBeenCalled();
    expect(uploads.createUpload).not.toHaveBeenCalled();
    expect(uploads.remove).not.toHaveBeenCalled();
    expect(uploads.cancel).not.toHaveBeenCalled();
  });

  it('S7: the part route is gated by a GUARD (runs before FileInterceptor buffers the body)', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SalesImportController.prototype.putPart)).toEqual([SalesImportPartGuard]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, SalesImportController.prototype.putPart)).toHaveLength(1);
    const ctx = (user: unknown, id = 'i1') =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user, params: { id } }) }) }) as unknown as ExecutionContext;
    const guard = (flag: boolean, row: { status: string } | null) => {
      const prisma = {
        client: { findUnique: jest.fn().mockResolvedValue({ features: { salesImport: flag }, status: 'ACTIVE' }) },
        salesImport: { findFirst: jest.fn().mockResolvedValue(row) },
      };
      return { g: new SalesImportPartGuard({} as never, prisma as never), prisma };
    };
    await expect(guard(false, { status: 'UPLOADING' }).g.canActivate(ctx(ADMIN))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard(true, { status: 'UPLOADING' }).g.canActivate(ctx(UNASSUMED_GIFSY))).rejects.toBeInstanceOf(BadRequestException);
    await expect(guard(true, null).g.canActivate(ctx(ADMIN))).rejects.toBeInstanceOf(NotFoundException);
    await expect(guard(true, { status: 'QUEUED' }).g.canActivate(ctx(ADMIN))).rejects.toBeInstanceOf(ConflictException);
    const ok = guard(true, { status: 'UPLOADING' });
    await expect(ok.g.canActivate(ctx(ADMIN))).resolves.toBe(true);
    expect(ok.prisma.salesImport.findFirst).toHaveBeenCalledWith({ where: { id: 'i1', clientId: 't1' }, select: { status: true } });
  });

  it('S3: GET :id returns sample rows only to callers holding targets:upload', async () => {
    const saved = process.env.RBAC_ENFORCEMENT;
    try {
      const { ctrl, uploads, gifsyRoles } = make(true);
      process.env.RBAC_ENFORCEMENT = 'false';
      await ctrl.get(ADMIN, 'i1');
      expect(uploads.get).toHaveBeenLastCalledWith(ADMIN, 'i1', { includeSamples: true });
      // a GIFSY_STAFF whose role lacks targets:upload (it reached GET via targets:read)
      gifsyRoles.getPermissions.mockResolvedValue(new Set(['targets:read']));
      const staff = { ...ADMIN, role: 'GIFSY_STAFF', assumed: true };
      await ctrl.get(staff, 'i1');
      expect(uploads.get).toHaveBeenLastCalledWith(staff, 'i1', { includeSamples: false });
    } finally {
      if (saved === undefined) delete process.env.RBAC_ENFORCEMENT;
      else process.env.RBAC_ENFORCEMENT = saved;
    }
  });

  it('un-assumed Gifsy operator → 400', async () => {
    const { ctrl, uploads } = make(true);
    await expect(ctrl.list(UNASSUMED_GIFSY, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(uploads.list).not.toHaveBeenCalled();
  });

  it('flag ON → delegates with the caller (tenant scoping happens in the service by user.clientId)', async () => {
    const { ctrl, uploads } = make(true);
    await ctrl.complete(ADMIN, 'i1');
    expect(uploads.complete).toHaveBeenCalledWith(ADMIN, 'i1');
    await ctrl.combos(ADMIN, 'latest');
    expect(uploads.combos).toHaveBeenCalledWith(ADMIN, 'latest');
    const f = await ctrl.errorsXlsx(ADMIN, 'i1');
    expect(f.getHeaders().disposition).toBe('attachment; filename="e.xlsx"');
  });

  it('every route carries the documented permission and path', () => {
    const proto = SalesImportController.prototype as unknown as Record<string, () => unknown>;
    const route = (m: string) => [Reflect.getMetadata(METHOD_METADATA, proto[m]), Reflect.getMetadata(PATH_METADATA, proto[m]), Reflect.getMetadata(PERMISSION_KEY, proto[m])];
    // RequestMethod: GET=0, POST=1, DELETE=3
    expect(route('createUpload')).toEqual([1, 'uploads', 'targets:upload']);
    expect(route('putPart')).toEqual([1, ':id/parts/:n', 'targets:upload']);
    expect(route('complete')).toEqual([1, ':id/complete', 'targets:upload']);
    expect(route('reprocess')).toEqual([1, ':id/reprocess', 'targets:upload']);
    expect(route('cancel')).toEqual([1, ':id/cancel', 'targets:upload']);
    expect(route('reprocessAsNew')).toEqual([1, ':id/reprocess-as-new', 'targets:upload']);
    expect(route('remove')).toEqual([3, ':id', 'targets:upload']);
    expect(route('list')).toEqual([0, '/', 'targets:read']);
    expect(route('get')).toEqual([0, ':id', 'targets:read']);
    expect(route('combos')).toEqual([0, ':id/combos', 'targets:read']);
    expect(route('unmatchedCsv')).toEqual([0, ':id/unmatched.csv', 'targets:read']);
    expect(route('errorsXlsx')).toEqual([0, ':id/errors.xlsx', 'targets:read']);
  });

  it('GET :id is declared after the static two-segment GETs', () => {
    const names = Object.getOwnPropertyNames(SalesImportController.prototype);
    expect(names.indexOf('get')).toBeGreaterThan(names.indexOf('combos'));
    expect(names.indexOf('get')).toBeGreaterThan(names.indexOf('errorsXlsx'));
  });
});

describe('SalesImportDrainController', () => {
  const saved = process.env.SALES_IMPORT_DRAIN_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.SALES_IMPORT_DRAIN_SECRET;
    else process.env.SALES_IMPORT_DRAIN_SECRET = saved;
  });
  const make = (claimable: number, kick: string) => {
    const runner = { kick: jest.fn().mockResolvedValue(kick) };
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ n: claimable }]) };
    const retention = { sweep: jest.fn().mockResolvedValue({ abandoned: 0, purged: 0 }), refreshHistoryCombos: jest.fn().mockResolvedValue({}) };
    return { ctrl: new SalesImportDrainController(runner as never, prisma as never, retention as never), runner, retention };
  };

  it('fail-closed: no configured secret → 403 even with a header', async () => {
    delete process.env.SALES_IMPORT_DRAIN_SECRET;
    await expect(make(1, 'job').ctrl.drain('anything')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('missing or wrong secret → 403, no kick', async () => {
    process.env.SALES_IMPORT_DRAIN_SECRET = 's3cret\r\n';
    const { ctrl, runner } = make(1, 'job');
    await expect(ctrl.drain(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.drain('s3creX')).rejects.toBeInstanceOf(ForbiddenException);
    expect(runner.kick).not.toHaveBeenCalled();
  });

  it('right secret: kicks only when something is claimable', async () => {
    process.env.SALES_IMPORT_DRAIN_SECRET = 's3cret';
    const idle = make(0, 'job');
    await expect(idle.ctrl.drain('s3cret')).resolves.toEqual({ kicked: false });
    expect(idle.runner.kick).not.toHaveBeenCalled();
    expect(idle.retention.sweep).toHaveBeenCalled(); // S5: an idle drain still runs the retention sweep
    // §10c: and repairs stale combos summaries in the background, with a budget inside the scheduler's deadline
    expect(idle.retention.refreshHistoryCombos).toHaveBeenCalledWith({ budgetMs: DRAIN_COMBOS_REFRESH_BUDGET_MS });
    const busy = make(2, 'job');
    await expect(busy.ctrl.drain('s3cret')).resolves.toEqual({ kicked: true });
    expect(busy.retention.refreshHistoryCombos).not.toHaveBeenCalled(); // the kicked worker does it
    await expect(make(2, 'none').ctrl.drain('s3cret')).resolves.toEqual({ kicked: false });
  });

  it('is @Public', () => {
    expect(Reflect.getMetadata('isPublic', SalesImportDrainController.prototype.drain)).toBe(true);
  });
});
