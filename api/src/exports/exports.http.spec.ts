import { BadRequestException, Controller, Get, INestApplication, Query, Res, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { CurrentUser, type JwtPayload } from '../common/decorators/current-user.decorator';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import { ExportAccessChecker } from './export-access';
import type { AnyExportKind } from './export-kinds';
import { EXPORT_KIND_REGISTRY } from './exports-processor.service';
import { ExportsRunnerService } from './exports-runner.service';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Through the REAL Nest HTTP stack (global TransformInterceptor + AllExceptionsFilter): the report-endpoint pattern
 * `@Res({ passthrough: true })` + `respond(...)` gives a raw xlsx (not JSON-wrapped) for light requests and a 202
 * `{ success, data: { exportRequestId, message } }` for heavy ones; errors keep the `{ success:false }` envelope.
 */
const kind: AnyExportKind = {
  kind: 'demo',
  label: 'Demo',
  access: { roles: ['CLIENT_ADMIN'], permission: 'reports:export' },
  parseParams: (raw) => {
    const r = raw as Record<string, unknown>;
    if (r.months !== undefined && !/^\d+$/.test(String(r.months))) throw new BadRequestException('Months must be a number.');
    return { months: Number(r.months ?? 1), requestOrigin: r.requestOrigin };
  },
  isHeavy: (p: { months: number }) => p.months > 3,
  describeParams: (p: { months: number }) => `${p.months} months`,
  fileName: () => 'demo.xlsx',
  run: async (_c, _p, out) => {
    const s = await out.addSheet('Demo', ['A', 'B']);
    await s.addRow(['x', 1]);
    return { rowCount: 1 };
  },
};

@Controller('admin/reports')
class DemoReportController {
  constructor(private readonly exports: ExportsService) {}
  @Get('demo')
  demo(@CurrentUser() user: JwtPayload, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    return this.exports.respond(res, user, 'demo', q);
  }
}

const ROLE_HEADER = 'x-test-role';
class FakeAuth implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'u1', role: req.headers[ROLE_HEADER] ?? 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' };
    return true;
  }
}

/** One Nest app per file (beforeAll); each test is a few real HTTP round trips — explicit headroom for a loaded full-suite run. */
const HTTP_TIMEOUT = 30_000;

describe('Downloads — HTTP contract through the Nest stack', () => {
  let app: INestApplication;
  const created: unknown[] = [];

  beforeAll(async () => {
    const prisma = {
      $transaction: async (cb: (tx: unknown) => unknown) => cb(prisma),
      $queryRaw: async () => [],
      exportRequest: {
        count: async () => 0,
        create: async ({ data }: { data: unknown }) => {
          created.push(data);
          return { id: 'exp-http-1' };
        },
        findMany: async () => [],
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoReportController, ExportsController],
      providers: [
        ExportsService,
        ExportAccessChecker,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: ExportsRunnerService, useValue: { isConfigured: () => true, kick: async () => 'job' } },
        { provide: GifsyRoleService, useValue: { getPermissions: async () => new Set() } },
        { provide: TenantService, useValue: { isFeatureEnabled: async () => false } },
        { provide: EXPORT_KIND_REGISTRY, useValue: new Map([[kind.kind, kind]]) },
        { provide: APP_GUARD, useClass: FakeAuth },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, HTTP_TIMEOUT);
  afterAll(async () => app?.close(), HTTP_TIMEOUT);

  it('light → 200 raw xlsx attachment (not JSON-wrapped)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/demo?months=2')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('demo.xlsx');
    const rows = XLSX.utils.sheet_to_json(XLSX.read(res.body as Buffer, { type: 'buffer' }).Sheets.Demo, { header: 1 });
    expect(rows).toEqual([['A', 'B'], ['x', 1]]);
  }, HTTP_TIMEOUT);

  it('heavy → 202 { success, data: { exportRequestId, message } }', async () => {
    const res = await request(app.getHttpServer()).get('/admin/reports/demo?months=6');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      data: { exportRequestId: 'exp-http-1', message: expect.stringContaining('Downloads') },
    });
  }, HTTP_TIMEOUT);

  it('generic POST admin/exports → 202; bad body → 400; wrong role → 403 (envelope kept)', async () => {
    const ok = await request(app.getHttpServer()).post('/admin/exports').send({ kind: 'demo', params: { months: '12' } });
    expect(ok.status).toBe(202);
    expect(ok.body.data.exportRequestId).toBe('exp-http-1');
    const bad = await request(app.getHttpServer()).post('/admin/exports').send({ params: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
    const badParams = await request(app.getHttpServer()).get('/admin/reports/demo?months=x');
    expect(badParams.status).toBe(400);
    const forbidden = await request(app.getHttpServer()).get('/admin/reports/demo').set(ROLE_HEADER, 'SALES_USER');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.success).toBe(false);
  }, HTTP_TIMEOUT);

  it('server-set requestOrigin comes from the forwarded host on BOTH the report endpoint and the generic POST', async () => {
    created.length = 0;
    await request(app.getHttpServer())
      .post('/admin/exports')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'api.gifsy.in')
      .send({ kind: 'demo', params: { months: '12', requestOrigin: 'https://evil.example' } });
    await request(app.getHttpServer())
      .get('/admin/reports/demo?months=6&requestOrigin=https://evil.example')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'api-staging.gifsy.in');
    expect(created.map((d) => (d as { params: { requestOrigin: string } }).params.requestOrigin)).toEqual([
      'https://api.gifsy.in',
      'https://api-staging.gifsy.in',
    ]);
  }, HTTP_TIMEOUT);

  it('GET admin/exports → own list envelope', async () => {
    const res = await request(app.getHttpServer()).get('/admin/exports');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { items: [], nextCursor: null } });
  }, HTTP_TIMEOUT);
});
