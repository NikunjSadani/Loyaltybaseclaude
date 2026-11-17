/**
 * EVERY registered export kind (both batches) through the REAL queued round trip:
 *   ExportsService.request (API: validate + store)  →  Postgres JSON (JSON round trip)  →
 *   ExportsProcessorService.processClaimed (worker: reload + parse + run)  →  READY,
 * plus the Downloads-page summary of the stored row.
 *
 * Regression guard for the "params parsed twice" defect: the API used to store PARSED params and the worker parsed them
 * AGAIN with strict DTOs (unknown fields refused), so delivery-status (`platformWide`), target-vs-sales (`months[]`)
 * and targets-template (`monthsRaw` / array `months`) ALWAYS failed once queued. Params are now stored RAW and parsed
 * exactly once on each side. A NEW kind without cases here fails the coverage test below — add realistic params for
 * it (incl. the screen's default request) when you register it.
 */
import type { ModuleRef } from '@nestjs/core';
import type { ExportRequest } from '@prisma/client';
import type { Readable } from 'node:stream';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import type { GifsyRoleService } from '../../common/rbac/gifsy-role.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StorageService } from '../../storage/storage.service';
import type { TenantService } from '../../tenant/tenant.service';
import { ExportAccessChecker } from '../export-access';
import type { AnyExportKind } from '../export-kinds';
import { userFromActor } from '../exports-actor';
import { ExportsProcessorService } from '../exports-processor.service';
import type { ExportsRunnerService } from '../exports-runner.service';
import { ExportsService, storedParams } from '../exports.service';
import { EXPORT_KINDS } from './index';

const OWNER_HOME: JwtPayload = { sub: 'u-owner', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Owner' }; // un-assumed = all tenants
const OWNER_ASSUMED: JwtPayload = { ...OWNER_HOME, clientId: 'bajaj', assumed: true };
const CLIENT_ADMIN: JwtPayload = { sub: 'u-ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'Admin' };
const MIS: JwtPayload = { sub: 'u-mis', role: 'MIS_USER', clientId: 'bajaj', phone: '', name: 'Mis' };
const USERS = [OWNER_HOME, OWNER_ASSUMED, CLIENT_ADMIN, MIS];

/** Realistic raw params per kind, as the screens / query strings send them (strings), incl. each screen's default. */
const CASES: Record<string, Array<Record<string, unknown>>> = {
  'outlet-master': [{}],
  'visibility-captures': [{}, { windowKey: '2026-W45' }, { windowKey: '  ' }],
  'visibility-status': [{}, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { dateFrom: '2026-01-01' }],
  'kyc-review-dump': [{}],
  'kyc-rejected': [{}],
  'kyc-status': [{}, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }],
  'target-vs-sales': [
    { fromMonth: '2026-01', toMonth: '2026-06' },
    { fromMonth: '2025-11', toMonth: '2026-10' },
    { fromMonth: '2026-10', toMonth: '2026-10' },
  ],
  'targets-template': [{ months: '2026-07,2026-08,2026-09,2026-10,2026-11' }, { months: '2026-11' }],
  'achievements-template': [{ month: '2026-10' }],
  'targets-export': [{ month: '2026-10' }],
  'achievements-export': [{ month: '2026-10' }],
  'tds-payouts': [{}, { period: '2026-10' }, { clientId: 'bajaj', period: '2026-10' }],
  'payments-report': [{}, { status: 'FAILED', from: '2026-10-01', to: '2026-10-31' }, { clientId: 'bajaj' }],
  'delivery-status': [{}, { channel: 'SMS', from: '2026-10-01', to: '2026-11-14' }, { event: 'OTP_LOGIN' }],
  'points-credit-upload': [{ period: '2026-10' }, { period: '2026-10', program: 'Gold', kpiCode: 'TOTAL' }],
  'points-preview-report': [{ period: '2026-10' }],
  'points-payout-report': [{ period: '2026-10', program: 'Silver' }],
  'app-installed-users': [{}, { roleGroup: 'partner' }, { roleGroup: 'sales', since: '2026-11-01' }],
  'billing-progress-outlets': [
    { bucket: 'BEHIND_PACE' },
    { bucket: 'P0_20', month: '2026-10', program: 'Gold', outletType: 'RETAIL', managerId: 'su-1' },
    { bucket: 'NO_TARGET', month: '2026-11', program: '' },
  ],
  'billing-comparison-slower': [
    {},
    { month: '2026-10', program: 'Gold', outletType: 'RETAIL', managerId: 'su-1' },
    { month: '2026-11', program: '' },
  ],
};

const REQ = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'bajajloyalty.gifsy.in' } };

function harness(def: AnyExportKind) {
  const run = jest.fn(async (_ctx: unknown, _p: unknown, out: { addSheet: (n: string, h: string[]) => Promise<unknown> }) => {
    await out.addSheet('S', ['A']);
    return { rowCount: 0 };
  });
  const kind: AnyExportKind = { ...def, run }; // real parse / isHeavy / describe / fileName; the DB work stubbed
  const registry = new Map([[kind.kind, kind]]);
  const rows: ExportRequest[] = [];
  const prisma = {
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    exportRequest: {
      findMany: jest.fn(async () => rows),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // Postgres JSON columns: exactly what JSON round-trips.
        const now = new Date();
        rows.push({
          id: `r${rows.length}`,
          clientId: data.clientId as string,
          requestedById: data.requestedById as string,
          kind: data.kind as string,
          params: JSON.parse(JSON.stringify(data.params)),
          actor: JSON.parse(JSON.stringify(data.actor)),
          status: 'QUEUED',
          fileName: null,
          storagePath: null,
          sizeBytes: null,
          rowCount: null,
          error: null,
          attempts: 0,
          claimToken: null,
          heartbeatAt: null,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          expiresAt: null,
          updatedAt: now,
        });
        return { id: rows[rows.length - 1].id };
      }),
      updateMany: jest.fn(async (_a: { data: Record<string, unknown> }) => ({ count: 1 })),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const storage = {
    uploadStream: jest.fn(async (_k: string, source: Readable) => {
      for await (const _c of source) void _c;
      return 'gs://x';
    }),
    deleteFile: jest.fn(async () => undefined),
  };
  const processor = new ExportsProcessorService(prisma as unknown as PrismaService, storage as unknown as StorageService, {} as ModuleRef, registry);
  const access = new ExportAccessChecker(
    { getPermissions: async () => new Set() } as unknown as GifsyRoleService,
    { isFeatureEnabled: async () => false } as unknown as TenantService,
  );
  const svc = new ExportsService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    {} as ModuleRef,
    access,
    { isConfigured: () => true, kick: async () => 'job' } as unknown as ExportsRunnerService,
    registry,
    processor,
  );
  return { svc, processor, prisma, rows, run, access, kind };
}

describe('export kinds — queued round trip (store RAW → reload → parse once → run)', () => {
  beforeAll(() => {
    delete process.env.RBAC_ENFORCEMENT;
  });

  it('every registered kind (both batches) has round-trip cases', () => {
    expect([...EXPORT_KINDS.keys()].filter((k) => !CASES[k])).toEqual([]);
  });

  for (const [kindId, cases] of Object.entries(CASES)) {
    for (const raw of cases) {
      it(`${kindId} ${JSON.stringify(raw)} → queued, the worker parses the stored params and the file is READY`, async () => {
        const def = EXPORT_KINDS.get(kindId);
        expect(def).toBeDefined();
        let exercised = 0;
        for (const user of USERS) {
          const h = harness(def!);
          if (!(await h.access.allowed(user, def!.access))) continue;
          // The API-side parse of exactly what gets stored (what isHeavy / validation saw).
          let apiParsed: unknown;
          try {
            apiParsed = def!.parseParams(storedParams(raw, REQ), user);
          } catch {
            continue; // not a valid request for this user (e.g. a tenant-only report for the all-tenant owner)
          }
          exercised++;
          const queued = await h.svc.request(user, kindId, raw, REQ);
          expect(queued.exportRequestId).toBe('r0');
          const stored = h.rows[0];
          expect(stored.params).toEqual(storedParams(raw, REQ)); // RAW + server origin, never the parsed shape

          // Worker: claim → process.
          const claimed = { ...stored, status: 'RUNNING', claimToken: 'tok', attempts: 1 } as ExportRequest;
          await expect(h.processor.processClaimed(claimed)).resolves.toBe('finished');
          const finish = h.prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data;
          expect(finish.status).toBe('READY');
          expect(h.run).toHaveBeenCalledTimes(1);
          expect(h.run.mock.calls[0][1]).toEqual(apiParsed); // the worker's single parse == the API's
          expect((h.run.mock.calls[0][0] as { user: JwtPayload }).user).toMatchObject(
            userFromActor(user.sub, stored.actor) as unknown as Record<string, unknown>,
          );

          // Downloads page: the summary is built from the stored row (never blank for a valid request).
          const list = await h.svc.list(user);
          expect(list.items[0].paramsSummary).toBe(def!.describeParams(apiParsed));
        }
        expect(exercised).toBeGreaterThan(0);
      });
    }
  }
});
