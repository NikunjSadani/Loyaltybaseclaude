import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PATH_METADATA } from '@nestjs/common/constants';
import { SalesImportModule } from './sales-import.module';
import { SalesImportConfigController } from './sales-import-config.controller';
import { SalesImportApplyController } from './sales-import-apply.controller';
import { SalesImportController } from './sales-import.controller';
import { SalesMonthsController } from './sales-months.controller';
import { SalesImportDrainController } from './sales-import-drain.controller';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { StorageService } from '../storage/storage.service';
import { SalesImportProcessorService } from './ingest/sales-import-processor.service';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

/** Stand-ins for the @Global modules the real app provides (TenantModule, StorageModule). */
@Global()
@Module({
  providers: [
    { provide: TenantService, useValue: {} },
    { provide: TenantSettingsService, useValue: {} },
    { provide: StorageService, useValue: {} },
  ],
  exports: [TenantService, TenantSettingsService, StorageService],
})
class FakeGlobalsModule {}

describe('SalesImportModule (Lane-0 skeleton)', () => {
  it('resolves its DI graph (all lane controllers + services)', async () => {
    const mod = await Test.createTestingModule({ imports: [FakeGlobalsModule, SalesImportModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    for (const c of [
      SalesImportConfigController,
      SalesImportApplyController,
      SalesImportController,
      SalesMonthsController,
      SalesImportDrainController,
    ]) {
      expect(mod.get(c)).toBeInstanceOf(c);
    }
    await mod.close();
  });

  it('registers the static-segment controllers BEFORE the `admin/sales-import/:id` controller', () => {
    const controllers: unknown[] = Reflect.getMetadata('controllers', SalesImportModule);
    const at = (c: unknown) => controllers.indexOf(c);
    expect(at(SalesImportConfigController)).toBeGreaterThanOrEqual(0);
    expect(at(SalesImportConfigController)).toBeLessThan(at(SalesImportController));
    expect(at(SalesImportApplyController)).toBeLessThan(at(SalesImportController));
  });

  it('mounts the documented base paths', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SalesImportConfigController)).toBe('admin/sales-import');
    expect(Reflect.getMetadata(PATH_METADATA, SalesImportApplyController)).toBe('admin/sales-import');
    expect(Reflect.getMetadata(PATH_METADATA, SalesImportController)).toBe('admin/sales-import');
    expect(Reflect.getMetadata(PATH_METADATA, SalesMonthsController)).toBe('admin/sales-months');
    expect(Reflect.getMetadata(PATH_METADATA, SalesImportDrainController)).toBe('sales-import');
  });

  it('admin controllers carry the role floor CLIENT_ADMIN + GIFSY_ADMIN', () => {
    for (const c of [SalesImportConfigController, SalesImportApplyController, SalesImportController, SalesMonthsController]) {
      expect(Reflect.getMetadata(ROLES_KEY, c)).toEqual(['CLIENT_ADMIN', 'GIFSY_ADMIN']);
    }
  });

  // Updated by Lane I (the skeleton stubs are now real): nothing queued → the worker claims nothing, and
  // with SALES_IMPORT_RUNNER unset the runner is a no-op that never throws.
  it('is inert when nothing is queued and no runner is configured', async () => {
    const proc = new SalesImportProcessorService({ $queryRaw: jest.fn().mockResolvedValue([]) } as never, {} as never);
    await expect(proc.claimNext()).resolves.toBeNull();
    const saved = process.env.SALES_IMPORT_RUNNER;
    delete process.env.SALES_IMPORT_RUNNER;
    try {
      const runner = new SalesImportRunnerService(proc);
      jest.spyOn((runner as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      await expect(runner.kick()).resolves.toBe('none');
    } finally {
      if (saved !== undefined) process.env.SALES_IMPORT_RUNNER = saved;
    }
  });
});
