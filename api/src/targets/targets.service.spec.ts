/**
 * Unit tests for TargetsService.
 *
 * Covers:
 *   • listKpis — tenant scoping, enabledOnly filter
 *   • upsertKpi — delegates to prisma.kpiDef.upsert with correct clientId
 *   • deleteKpi — throws NotFoundException for cross-tenant ids
 *   • seedDeoleoKpis — seeds 5 defaults; no-op if tenant already has KPIs
 *   • uploadTargets — verbatim write, blank-cell omission, batch tracking
 *   • listBatches — tenant scoped
 *   • listTargets — requires month param
 *   • uploadAchievements — mirrors uploadTargets; blank→omit, 0 verbatim,
 *       unknown outlet rejected, tenant scope, SalesUploadBatch + OutletSalesRecord
 *   • listAchievementBatches — tenant scoped
 *   • listAchievements — requires month param
 *   • getPace — joins target + achievement; divide-by-zero → null
 *
 * All Prisma calls are mocked; the xlsx parse/generate logic is covered
 * separately in targets.helpers.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { TargetsService, targetChangesFor } from './targets.service';
import type { AnyExportKind } from '../exports/export-kinds';
import {
  ACHIEVEMENTS_EXPORT_KIND,
  ACHIEVEMENTS_TEMPLATE_KIND,
  TARGETS_EXPORT_KIND,
  TARGETS_TEMPLATE_KIND,
} from '../exports/kinds/batch2/targets.kinds';
import { ctxFor, renderKind } from '../exports/kinds/batch2/parity.support-spec';
import { PrismaService } from '../prisma/prisma.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  UpsertKpiDefDto,
  ListKpisQueryDto,
  ListBatchesQueryDto,
  ListTargetsQueryDto,
  TemplateQueryDto,
  ListAchievementBatchesQueryDto,
  ListAchievementsQueryDto,
  PaceQueryDto,
} from './dto/targets.dto';

// Template / final-targets / sales-data downloads are export kinds (exports/kinds/batch2/targets.kinds.ts); these
// shims render them exactly as the endpoints do (parseParams → run into the streaming writer) so the tests below keep
// asserting the same queries and cells.
async function dl(kind: AnyExportKind, raw: Record<string, unknown>): Promise<Buffer> {
  return (await renderKind(kind, ctxFor(admin, mockPrisma), kind.parseParams(raw, admin))).buffer;
}
const getTemplateBuffer = (_u: JwtPayload, q: TemplateQueryDto) => dl(TARGETS_TEMPLATE_KIND, { ...q });
const exportTargetsBuffer = (_u: JwtPayload, month: string) => dl(TARGETS_EXPORT_KIND, { month });
const exportAchievementsBuffer = (_u: JwtPayload, month: string) => dl(ACHIEVEMENTS_EXPORT_KIND, { month });
const buildAchievementTemplate = (_u: JwtPayload, month: string) => dl(ACHIEVEMENTS_TEMPLATE_KIND, { month });

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

// The target-upload confirm token is HMAC-signed with the API's JWT_SECRET (required at boot in the app).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-targets-specs';

// Target upload: the apply runs in ONE interactive transaction, so the tx and the top-level client share these fns
// (assertions read one mock whichever client the code used).
const sharedAuditCreate = jest.fn();
const sharedAuditFindFirst = jest.fn();
const sharedTargetFindMany = jest.fn();
const sharedBatchUpdate = jest.fn().mockResolvedValue({});
const sharedBatchFindFirst = jest.fn();
const sharedBatchUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const sharedBatchDeleteMany = jest.fn().mockResolvedValue({ count: 1 });

const mockTx = {
  kpiDef:             { upsert: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  targetUploadBatch:  { create: jest.fn(), update: sharedBatchUpdate, findFirst: sharedBatchFindFirst, updateMany: sharedBatchUpdateMany, deleteMany: sharedBatchDeleteMany },
  outletTarget:       { upsert: jest.fn(), findMany: sharedTargetFindMany },
  salesUploadBatch:   { create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  outletSalesRecord:  { upsert: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $executeRaw:        jest.fn(),
  // APPLIES-TO: upsertKpi writes an AuditLog row (in the same tx) when a KPI's scope changes.
  auditLog:           { create: sharedAuditCreate, findFirst: sharedAuditFindFirst },
};

const mockPrisma = {
  kpiDef: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
  },
  outlet: {
    findMany: jest.fn(),
  },
  // E1 — enabled outlet types for KpiDef.outletType validation.
  outletTypeClientConfig: {
    findMany: jest.fn(),
  },
  // The upload persistence now calls prisma.* DIRECTLY (batch create + chunked
  // $transaction([...upserts])), not tx.* inside an interactive callback — so these
  // reuse the SAME jest.fns as mockTx, letting existing `mockTx.*` assertions and the
  // new direct calls resolve to one mock.
  outletTarget: {
    findMany: sharedTargetFindMany,
    upsert: mockTx.outletTarget.upsert,
  },
  outletSalesRecord: {
    findMany: jest.fn(),
    upsert: mockTx.outletSalesRecord.upsert,
  },
  targetChangeHistory: { findMany: jest.fn(), findFirst: jest.fn() },
  targetUploadBatch: {
    findMany: jest.fn(),
    create: mockTx.targetUploadBatch.create,
    update: sharedBatchUpdate,
    findFirst: sharedBatchFindFirst,
    updateMany: sharedBatchUpdateMany,
    deleteMany: sharedBatchDeleteMany,
  },
  salesUploadBatch: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
    create: mockTx.salesUploadBatch.create,
  },
  // Sales Import ownership (§7.4). Default: the tenant owns NO KPI (Deoleo / every tenant today), so every
  // pre-existing test below exercises the unchanged path. Ownership tests override it explicitly.
  salesKpiDefinition: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  $executeRaw: jest.fn(),
  // Target upload confirm: the acknowledged not-applied categories are audited with the batch row.
  auditLog: { create: sharedAuditCreate, findMany: jest.fn(), findFirst: sharedAuditFindFirst },
  user: { findMany: jest.fn() },
  // Handles BOTH forms: the array form ($transaction([...ops])) used by the chunked
  // upload persistence, and the interactive callback form used by upsertKpi.
  $transaction: jest.fn((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: typeof mockTx) => unknown)(mockTx),
  ),
};

// Private-bucket storage (a confirmed target upload keeps its file).
const mockStorage = {
  generateKey: jest.fn((folder: string, name: string) => `${folder}/2026-11/uuid-${name}`),
  uploadFile: jest.fn().mockResolvedValue('gs://x'),
  openBoundedObject: jest.fn(),
  deleteFile: jest.fn().mockResolvedValue(undefined),
};

// Target writes are MULTI-ROW raw statements on the apply transaction: decode them back into rows.
const sqlStr = (c: unknown[]) => ((c[0] as { strings?: readonly string[] }).strings ?? []).join('?');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function targetInsertCalls(): unknown[][] {
  return mockTx.$executeRaw.mock.calls.filter((c: unknown[]) => /INSERT INTO "outlet_targets"/.test(sqlStr(c)));
}
function writtenTargets(): Array<{ outletCode: string; outletName: string; month: string; targetValues: Record<string, unknown>; batchId: string }> {
  const out: Array<{ outletCode: string; outletName: string; month: string; targetValues: Record<string, unknown>; batchId: string }> = [];
  for (const c of targetInsertCalls()) {
    const v = ((c[0] as { values?: unknown[] }).values ?? []) as unknown[];
    for (let i = 0; i + 6 < v.length; i++) {
      if (typeof v[i] === 'string' && UUID_RE.test(v[i] as string) && typeof v[i + 5] === 'string' && (v[i + 5] as string).startsWith('{')) {
        out.push({ outletCode: v[i + 2] as string, outletName: v[i + 3] as string, month: v[i + 4] as string, targetValues: JSON.parse(v[i + 5] as string), batchId: v[i + 6] as string });
        i += 6;
      }
    }
  }
  return out;
}
function historyInsertCalls(): unknown[][] {
  return mockTx.$executeRaw.mock.calls.filter((c: unknown[]) => /INSERT INTO "target_change_history"/.test(sqlStr(c)));
}
/** Change-history rows decoded from the unnest(...) arrays (ids, outlet, month, kpi, field, old, new, type). */
function historyRows(): Array<{ outletCode: string; month: string; kpiCode: string; field: string; oldValue: unknown; newValue: unknown; changeType: string }> {
  const out: Array<{ outletCode: string; month: string; kpiCode: string; field: string; oldValue: unknown; newValue: unknown; changeType: string }> = [];
  for (const c of historyInsertCalls()) {
    const arrays = (((c[0] as { values?: unknown[] }).values ?? []) as unknown[]).filter(Array.isArray) as unknown[][];
    const [ids, o, m, k, f, ov, nv, ct] = arrays;
    for (let i = 0; i < ids.length; i++) {
      out.push({
        outletCode: o[i] as string, month: m[i] as string, kpiCode: k[i] as string, field: f[i] as string,
        oldValue: ov[i] === null ? null : JSON.parse(ov[i] as string), newValue: nv[i] === null ? null : JSON.parse(nv[i] as string),
        changeType: ct[i] as string,
      });
    }
  }
  return out;
}
const insertOrder = (k: 'first' | 'last') => {
  const calls = mockTx.$executeRaw.mock.calls;
  const idx = calls.map((c: unknown[], i: number) => (/INSERT INTO "outlet_targets"/.test(sqlStr(c)) ? i : -1)).filter((i: number) => i >= 0);
  return mockTx.$executeRaw.mock.invocationCallOrder[k === 'first' ? idx[0] : idx[idx.length - 1]];
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const admin: JwtPayload = {
  sub: 'admin1',
  role: 'CLIENT_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

const kpiRow = {
  id: 'kpi1',
  clientId: 'deoleo',
  code: 'MONTH_TGT',
  label: 'Month Target',
  unit: 'cases',
  isPrimary: true,
  hasNameOverride: false,
  nameOverrideLabel: null,
  order: 1,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const kpiRow2 = {
  id: 'kpi2',
  clientId: 'deoleo',
  code: 'FOCUS_PACK_1',
  label: 'Focus Pack - 1',
  unit: 'cases',
  isPrimary: false,
  hasNameOverride: false,
  nameOverrideLabel: null,
  order: 2,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * A WRITABLE target month, computed RELATIVE to now (the 1st of next month → always strictly in
 * the future → never month-locked, regardless of the calendar date the suite runs on). Hardcoding
 * a fixed month here was date-rot: once that month became the past, the upload month-lock skipped
 * every row and the upload tests failed with 0 upserts. Label format matches the template group
 * header: "<Mon> '<YY> Target" (e.g. "Sep '26 Target").
 */
const WRITABLE_MONTH = (() => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of next month (rolls year in Dec)
  const label = `${first.toLocaleString('en-US', { month: 'short' })} '${String(first.getFullYear()).slice(-2)} Target`;
  const ym = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;
  return { label, ym };
})();

/** Builds an xlsx buffer matching the template layout for tests. */
function buildTestXlsx(dataRows: (string | number | null)[][]): Buffer {
  // Row 1: group headers — a relative writable (future) month so the upload is never locked.
  const row1 = ['', '', '', WRITABLE_MONTH.label, ''];
  // Row 2: col headers
  const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1'];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([row1, row2, ...dataRows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TargetsService', () => {
  let service: TargetsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TargetsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: SalesNotificationsService,
          useValue: {
            outletsAssigned: jest.fn(),
            kycSubmittedForApproval: jest.fn(),
            kycBounced: jest.fn(),
            targetsUploaded: jest.fn(),
          },
        },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    service = module.get(TargetsService);
  });

  // ─── listKpis ──────────────────────────────────────────────────────────────

  describe('listKpis', () => {
    it('scopes query to caller tenant, sorted by order', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      await service.listKpis(admin, {} as ListKpisQueryDto);

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      // Deterministic order: primary tiebreak on `code` so "first primary"
      // can never flip on equal `order`.
      expect(arg.orderBy).toEqual([{ order: 'asc' }, { code: 'asc' }]);
    });

    it('filters to enabled only when enabledOnly=true', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      await service.listKpis(admin, { enabledOnly: 'true' });

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      expect(arg.where.enabled).toBe(true);
    });

    it('does not filter to enabled when enabledOnly is not set', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      await service.listKpis(admin, {} as ListKpisQueryDto);

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      expect(arg.where.enabled).toBeUndefined();
    });

    it('DETERMINISM: orderBy carries a `code` tiebreak so equal-`order` rows never flip', async () => {
      // Two KPIs share order=1; only the `code` tiebreak makes their relative
      // order (and therefore the "first primary" pick) stable across queries.
      const a = { ...kpiRow, id: 'a', code: 'AAA', order: 1, isPrimary: true };
      const b = { ...kpiRow, id: 'b', code: 'BBB', order: 1, isPrimary: true };
      mockPrisma.kpiDef.findMany.mockResolvedValue([a, b]);

      await service.listKpis(admin, {} as ListKpisQueryDto);

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      // The query asks the DB for [order asc, code asc] — the only thing that
      // guarantees "first match wins" is reproducible on equal `order`.
      expect(arg.orderBy).toEqual([{ order: 'asc' }, { code: 'asc' }]);
      expect(arg.orderBy[0]).toEqual({ order: 'asc' });
      expect(arg.orderBy[1]).toEqual({ code: 'asc' });
    });
  });

  // ─── upsertKpi ─────────────────────────────────────────────────────────────

  describe('upsertKpi', () => {
    it('calls tx.kpiDef.upsert with the correct clientId and code (inside a transaction)', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);

      const dto: UpsertKpiDefDto = {
        code: 'MONTH_TGT',
        label: 'Month Target',
        unit: 'cases',
        isPrimary: true,
        hasNameOverride: false,
        order: 1,
        enabled: true,
      };
      await service.upsertKpi(admin, dto);

      // The write runs inside $transaction for atomicity with the demotion.
      expect(mockPrisma.$transaction).toHaveBeenCalled();

      const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId_code: { clientId: 'deoleo', code: 'MONTH_TGT' } });
      expect(arg.create.clientId).toBe('deoleo');
      expect(arg.create.code).toBe('MONTH_TGT');
    });

    it('sets enabled=true by default when not supplied', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);
      const dto: UpsertKpiDefDto = { code: 'NEW_KPI', label: 'New KPI' };
      await service.upsertKpi(admin, dto);

      const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
      expect(arg.create.enabled).toBe(true);
    });

    it('INVARIANT: isPrimary=true demotes every OTHER KPI for the tenant before upserting, in one transaction', async () => {
      mockTx.kpiDef.updateMany.mockResolvedValue({ count: 1 });
      mockTx.kpiDef.upsert.mockResolvedValue({ ...kpiRow, code: 'FOCUS_PACK_1', isPrimary: true });

      const dto: UpsertKpiDefDto = {
        code: 'FOCUS_PACK_1',
        label: 'Focus Pack - 1',
        isPrimary: true,
      };
      await service.upsertKpi(admin, dto);

      // 1) The demotion runs, scoped to the tenant, excluding the incoming code.
      expect(mockTx.kpiDef.updateMany).toHaveBeenCalledTimes(1);
      const demote = mockTx.kpiDef.updateMany.mock.calls[0][0];
      expect(demote.where).toEqual({ clientId: 'deoleo', NOT: { code: 'FOCUS_PACK_1' } });
      expect(demote.data).toEqual({ isPrimary: false });

      // 2) The upsert writes this row as primary — only ONE primary remains.
      const upsertArg = mockTx.kpiDef.upsert.mock.calls[0][0];
      expect(upsertArg.create.isPrimary).toBe(true);
      expect(upsertArg.update.isPrimary).toBe(true);

      // 3) Demotion and upsert share the SAME tx object (atomic).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('does NOT demote other KPIs when isPrimary is false', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue({ ...kpiRow, isPrimary: false });
      const dto: UpsertKpiDefDto = { code: 'CONSISTENCY', label: 'Consistency', isPrimary: false };
      await service.upsertKpi(admin, dto);

      expect(mockTx.kpiDef.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT demote other KPIs when isPrimary is omitted', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);
      const dto: UpsertKpiDefDto = { code: 'CONSISTENCY', label: 'Consistency' };
      await service.upsertKpi(admin, dto);

      expect(mockTx.kpiDef.updateMany).not.toHaveBeenCalled();
    });

    // ── E1: KpiDef.outletType ──
    describe('outletType (E1)', () => {
      beforeEach(() => {
        mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);
        mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
          { outletType: { code: 'SSS' } },
          { outletType: { code: 'WHOLESALER' } },
        ]);
      });

      it('omitted → create null, update leaves the column untouched, no outlet-type lookup', async () => {
        await service.upsertKpi(admin, { code: 'MONTH_TGT', label: 'Month Target' });
        const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
        expect(arg.create.outletType).toBeNull();
        expect(arg.update).not.toHaveProperty('outletType');
        expect(mockPrisma.outletTypeClientConfig.findMany).not.toHaveBeenCalled();
      });

      it('an enabled code (any case) is stored as the canonical code on create + update', async () => {
        await service.upsertKpi(admin, { code: 'RLP_TGT', label: 'RLP Target', outletType: 'sss' });
        const lookup = mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0];
        expect(lookup.where).toEqual({ clientId: 'deoleo', isEnabled: true, outletType: { isActive: true } });
        const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
        expect(arg.create.outletType).toBe('SSS');
        expect(arg.update.outletType).toBe('SSS');
      });

      it('null or blank → SHARED (null) on update, clearing a previous type', async () => {
        await service.upsertKpi(admin, { code: 'RLP_TGT', label: 'RLP Target', outletType: null });
        await service.upsertKpi(admin, { code: 'RLP_TGT', label: 'RLP Target', outletType: '  ' });
        expect(mockTx.kpiDef.upsert.mock.calls[0][0].update.outletType).toBeNull();
        expect(mockTx.kpiDef.upsert.mock.calls[1][0].update.outletType).toBeNull();
        expect(mockPrisma.outletTypeClientConfig.findMany).not.toHaveBeenCalled();
      });

      it('L2: an update re-sending the STORED (now-disabled) outletType is not re-validated and leaves it untouched', async () => {
        mockPrisma.kpiDef.findFirst.mockResolvedValueOnce({ outletType: 'SUB_STOCKIST' });
        await service.upsertKpi(admin, { code: 'OLD_KPI', label: 'Renamed', outletType: 'SUB_STOCKIST' });
        expect(mockPrisma.outletTypeClientConfig.findMany).not.toHaveBeenCalled();
        const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
        expect(arg.update).not.toHaveProperty('outletType');
        expect(arg.update.label).toBe('Renamed');
      });

      it('L2: a CHANGED outletType on update is still validated', async () => {
        mockPrisma.kpiDef.findFirst.mockResolvedValueOnce({ outletType: null });
        await expect(
          service.upsertKpi(admin, { code: 'OLD_KPI', label: 'x', outletType: 'NOPE' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('a code that is not an enabled outlet type of the tenant → 400, nothing written', async () => {
        await expect(
          service.upsertKpi(admin, { code: 'X', label: 'X', outletType: 'RETAILER' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockTx.kpiDef.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });
    });
  });

  // ─── setPrimary ────────────────────────────────────────────────────────────

  describe('setPrimary', () => {
    it('INVARIANT: demotes every OTHER primary (by id) then sets the target one primary, in one transaction', async () => {
      mockTx.kpiDef.findFirst.mockResolvedValue(kpiRow2);
      mockTx.kpiDef.updateMany.mockResolvedValue({ count: 1 });
      mockTx.kpiDef.update.mockResolvedValue({ ...kpiRow2, isPrimary: true });

      await service.setPrimary(admin, 'kpi2');

      // The whole move runs in ONE transaction (atomic).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      // 1) Existence/tenant check on the target KPI.
      const findArg = mockTx.kpiDef.findFirst.mock.calls[0][0];
      expect(findArg.where).toEqual({ id: 'kpi2', clientId: 'deoleo' });

      // 2) Demotion is scoped to the tenant and excludes the target by ID (NOT by code).
      expect(mockTx.kpiDef.updateMany).toHaveBeenCalledTimes(1);
      const demote = mockTx.kpiDef.updateMany.mock.calls[0][0];
      expect(demote.where).toEqual({ clientId: 'deoleo', NOT: { id: 'kpi2' } });
      expect(demote.data).toEqual({ isPrimary: false });

      // 3) The target KPI is set primary.
      const updateArg = mockTx.kpiDef.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'kpi2' });
      expect(updateArg.data).toEqual({ isPrimary: true });
    });

    it('throws NotFoundException for a non-existent / other-tenant KPI and never demotes', async () => {
      mockTx.kpiDef.findFirst.mockResolvedValue(null);

      await expect(service.setPrimary(admin, 'kpi-other')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockTx.kpiDef.updateMany).not.toHaveBeenCalled();
      expect(mockTx.kpiDef.update).not.toHaveBeenCalled();
    });

    it('CONFLICT: a P2002 from the transaction surfaces as ConflictException (409)', async () => {
      mockTx.kpiDef.findFirst.mockResolvedValue(kpiRow2);
      mockTx.kpiDef.updateMany.mockResolvedValue({ count: 1 });
      mockTx.kpiDef.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.setPrimary(admin, 'kpi2')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // ─── deleteKpi ─────────────────────────────────────────────────────────────

  describe('deleteKpi', () => {
    it('deletes the KPI when it belongs to the tenant', async () => {
      mockPrisma.kpiDef.findFirst.mockResolvedValue(kpiRow);
      mockPrisma.kpiDef.delete.mockResolvedValue(kpiRow);

      const result = await service.deleteKpi(admin, 'kpi1');
      expect(result).toEqual({ deleted: 'kpi1' });
    });

    it('throws NotFoundException when the KPI does not exist for the tenant', async () => {
      mockPrisma.kpiDef.findFirst.mockResolvedValue(null);
      await expect(service.deleteKpi(admin, 'kpi-other')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── seedDeoleoKpis ────────────────────────────────────────────────────────

  describe('seedDeoleoKpis', () => {
    it('creates 5 default KPIs when tenant has none', async () => {
      mockPrisma.kpiDef.count.mockResolvedValue(0);
      mockPrisma.kpiDef.createMany.mockResolvedValue({ count: 5 });

      const result = await service.seedDeoleoKpis(admin);
      expect(result.seeded).toBe(5);

      const arg = mockPrisma.kpiDef.createMany.mock.calls[0][0];
      expect(arg.data).toHaveLength(5);
      // All have the tenant's clientId
      for (const row of arg.data) {
        expect(row.clientId).toBe('deoleo');
      }
      // Default KPI codes are present
      const codes = arg.data.map((d: { code: string }) => d.code);
      expect(codes).toContain('MONTH_TGT');
      expect(codes).toContain('FOCUS_PACK_1');
    });

    it('is a no-op when tenant already has KPIs', async () => {
      mockPrisma.kpiDef.count.mockResolvedValue(3);

      const result = await service.seedDeoleoKpis(admin);
      expect(result.seeded).toBe(0);
      expect(result.skippedReason).toContain('3');
      expect(mockPrisma.kpiDef.createMany).not.toHaveBeenCalled();
    });
  });

  // ─── getTemplateBuffer ───────────────────────────────────────────────────────

  describe('getTemplateBuffer', () => {
    const readAoa = (buf: Buffer): (string | number)[][] => {
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { header: 1 }) as (string | number)[][];
    };

    beforeEach(() => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
    });

    it('ROSTER: fetches ALL non-deleted outlets — no isActive filter (any KYC/active state)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
      ]);

      await getTemplateBuffer(admin, { months: '2026-07' } as TemplateQueryDto);

      const arg = mockPrisma.outlet.findMany.mock.calls[0][0];
      // Tenant-scoped + only soft-deleted excluded; NO isActive (approval) gate.
      expect(arg.where).toEqual({ clientId: 'deoleo', deletedAt: null });
      expect('isActive' in arg.where).toBe(false);
    });

    it('REGRESSION: a pending-KYC (isActive:false) outlet appears in the target template roster', async () => {
      // The DB query no longer filters on isActive, so a pending-approval outlet
      // is returned by prisma and MUST show up as a template row.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'PENDING1', name: 'Pending Outlet', outletType: { code: 'RETAIL' } },
      ]);

      const buf = await getTemplateBuffer(admin, {
        months: '2026-07',
      } as TemplateQueryDto);

      const rows = readAoa(buf);
      // Row 0 = month-group header, row 1 = column labels, row 2+ = outlet rows.
      const outletCodes = rows.slice(2).map((r) => r[0]);
      expect(outletCodes).toContain('PENDING1');
    });
  });

  // ─── uploadTargets ─────────────────────────────────────────────────────────

  describe('uploadTargets', () => {
    const mockOutlets = [
      { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
      { outletCode: 'O002', name: 'Outlet Two', outletType: { code: 'HORECA' } },
    ];

    // These tests exercise the shared parse / validate / write path through the DIRECT apply of a tenant outside
    // TargetsService.confirmRequired; the preview → confirm rules (the default for every tenant) are in the
    // 'preview → confirm & apply' block below.
    afterEach(() => jest.restoreAllMocks());
    beforeEach(() => {
      jest.spyOn(TargetsService, 'confirmRequired').mockReturnValue(false);
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outlet.findMany.mockResolvedValue(mockOutlets);
      mockTx.targetUploadBatch.create.mockResolvedValue({
        id: 'batch1',
        clientId: 'deoleo',
        month: '2026-07',
        totalRows: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        status: 'COMPLETED',
      });
      mockTx.outletTarget.upsert.mockResolvedValue({});
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        service.uploadTargets(admin, undefined as unknown as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no enabled KPIs exist', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      await expect(service.uploadTargets(admin, file)).rejects.toThrow(BadRequestException);
    });

    it('writes verbatim values and returns batch summary', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 123.45, 67]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadTargets(admin, file);

      expect(result.batchId).toBe('batch1');
      expect(result.acceptedCount).toBeGreaterThanOrEqual(1);

      // upsert should have been called with verbatim kpiMap (no compute)
      const stored = writtenTargets()[0].targetValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(123.45);
      expect(stored['FOCUS_PACK_1']).toBe(67);
    });

    it('FOCUS-FROM-TARGETS: a tenant without a "from the target file" KPI gets focusCheck {checked:false} only', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      const result = await service.uploadTargets(admin, file);
      expect(result.focusCheck).toEqual({ checked: false, reason: expect.stringMatching(/No Sales Import KPI/), reasonCode: 'NO_TARGET_NAMES_KPI', months: [] });
    });

    it('FOCUS-FROM-TARGETS: the focus check NEVER blocks the upload (a failing check → checked:false, rows still saved)', async () => {
      mockPrisma.salesKpiDefinition.findMany.mockResolvedValueOnce([
        { id: 'd1', clientId: 'deoleo', kpiCode: 'FOCUS_PACK_1', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0, productSource: 'TARGET_NAMES' },
      ]);
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      // the mock Prisma has no sales-import profile / history tables → the check fails internally
      const result = await service.uploadTargets(admin, file);
      expect(result.savedCount).toBe(1);
      expect(writtenTargets()).toHaveLength(1);
      expect(result.focusCheck).toEqual(expect.objectContaining({ checked: false, months: [] }));
    });

    it('CRITICAL: blank cell → key OMITTED — upsert does not store null/0 for blank', async () => {
      // O001: MONTH_TGT=100, FOCUS_PACK_1=blank
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, null]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadTargets(admin, file);

      const stored = writtenTargets()[0].targetValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(100);
      expect('FOCUS_PACK_1' in stored).toBe(false);
    });

    it('rejected outlet row does not write an OutletTarget', async () => {
      // GHOST is not in the outlet roster
      const file = {
        buffer: buildTestXlsx([['GHOST', 'Ghost Outlet', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadTargets(admin, file);

      // No upsert should have been called
      expect(writtenTargets()).toHaveLength(0);
    });

    it('records rejectedCount on the batch', async () => {
      const file = {
        buffer: buildTestXlsx([
          ['O001', 'Outlet One', 'RETAIL', 100, 50],  // accepted
          ['GHOST', 'Ghost', 'RETAIL', 10, 20],         // rejected
        ]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadTargets(admin, file);

      const batchCreate = mockTx.targetUploadBatch.create.mock.calls[0][0];
      expect(batchCreate.data.clientId).toBe('deoleo');
      expect(batchCreate.data.rejectedCount).toBe(1);
      expect(batchCreate.data.acceptedCount).toBe(1);
    });

    it('REGRESSION: a target row for a pending-KYC (isActive:false) outlet is ACCEPTED, not rejected_outlet', async () => {
      // The roster query no longer filters isActive, so a pending outlet is in
      // knownOutletCodes → its uploaded row must be accepted and upserted.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'PENDING1', name: 'Pending Outlet', outletType: { code: 'RETAIL' } },
      ]);
      mockTx.targetUploadBatch.create.mockResolvedValue({
        id: 'batch-pending',
        clientId: 'deoleo',
        month: '2026-07',
        totalRows: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        status: 'COMPLETED',
      });

      const file = {
        buffer: buildTestXlsx([['PENDING1', 'Pending Outlet', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadTargets(admin, file);

      // Accepted rows are counted, not echoed (memory-safety) — PENDING1 is NOT among the rejected rows.
      expect(result.acceptedCount).toBe(1);
      expect(result.problemRows.find((r) => r.outletCode === 'PENDING1')).toBeUndefined();
      expect(result.problemRowCount).toBe(0);
      // And the target is actually written for the pending outlet.
      expect(writtenTargets()).toHaveLength(1);
    });

    it('LOCK: a PAST month is skipped (no upsert) and reported in skippedLockedMonths', async () => {
      // "Jan '20 Target" = 2020-01, strictly in the past → locked, not editable.
      const ws = XLSX.utils.aoa_to_sheet([
        ['', '', '', "Jan '20 Target", ''],
        ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1'],
        ['O001', 'Outlet One', 'RETAIL', 100, 50],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Targets');
      const file = {
        buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
        originalname: 'past.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadTargets(admin, file);

      // Locked month → nothing written, but the row still parses (no error).
      expect(writtenTargets()).toHaveLength(0);
      expect(result.skippedLockedMonths).toContain('2020-01');
      expect(result.writableMonths).not.toContain('2020-01');
    });

    it('SCALE: a large upload is written in ONE interactive transaction (all-or-nothing) with a long timeout', async () => {
      // The roster is every non-deleted outlet (~6.5k on Bajaj). The whole file is written in ONE transaction so a
      // failure can never leave it half-saved; the timeout is raised well above Prisma's 5s default.
      const N = 250;
      const roster = Array.from({ length: N }, (_, i) => ({
        outletCode: `O${String(i).padStart(4, '0')}`,
        name: `Outlet ${i}`,
        outletType: { code: 'RETAIL' },
      }));
      mockPrisma.outlet.findMany.mockResolvedValue(roster);
      mockPrisma.targetUploadBatch.create.mockResolvedValue({
        id: 'batch-big', clientId: 'deoleo', month: '2026-07',
        totalRows: N, acceptedCount: N, rejectedCount: 0, status: 'PENDING',
      });
      const file = {
        buffer: buildTestXlsx(roster.map((o, i) => [o.outletCode, o.name, 'RETAIL', 100 + i, 50 + i])),
        originalname: 'big.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadTargets(admin, file);

      expect(result.acceptedCount).toBe(N);
      expect(result.savedCount).toBe(N);
      expect(writtenTargets()).toHaveLength(N);
      expect(targetInsertCalls()).toHaveLength(1); // 250 rows → ONE multi-row statement (chunks of 500)
      expect(mockPrisma.outletTarget.upsert).not.toHaveBeenCalled();
      const interactive = mockPrisma.$transaction.mock.calls.filter((c) => typeof c[0] === 'function');
      expect(interactive).toHaveLength(1);
      expect(mockPrisma.$transaction.mock.calls.filter((c) => Array.isArray(c[0]))).toHaveLength(0);
      expect(((interactive[0] as unknown[])[1] as { timeout: number }).timeout).toBeGreaterThanOrEqual(60_000);
      // PENDING first; APPLIED inside the transaction.
      expect(mockPrisma.targetUploadBatch.create.mock.calls[0][0].data.status).toBe('PENDING');
      expect(sharedBatchUpdate).toHaveBeenCalledWith({ where: { id: 'batch-big' }, data: { status: 'APPLIED' } });
    });

    // ─── Preview → confirm (owner decision 2026-11-25, ALL tenants) ─────────
    describe('preview → confirm & apply', () => {
      const xfile = (buffer: Buffer) => ({
        buffer,
        originalname: 'targets.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }) as Express.Multer.File;
      type NA = { category: string; count: number; fingerprint: string };
      const acksOf = (p: { notApplied: NA[] }) => p.notApplied.map(({ category, count, fingerprint }) => ({ category, count, fingerprint }));
      const refusals = () =>
        sharedAuditCreate.mock.calls.map((c) => c[0].data).filter((d) => d.entityType === 'TARGET_UPLOAD_REFUSED');
      const uploadAudits = () =>
        sharedAuditCreate.mock.calls.map((c) => c[0].data).filter((d) => d.entityType === 'TARGET_UPLOAD');

      // O001 already has targets for the month (→ overwritten), O002 has none (→ new).
      const stored = [{ outletCode: 'O001', targetValues: { MONTH_TGT: 10, FOCUS_PACK_1: 5 } }];
      beforeEach(() => {
        jest.spyOn(TargetsService, 'confirmRequired').mockReturnValue(true);
        sharedAuditFindFirst.mockReset();
        sharedBatchFindFirst.mockReset();
        sharedBatchUpdate.mockReset().mockResolvedValue({});
        sharedBatchUpdateMany.mockReset().mockResolvedValue({ count: 1 });
        sharedBatchDeleteMany.mockReset().mockResolvedValue({ count: 1 });
        (mockPrisma.targetUploadBatch as unknown as { update: jest.Mock }).update = sharedBatchUpdate;
        sharedTargetFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
          args.select.targetValues ? stored : stored.map((s) => ({ outletCode: s.outletCode })),
        );
        mockTx.targetUploadBatch.create.mockImplementation(async () => ({ id: 'batch1' }));
      });
      afterEach(() => {
        sharedTargetFindMany.mockReset();
        mockTx.targetUploadBatch.create.mockReset();
      });

      const buf = () => buildTestXlsx([
        ['O001', 'Outlet One', 'RETAIL', 100, null],
        ['O002', 'Outlet Two', 'HORECA', 1, 2],
        ['GHOST', 'Ghost', 'RETAIL', 3, 4],
      ]);

      it('PREVIEW writes NOTHING and returns a signed, expiring token + per-category count / fingerprint / samples', async () => {
        const notify = (service as unknown as { salesNotifications: { targetsUploaded: jest.Mock } }).salesNotifications;
        const before = Date.now();
        const r = await service.previewTargetUpload(admin, xfile(buf()));

        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(writtenTargets()).toHaveLength(0);
        expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(notify.targetsUploaded).not.toHaveBeenCalled();
        expect(sharedAuditCreate).not.toHaveBeenCalled();
        expect(mockStorage.uploadFile).not.toHaveBeenCalled();

        expect(r.preview).toBe(true);
        expect(r.previewToken).toMatch(/^[a-f0-9]{64}\.[a-f0-9]{32}\.\d{13}\.[a-f0-9]{64}$/);
        const exp = new Date(r.previewExpiresAt).getTime();
        expect(exp).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
        expect(exp).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);
        expect(r.willSaveCount).toBe(2);
        expect(r.newCount).toBe(1);
        expect(r.overwriteCount).toBe(1);
        expect(r.perMonth).toEqual([{ month: WRITABLE_MONTH.ym, newCount: 1, overwriteCount: 1, unchangedCount: 0 }]);
        expect(r.unchangedCount).toBe(0);
        expect(r.rejectedCount).toBe(1);
        expect(r.problemRows.map((p) => p.outletCode)).toEqual(['GHOST']);
        expect(r.overwriteExamples).toEqual([{
          outletCode: 'O001', outletName: 'Outlet One', month: WRITABLE_MONTH.ym,
          changes: [
            { kpiCode: 'MONTH_TGT', label: 'Month Target', from: 10, to: 100 },
            { kpiCode: 'FOCUS_PACK_1', label: 'Focus Pack - 1', from: 5, to: null },
          ],
        }]);
        expect(r.overwriteExamplesSampled).toBe(1);
        expect(r.notApplied.map((c) => [c.category, c.count, c.sample])).toEqual([
          ['REJECTED_ROWS', 1, ['Row 5 — GHOST']],
          ['OVERWRITE', 1, [`O001 · ${WRITABLE_MONTH.ym}`]],
        ]);
        for (const c of r.notApplied) expect(c.fingerprint).toMatch(/^[a-f0-9]{16}$/);
        expect(sharedTargetFindMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo', month: WRITABLE_MONTH.ym });
      });

      it('CONFIRM applies exactly the previewed write set in ONE transaction; server-generated batch id; PENDING → APPLIED', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });

        expect(r.status).toBe('APPLIED');
        expect(r.savedCount).toBe(p.willSaveCount);
        expect(r.newCount).toBe(p.newCount);
        expect(r.overwriteCount).toBe(p.overwriteCount);
        expect(r.perMonth).toEqual(p.perMonth);
        expect(writtenTargets()).toHaveLength(2);
        expect(r.batchId).toBe('batch1');
        const created = mockTx.targetUploadBatch.create.mock.calls[0][0].data;
        expect(created.id).toBeUndefined(); // the DB generates it — never derived from the client's token
        expect(created.status).toBe('PENDING');
        expect(mockPrisma.$transaction.mock.calls.filter((c) => typeof c[0] === 'function')).toHaveLength(1);
        // the tenant upload lock is taken inside the transaction
        expect(mockTx.$executeRaw.mock.calls.map((c) => (c[0] as { strings: string[] }).strings.join(''))[0]).toMatch(/pg_advisory_xact_lock/);
        expect(sharedBatchUpdate).toHaveBeenCalledWith({ where: { id: 'batch1' }, data: { status: 'APPLIED' } });
        expect(refusals()).toEqual([]);
      });

      it('NO PREVIEW: an upload without a confirm token is REFUSED (400) and audited — nothing written', async () => {
        await expect(service.uploadTargets(admin, xfile(buf()))).rejects.toThrow(/Preview the file first/);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(writtenTargets()).toHaveLength(0);
        expect(refusals()).toEqual([expect.objectContaining({
          action: 'REJECT', entityId: 'no-preview', actorId: 'admin1',
          metadata: expect.objectContaining({ clientId: 'deoleo', reason: 'NO_PREVIEW', status: 400, fileName: 'targets.xlsx' }),
        })]);
      });

      it('TOKEN BINDING: a token issued to another user or another tenant, or tampered with → 400, audited, nothing written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const otherUser = { ...admin, sub: 'admin2' };
        const otherTenant = { ...admin, clientId: 'bajaj' };
        await expect(service.uploadTargets(otherUser, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/not valid for your account/);
        await expect(service.uploadTargets(otherTenant, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(BadRequestException);
        const tampered = p.previewToken.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: tampered, acknowledged: acksOf(p) }))
          .rejects.toThrow(/not valid for your account/);
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: 'nope' })).rejects.toThrow(/not in the expected format.*Nothing was saved/);
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: 'x'.repeat(5000) })).rejects.toThrow(BadRequestException);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(refusals().map((d) => d.metadata.reason)).toEqual(['INVALID_TOKEN', 'INVALID_TOKEN', 'INVALID_TOKEN', 'MALFORMED_TOKEN', 'MALFORMED_TOKEN']);
        expect(refusals()[4].metadata.tokenLength).toBe(5000);
      });

      it('EXPIRED: a preview older than 30 minutes → 410 with a clear message, audited, nothing written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const real = Date.now();
        const spy = jest.spyOn(Date, 'now').mockReturnValue(real + 31 * 60_000);
        try {
          const err = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(GoneException);
          expect((err as Error).message).toMatch(/preview has expired.*30 minutes.*Nothing was saved/);
        } finally {
          spy.mockRestore();
        }
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(refusals()).toEqual([expect.objectContaining({
          entityId: p.previewToken.split('.')[1], metadata: expect.objectContaining({ reason: 'EXPIRED', status: 410 }),
        })]);
      });

      it('a DIFFERENT file than the previewed one → 409, audited, nothing written', async () => {
        const p = await service.previewTargetUpload(admin, xfile(buf()));
        const other = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 999, 999]]);
        await expect(service.uploadTargets(admin, xfile(other), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/not the one you previewed/);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(writtenTargets()).toHaveLength(0);
        expect(refusals().map((d) => d.metadata.reason)).toEqual(['DIFFERENT_FILE']);
      });

      it('ALREADY APPLIED (the token\'s apply committed): 409 says when, nothing written twice, audited', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        sharedAuditFindFirst.mockResolvedValue({ entityId: 'cmbatchapplied01', createdAt: new Date() });
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/already applied on .* IST \(upload pplied01\) — it was not applied again/);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(writtenTargets()).toHaveLength(0);
        // the guard looks for an APPLIED audit row of THIS token nonce in THIS tenant
        expect(sharedAuditFindFirst.mock.calls[0][0].where).toEqual({
          entityType: 'TARGET_UPLOAD',
          AND: [
            { metadata: { path: ['tokenNonce'], equals: p.previewToken.split('.')[1] } },
            { metadata: { path: ['status'], equals: 'APPLIED' } },
            { metadata: { path: ['clientId'], equals: 'deoleo' } },
          ],
        });
        expect(refusals().map((d) => d.metadata.reason)).toEqual(['ALREADY_APPLIED']);
      });

      it('DOUBLE-APPLY RACE: a concurrent apply committed first → rolled back, recorded as a REFUSAL (no failed batch), 409', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        // outside the tx: not applied yet; inside the tx (after the lock): the other request committed
        sharedAuditFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ entityId: 'cmotherbatch0001', createdAt: new Date() });
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(ConflictException);
        expect(writtenTargets()).toHaveLength(0);
        // not a failed upload: no FAILED batch / audit; the attempt's PENDING batch + kept file are removed
        expect(sharedBatchUpdateMany).not.toHaveBeenCalled();
        expect(uploadAudits()).toEqual([]);
        expect(sharedBatchDeleteMany).toHaveBeenCalledWith({ where: { id: 'batch1', status: 'PENDING' } });
        expect(mockStorage.deleteFile).toHaveBeenCalledWith('target-uploads/deoleo/batch1/2026-11/uuid-targets.xlsx');
        expect(refusals()).toEqual([expect.objectContaining({
          metadata: expect.objectContaining({ reason: 'ALREADY_APPLIED', decidedInsideTransaction: true, discardedBatchId: 'batch1' }),
        })]);
      });

      it('RETRY: a failed write saves NOTHING (honest error), records FAILED, and the same preview can be applied again', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        mockPrisma.$transaction.mockImplementationOnce(() => Promise.reject(new Error('db down')));
        sharedBatchFindFirst.mockResolvedValueOnce({ status: 'PENDING' }); // the re-read: rolled back
        const err = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InternalServerErrorException);
        expect((err as Error).message).toMatch(/NOTHING from this file was saved.*Press Confirm & apply again to retry/);
        // FAILED only via a CONDITIONAL update (still PENDING)
        expect(sharedBatchUpdateMany).toHaveBeenCalledWith({ where: { id: 'batch1', status: 'PENDING' }, data: { status: 'FAILED' } });
        expect(uploadAudits()).toEqual([expect.objectContaining({
          metadata: expect.objectContaining({ status: 'FAILED', failureReason: 'WRITE_FAILED', savedCount: 0, error: 'db down' }),
        })]);

        // retry with the SAME token → a fresh batch, applied
        mockTx.targetUploadBatch.create.mockImplementationOnce(async () => ({ id: 'batch2' }));
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(r.batchId).toBe('batch2');
        expect(r.status).toBe('APPLIED');
        expect(writtenTargets()).toHaveLength(2);
        expect(uploadAudits().map((d) => [d.entityId, d.metadata.status])).toEqual([['batch1', 'FAILED'], ['batch2', 'APPLIED']]);
      });

      it('a lost reply after a real commit is reported as APPLIED (the DB is the truth), never as a failure', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        mockPrisma.$transaction.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));
        sharedBatchFindFirst.mockResolvedValueOnce({ status: 'APPLIED' });
        sharedAuditFindFirst.mockResolvedValueOnce(null) // the pre-check: not applied yet
          .mockResolvedValueOnce({ metadata: { newCount: 1, overwriteCount: 1, perMonth: [{ month: WRITABLE_MONTH.ym, newCount: 1, overwriteCount: 1 }] } });
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(r.status).toBe('APPLIED');
        expect(r.newCount).toBe(1);
        expect(sharedBatchUpdateMany).not.toHaveBeenCalled();
      });

      it('ACK BINDING: counts changed since the preview → 412 naming old vs new, audited, NOTHING written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        // O002 got a target from elsewhere in between → 2 overwrites now, the admin confirmed 1.
        sharedTargetFindMany.mockImplementation(async () => [{ outletCode: 'O001' }, { outletCode: 'O002' }]);
        const err = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PreconditionFailedException);
        expect((err as Error).message).toMatch(/existing outlet-month targets that will be replaced: now 2 \(you confirmed 1\)/);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(writtenTargets()).toHaveLength(0);
        expect(refusals().map((d) => d.metadata.reason)).toEqual(['ACK_CHANGED']);
      });

      it('ACK BINDING: same count but DIFFERENT items (another outlet is now the overwrite) → 412', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        sharedTargetFindMany.mockImplementation(async () => [{ outletCode: 'O002' }]);
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/still 1, but not the same ones you confirmed/);
        expect(writtenTargets()).toHaveLength(0);
      });

      it('ACK BINDING: a tick sent with a wrong count (not what was shown) → 412, nothing written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const acks = acksOf(p).map((a) => (a.category === 'REJECTED_ROWS' ? { ...a, count: 0 } : a));
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acks }))
          .rejects.toThrow(PreconditionFailedException);
        expect(writtenTargets()).toHaveLength(0);
      });

      it('ACK ENFORCEMENT: a confirm missing an acknowledgement → 400 naming the missing category, audited, NOTHING written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const err = await service
          .uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p).filter((a) => a.category === 'REJECTED_ROWS') })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as Error).message).toMatch(/1 existing outlet-month targets that will be replaced \(OVERWRITE\)/);
        expect((err as Error).message).not.toMatch(/REJECTED_ROWS/);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(writtenTargets()).toHaveLength(0);
        expect(uploadAudits()).toEqual([]);
        expect(refusals().map((d) => d.metadata.reason)).toEqual(['ACK_MISSING']);
      });

      it('ACK ENFORCEMENT: no acknowledgements at all → 400 naming every present category', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken }))
          .rejects.toThrow(/\(REJECTED_ROWS\).*\(OVERWRITE\)/);
        expect(writtenTargets()).toHaveLength(0);
      });

      it('ACK ENFORCEMENT is checked against the state AT APPLY: a category that appeared since the preview is refused', async () => {
        const b = buildTestXlsx([['O002', 'Outlet Two', 'HORECA', 1, 2]]);
        sharedTargetFindMany.mockImplementation(async () => []);
        const p = await service.previewTargetUpload(admin, xfile(b));
        expect(p.notApplied).toEqual([]);
        sharedTargetFindMany.mockImplementation(async () => [{ outletCode: 'O002' }]);
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: [] }))
          .rejects.toThrow(/\(OVERWRITE\)/);
        expect(writtenTargets()).toHaveLength(0);
      });

      it('the TARGET_UPLOAD audit row is written INSIDE the transaction, once, with what was actually written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const acks = acksOf(p);
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acks });
        expect(uploadAudits()).toHaveLength(1);
        const audit = uploadAudits()[0];
        expect(audit).toEqual(expect.objectContaining({ action: 'CREATE', entityType: 'TARGET_UPLOAD', entityId: r.batchId, actorId: 'admin1' }));
        expect(audit.metadata).toEqual({
          clientId: 'deoleo',
          change: 'target-upload-confirm',
          tokenNonce: p.previewToken.split('.')[1],
          status: 'APPLIED',
          months: [WRITABLE_MONTH.ym],
          skippedLockedMonths: [],
          fileName: 'targets.xlsx',
          fileSize: b.length,
          fileSha256: p.previewToken.split('.')[0],
          fileKey: 'target-uploads/deoleo/batch1/2026-11/uuid-targets.xlsx',
          totalRows: 3,
          acceptedCount: 2,
          rejectedCount: 1,
          savedCount: 2,
          newCount: 1,
          overwriteCount: 1,
          unchangedCount: 0,
          perMonth: [{ month: WRITABLE_MONTH.ym, newCount: 1, overwriteCount: 1, unchangedCount: 0 }],
          historyRowCount: 4,
          acknowledged: acks,
          notApplied: p.notApplied,
        });
        // written after every target, before the transaction returned
        expect(sharedAuditCreate.mock.invocationCallOrder[0])
          .toBeGreaterThan(insertOrder('last'));
        expect(r.notApplied).toEqual(p.notApplied);
        expect(r.acknowledged).toEqual(acks);
      });

      it('TARGET HISTORY: the apply writes one row per value that ACTUALLY changed, in the same transaction', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(historyInsertCalls()).toHaveLength(1);
        // O001: 10 → 100 (UPDATED), Focus 5 → removed (DELETED); O002: two new values (CREATED). GHOST: rejected, nothing.
        expect(historyRows()).toEqual([
          { outletCode: 'O001', month: WRITABLE_MONTH.ym, kpiCode: 'FOCUS_PACK_1', field: 'VALUE', oldValue: 5, newValue: null, changeType: 'DELETED' },
          { outletCode: 'O001', month: WRITABLE_MONTH.ym, kpiCode: 'MONTH_TGT', field: 'VALUE', oldValue: 10, newValue: 100, changeType: 'UPDATED' },
          { outletCode: 'O002', month: WRITABLE_MONTH.ym, kpiCode: 'FOCUS_PACK_1', field: 'VALUE', oldValue: null, newValue: 2, changeType: 'CREATED' },
          { outletCode: 'O002', month: WRITABLE_MONTH.ym, kpiCode: 'MONTH_TGT', field: 'VALUE', oldValue: null, newValue: 1, changeType: 'CREATED' },
        ]);
        const sql = sqlStr(historyInsertCalls()[0]);
        expect(sql).toMatch(/FROM unnest\(/);
        const bound = ((historyInsertCalls()[0][0] as { values: unknown[] }).values);
        expect(bound).toContain('deoleo'); // tenant
        expect(bound).toContain(r.batchId); // upload
        expect(bound).toContain('admin1'); // who
        // written after the targets, inside the transaction (before the audit row)
        expect(mockTx.$executeRaw.mock.invocationCallOrder[mockTx.$executeRaw.mock.calls.indexOf(historyInsertCalls()[0])])
          .toBeGreaterThan(insertOrder('last'));
      });

      it('TARGET HISTORY: re-applying the SAME values logs nothing — and the UNCHANGED outlet-month is not rewritten', async () => {
        const notify = (service as unknown as { salesNotifications: { targetsUploaded: jest.Mock } }).salesNotifications;
        const same = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]]);
        const p = await service.previewTargetUpload(admin, xfile(same));
        // UNCHANGED, not OVERWRITE: nothing to tick, nothing to save.
        expect(p.overwriteCount).toBe(0);
        expect(p.unchangedCount).toBe(1);
        expect(p.unchangedSample).toEqual([`O001 · ${WRITABLE_MONTH.ym}`]);
        expect(p.willSaveCount).toBe(0);
        expect(p.notApplied.find((c) => c.category === 'OVERWRITE')).toBeUndefined();
        const r = await service.uploadTargets(admin, xfile(same), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(writtenTargets()).toHaveLength(0);
        expect(r.savedCount).toBe(0);
        expect(r.unchangedCount).toBe(1);
        expect(notify.targetsUploaded).not.toHaveBeenCalled();
        expect(historyRows()).toEqual([]);
        expect(historyInsertCalls()).toHaveLength(0);
      });

      it('OVERWRITE counts ONLY outlet-months whose values change: 3 stored, 1 changed → OVERWRITE 1 (+ 2 unchanged, untouched)', async () => {
        const notify = (service as unknown as { salesNotifications: { targetsUploaded: jest.Mock } }).salesNotifications;
        sharedTargetFindMany.mockImplementation(async () => [
          { outletCode: 'O001', targetValues: { MONTH_TGT: 10, FOCUS_PACK_1: 5 } },
          { outletCode: 'O002', targetValues: { MONTH_TGT: 20, FOCUS_PACK_1: 6 } },
          { outletCode: 'O003', targetValues: { MONTH_TGT: 30, FOCUS_PACK_1: 7 } },
        ]);
        mockPrisma.outlet.findMany.mockResolvedValue([
          { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
          { outletCode: 'O002', name: 'Outlet Two', outletType: { code: 'HORECA' } },
          { outletCode: 'O003', name: 'Outlet Three', outletType: { code: 'RETAIL' } },
        ]);
        const b = buildTestXlsx([
          ['O001', 'Outlet One', 'RETAIL', 10, 5],
          ['O002', 'Outlet Two', 'HORECA', 25, 6], // the only change
          ['O003', 'Outlet Three', 'RETAIL', 30, 7],
        ]);
        const p = await service.previewTargetUpload(admin, xfile(b));
        expect(p.overwriteCount).toBe(1);
        expect(p.unchangedCount).toBe(2);
        expect(p.willSaveCount).toBe(1);
        expect(p.perMonth).toEqual([{ month: WRITABLE_MONTH.ym, newCount: 0, overwriteCount: 1, unchangedCount: 2 }]);
        const ow = p.notApplied.find((c) => c.category === 'OVERWRITE')!;
        expect(ow.count).toBe(1);
        expect(ow.sample).toEqual([`O002 · ${WRITABLE_MONTH.ym}`]);
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(r.savedCount).toBe(1);
        expect(writtenTargets().map((t) => t.outletCode)).toEqual(['O002']);
        expect(notify.targetsUploaded).toHaveBeenCalledWith('deoleo', ['O002']);
      });

      it('UNCHANGED values but a different outlet NAME: only "outletName" is updated — no overwrite, no history, no notify', async () => {
        const notify = (service as unknown as { salesNotifications: { targetsUploaded: jest.Mock } }).salesNotifications;
        sharedTargetFindMany.mockImplementation(async () => [
          { outletCode: 'O001', outletName: 'Old Shop Name', targetValues: { MONTH_TGT: 10, FOCUS_PACK_1: 5 } },
        ]);
        const b = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]]);
        const p = await service.previewTargetUpload(admin, xfile(b));
        expect(p.overwriteCount).toBe(0);
        expect(p.unchangedCount).toBe(1);
        expect(p.outletNameUpdatedCount).toBe(1);
        expect(p.notApplied.find((c) => c.category === 'OVERWRITE')).toBeUndefined();
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(writtenTargets()).toHaveLength(0); // no target upsert (values, batchId, updatedAt untouched)
        const nameUpdates = mockTx.$executeRaw.mock.calls.filter((c: unknown[]) => /UPDATE "outlet_targets"/.test(sqlStr(c)));
        expect(nameUpdates).toHaveLength(1);
        expect(sqlStr(nameUpdates[0])).toMatch(/SET "outletName" = v\.name/);
        expect(sqlStr(nameUpdates[0])).not.toMatch(/updatedAt|targetValues|batchId/);
        const bound = (nameUpdates[0][0] as { values: unknown[] }).values;
        expect(bound).toEqual(expect.arrayContaining([['O001'], [WRITABLE_MONTH.ym], ['Outlet One'], 'deoleo']));
        expect(historyInsertCalls()).toHaveLength(0);
        expect(notify.targetsUploaded).not.toHaveBeenCalled();
        expect(r.savedCount).toBe(0);
        expect(r.outletNameUpdatedCount).toBe(1);
        expect(uploadAudits()[0].metadata).toEqual(expect.objectContaining({ unchangedCount: 1, outletNameUpdatedCount: 1 }));
      });

      it('same values AND same outlet name → nothing at all is written', async () => {
        sharedTargetFindMany.mockImplementation(async () => [
          { outletCode: 'O001', outletName: 'Outlet One', targetValues: { MONTH_TGT: 10, FOCUS_PACK_1: 5 } },
        ]);
        const b = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]]);
        const p = await service.previewTargetUpload(admin, xfile(b));
        expect(p).not.toHaveProperty('outletNameUpdatedCount');
        await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(mockTx.$executeRaw.mock.calls.filter((c: unknown[]) => /outlet_targets/.test(sqlStr(c)))).toHaveLength(0);
      });

      it('OVERWRITE fingerprint follows the NEW definition: an unchanged outlet-month that changed since the preview → 412', async () => {
        sharedTargetFindMany.mockImplementation(async () => [{ outletCode: 'O001', targetValues: { MONTH_TGT: 10, FOCUS_PACK_1: 5 } }]);
        const same = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]]);
        const p = await service.previewTargetUpload(admin, xfile(same));
        expect(p.notApplied.find((c) => c.category === 'OVERWRITE')).toBeUndefined();
        // Someone else changed O001 between the preview and the apply → it is now an OVERWRITE nobody acknowledged.
        sharedTargetFindMany.mockImplementation(async () => [{ outletCode: 'O001', targetValues: { MONTH_TGT: 99, FOCUS_PACK_1: 5 } }]);
        await expect(service.uploadTargets(admin, xfile(same), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/\(OVERWRITE\)/);
        expect(writtenTargets()).toHaveLength(0);
      });

      describe('ACHIEVEMENT-ONLY KPIs (Bajaj BSC CASES: achieved via Sales Import, never given a target)', () => {
        const bscCases = { ...kpiRow2, id: 'kpi3', code: 'BSC CASES', label: 'BSC Cases', order: 3 };
        /** The template layout + a "BSC Cases" column inside the month block. */
        const withCasesColumn = (rows: (string | number | null)[][]) => {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
            ['', '', '', WRITABLE_MONTH.label, '', ''],
            ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'BSC Cases'],
            ...rows,
          ]), 'Targets');
          return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
        };
        // Bajaj's existing monthly file, built from the template BEFORE the cases KPIs existed: no BSC Cases column.
        const oldFormat = () => buildTestXlsx([['O002', 'Outlet Two', 'HORECA', 1, 2]]);

        it('THE BUG (unflagged): the old-format file is refused — with the SPECIFIC parser message, not "corrupted"', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2, { ...bscCases, achievementOnly: false }]);
          const err = await service.previewTargetUpload(admin, xfile(oldFormat())).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(BadRequestException);
          expect((err as Error).message).toMatch(/Template KPI columns don't match the configured KPIs .*missing: BSC CASES.*re-download the template/);
          expect((err as Error).message).not.toMatch(/corrupted/i);
        });

        it('flagged achievementOnly: the old-format file previews and applies; the cases KPI is carried, never required', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2, { ...bscCases, achievementOnly: true }]);
          const p = await service.previewTargetUpload(admin, xfile(oldFormat()));
          expect(p.willSaveCount).toBe(1);
          expect(p.newCount).toBe(1);
          const r = await service.uploadTargets(admin, xfile(oldFormat()), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
          expect(r.savedCount).toBe(1);
          const w = writtenTargets();
          expect(w).toHaveLength(1);
          expect(w[0].targetValues).toEqual({ MONTH_TGT: 1, FOCUS_PACK_1: 2 }); // no BSC CASES key written
          // The write statement carries the stored BSC CASES value over (never deletes it).
          expect(((targetInsertCalls()[0][0] as { values: unknown[] }).values)).toContainEqual(['BSC CASES']);
        });

        it('a stored achievement-only value is carried, so re-uploading the same targets is UNCHANGED (not an overwrite)', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2, { ...bscCases, achievementOnly: true }]);
          sharedTargetFindMany.mockImplementation(async () => [
            { outletCode: 'O001', targetValues: { MONTH_TGT: 10, FOCUS_PACK_1: 5, 'BSC CASES': 3 } },
          ]);
          const p = await service.previewTargetUpload(admin, xfile(buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 5]])));
          expect(p.overwriteCount).toBe(0);
          expect(p.unchangedCount).toBe(1);
          expect(p.overwriteExamples).toEqual([]);
        });

        it('a file that still has the column but leaves it BLANK is accepted', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2, { ...bscCases, achievementOnly: true }]);
          const p = await service.previewTargetUpload(admin, xfile(withCasesColumn([['O002', 'Outlet Two', 'HORECA', 1, 2, null]])));
          expect(p.willSaveCount).toBe(1);
        });

        it('NO SILENT DROP: a number typed under the achievement-only column refuses the file, naming the KPI', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2, { ...bscCases, achievementOnly: true }]);
          const b = withCasesColumn([['O001', 'Outlet One', 'RETAIL', 10, 5, 7], ['O002', 'Outlet Two', 'HORECA', 1, 2, 8]]);
          await expect(service.previewTargetUpload(admin, xfile(b)))
            .rejects.toThrow(/"BSC Cases" \(2 values\).*achievement-only.*Nothing was saved/);
          await expect(service.uploadTargets(admin, xfile(b), { confirmToken: 'x' })).rejects.toThrow();
          expect(writtenTargets()).toHaveLength(0);
        });

        it('NO SILENT DROP: a name typed under the achievement-only KPI\'s "<KPI> Name" column refuses the file too', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([
            kpiRow, kpiRow2, { ...bscCases, achievementOnly: true, hasNameOverride: true, nameOverrideLabel: 'BSC Cases Name' },
          ]);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
            ['', '', '', WRITABLE_MONTH.label, '', '', ''],
            ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'BSC Cases', 'BSC Cases Name'],
            ['O001', 'Outlet One', 'RETAIL', 10, 5, null, 'Diwali pack'],
          ]), 'Targets');
          const b = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
          await expect(service.previewTargetUpload(admin, xfile(b)))
            .rejects.toThrow(/"BSC Cases Name" \(1 name\).*achievement-only KPI.*Nothing was saved/);
          expect(writtenTargets()).toHaveLength(0);
        });

        it('every enabled KPI achievement-only → a clear 400', async () => {
          mockPrisma.kpiDef.findMany.mockResolvedValue([{ ...bscCases, achievementOnly: true }]);
          await expect(service.previewTargetUpload(admin, xfile(oldFormat())))
            .rejects.toThrow(/Every enabled KPI is marked "achievement only"/);
        });
      });

      describe('parse errors (#1: specific, actionable message passes through)', () => {
        it('a non-template sheet (no "Outlet ID") → that exact reason, not "corrupted"', async () => {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], ['Code', 'Name'], ['X', 'Y']]), 'S');
          const b = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
          await expect(service.previewTargetUpload(admin, xfile(b)))
            .rejects.toThrow(/missing the required "Outlet ID" column\. Nothing was saved\./);
        });

        it('a file that is not xlsx at all keeps the generic message', async () => {
          // A zip-signature buffer SheetJS cannot open → genuinely unreadable.
          const b = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
          await expect(service.previewTargetUpload(admin, xfile(b))).rejects.toThrow(/^Invalid or corrupted xlsx file$/);
        });
      });

      it('targetChangesFor: carried (out-of-scope) values and names are kept, not logged; names are tracked', () => {
        const stored = new Map<string, Record<string, unknown>>([
          ['2026-12|O1', { A: 1, B: 2, C: 3, __names: { A: 'Old A', C: 'Kept C' } }],
        ]);
        const changes = targetChangesFor(
          [{ month: '2026-12', outletCode: 'O1', kpiMap: { A: 1, B: 20, __names: { A: 'New A' } }, carry: ['C'] }],
          stored,
        );
        expect(changes).toEqual([
          { outletCode: 'O1', month: '2026-12', kpiCode: 'B', field: 'VALUE', oldValue: 2, newValue: 20, changeType: 'UPDATED' },
          { outletCode: 'O1', month: '2026-12', kpiCode: 'A', field: 'NAME', oldValue: 'Old A', newValue: 'New A', changeType: 'UPDATED' },
        ]);
        // a brand-new outlet-month: every value CREATED; an identical re-upload: nothing
        expect(targetChangesFor([{ month: '2026-12', outletCode: 'O2', kpiMap: { A: 0 }, carry: [] }], stored))
          .toEqual([{ outletCode: 'O2', month: '2026-12', kpiCode: 'A', field: 'VALUE', oldValue: null, newValue: 0, changeType: 'CREATED' }]);
        expect(targetChangesFor([{ month: '2026-12', outletCode: 'O1', kpiMap: { A: 1, B: 2, __names: { A: 'Old A' } }, carry: ['C'] }], stored))
          .toEqual([]);
      });


      it('the confirmed file is KEPT in the private bucket (tenant + batch folder) BEFORE any target is written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        const r = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) });
        expect(mockStorage.uploadFile).toHaveBeenCalledTimes(1);
        const [bytes, key] = mockStorage.uploadFile.mock.calls[0];
        expect(bytes).toBe(b);
        expect(key).toBe(`target-uploads/deoleo/${r.batchId}/2026-11/uuid-targets.xlsx`);
        expect(mockStorage.uploadFile.mock.invocationCallOrder[0])
          .toBeLessThan(insertOrder('first'));
      });

      it('the file cannot be stored → 503 "nothing was saved", batch FAILED + FAILED audit, no target written', async () => {
        mockStorage.uploadFile.mockRejectedValueOnce(new Error('gcs down'));
        sharedBatchUpdateMany.mockResolvedValueOnce({ count: 1 });
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        await expect(service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/could not be stored, so nothing was saved/);
        expect(writtenTargets()).toHaveLength(0);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(sharedBatchUpdateMany).toHaveBeenCalledWith({ where: { id: 'batch1', status: 'PENDING' }, data: { status: 'FAILED' } });
        expect(uploadAudits()).toEqual([expect.objectContaining({
          metadata: expect.objectContaining({ status: 'FAILED', failureReason: 'STORAGE_FAILED', fileKey: null }),
        })]);
      });

      it('storage not configured → 503 refusal (audited) before anything is written', async () => {
        const noStorage = new TargetsService(mockPrisma as never, { targetsUploaded: jest.fn() } as never);
        const b = buf();
        const p = await noStorage.previewTargetUpload(admin, xfile(b));
        await expect(noStorage.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }))
          .rejects.toThrow(/File storage is not available/);
        expect(mockTx.targetUploadBatch.create).not.toHaveBeenCalled();
        expect(refusals().map((d) => d.metadata.reason)).toEqual(['STORAGE_UNAVAILABLE']);
      });

      it('locked past-month outlet-months and blank rows are their own categories', async () => {
        const ws = XLSX.utils.aoa_to_sheet([
          ['', '', '', "Jan '20 Target", '', WRITABLE_MONTH.label, ''],
          ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'Month Target', 'Focus Pack - 1'],
          ['O001', 'Outlet One', 'RETAIL', 5, 5, 7, 7],
          ['O002', 'Outlet Two', 'HORECA', null, null, null, null],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Targets');
        sharedTargetFindMany.mockImplementation(async () => []);
        const p = await service.previewTargetUpload(admin, xfile(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer));
        expect(p.notApplied.map((c) => [c.category, c.count, c.sample])).toEqual([
          ['LOCKED_MONTHS', 1, ['O001 · 2020-01']],
          ['BLANK_ROWS', 1, ['Row 4 — O002']],
        ]);
      });

      it('a tenant OUTSIDE confirmRequired applies directly (same all-or-nothing write, audited as direct, no file kept)', async () => {
        jest.spyOn(TargetsService, 'confirmRequired').mockReturnValue(false);
        const r = await service.uploadTargets(admin, xfile(buf()));
        expect(r.batchId).toBe('batch1');
        expect(r.savedCount).toBe(2);
        expect(mockStorage.uploadFile).not.toHaveBeenCalled();
        expect(uploadAudits()).toEqual([expect.objectContaining({
          metadata: expect.objectContaining({ change: 'target-upload-direct', status: 'APPLIED', tokenNonce: null, fileKey: null }),
        })]);
      });

      it('LOST REPLY, DB unreadable → UNKNOWN: "couldn\'t confirm whether it saved", never marked FAILED, recorded', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        mockPrisma.$transaction.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));
        sharedBatchFindFirst.mockRejectedValueOnce(new Error('db unreachable'));
        const err = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as Error).message).toMatch(/couldn't confirm whether the targets were saved\. Refresh .* Upload history .* before retrying/);
        expect(sharedBatchUpdateMany).not.toHaveBeenCalled();
        expect(uploadAudits()).toEqual([]);
        const unconfirmed = sharedAuditCreate.mock.calls.map((c) => c[0].data).filter((d) => d.entityType === 'TARGET_UPLOAD_UNCONFIRMED');
        expect(unconfirmed).toEqual([expect.objectContaining({
          entityId: 'batch1', metadata: expect.objectContaining({ status: 'UNKNOWN', error: 'connection reset' }),
        })]);
      });

      it('LOST REPLY, batch no longer PENDING when marking FAILED (a commit landed meanwhile) → UNKNOWN, not "nothing saved"', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        mockPrisma.$transaction.mockImplementationOnce(() => Promise.reject(new Error('timeout')));
        sharedBatchFindFirst.mockResolvedValueOnce({ status: 'PENDING' });
        sharedBatchUpdateMany.mockResolvedValueOnce({ count: 0 }); // WHERE status = 'PENDING' matched nothing
        const err = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as Error).message).not.toMatch(/NOTHING/);
        expect(uploadAudits()).toEqual([]); // no FAILED row
      });

      it('CHANGED WHILE APPLYING (inside the tx) → 412 recorded as a REFUSAL, no failed batch, nothing written', async () => {
        const b = buf();
        const p = await service.previewTargetUpload(admin, xfile(b));
        // the pre-check read sees the preview's state; the in-transaction read (after the lock) sees O002 stored too
        let reads = 0;
        sharedTargetFindMany.mockImplementation(async () => (++reads <= 1 ? [{ outletCode: 'O001' }] : [{ outletCode: 'O001' }, { outletCode: 'O002' }]));
        const err = await service.uploadTargets(admin, xfile(b), { confirmToken: p.previewToken, acknowledged: acksOf(p) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PreconditionFailedException);
        expect((err as Error).message).toMatch(/changed while applying \(now 2 would be replaced, you confirmed 1\)\. Nothing was saved/);
        expect(writtenTargets()).toHaveLength(0);
        expect(uploadAudits()).toEqual([]);
        expect(sharedBatchUpdateMany).not.toHaveBeenCalled();
        expect(sharedBatchDeleteMany).toHaveBeenCalledWith({ where: { id: 'batch1', status: 'PENDING' } });
        expect(refusals().map((d) => [d.metadata.reason, d.metadata.decidedInsideTransaction])).toEqual([['ACK_CHANGED', true]]);
      });

      it('SCALE: 6,500 outlets × 12 months × 5 KPIs → targets + change history in ≤ 200 statements, ONE transaction', async () => {
        jest.spyOn(TargetsService, 'confirmRequired').mockReturnValue(false);
        sharedTargetFindMany.mockImplementation(async () => []);
        const months = Array.from({ length: 12 }, (_, i) => {
          const d = new Date(new Date().getFullYear() + 1, i, 1);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        });
        const writes = months.flatMap((month) =>
          Array.from({ length: 6500 }, (_, i) => ({
            month, outletCode: `O${i}`, outletName: `Outlet ${i}`,
            // 5 KPIs per outlet-month, all new → 390,000 change-history rows (the worst case for the history writes)
            kpiMap: { MONTH_TGT: i, FOCUS_PACK_1: 1, FOCUS_PACK_2: 2, FOCUS_CATEGORY: 3, CONSISTENCY: 4 },
            carry: [] as string[],
          })),
        );
        const p = {
          scopeEnforced: false,
          parseResult: { rows: [], acceptedTargets: {}, summary: { total: 6500, accepted: 6500, rejected: 0, ignoredOutOfScope: 0 } },
          sortedMonths: months, lockedMonths: [], writableMonths: months, batchMonth: months[0], writes, lockedKeys: [],
          kpiLabels: new Map(),
        };
        // count every DB statement the transaction issues
        const counted = [mockTx.$executeRaw, sharedTargetFindMany, sharedBatchUpdate, sharedAuditCreate, sharedAuditFindFirst];
        const r = await (service as unknown as {
          applyTargetUpload: (...a: unknown[]) => Promise<{ savedCount: number; newCount: number }>;
        }).applyTargetUpload(admin, xfile(Buffer.from('x')), p, [], [], undefined, { fileName: 'x.xlsx', fileSize: 1, fileSha256: 'h' });
        const statements = counted.reduce((n, m) => n + m.mock.calls.length, 0);
        expect(r.savedCount).toBe(78_000);
        expect(r.newCount).toBe(78_000);
        expect(writtenTargets()).toHaveLength(78_000);
        expect(targetInsertCalls()).toHaveLength(78); // 78,000 / 1,000
        expect(historyInsertCalls()).toHaveLength(39); // 390,000 changes / 10,000
        expect(historyRows()).toHaveLength(390_000);
        expect(statements).toBeLessThanOrEqual(200);
        const interactive = mockPrisma.$transaction.mock.calls.filter((c) => typeof c[0] === 'function');
        expect(interactive).toHaveLength(1);
        expect(((interactive[0] as unknown[])[1] as { timeout: number }).timeout).toBe(5 * 60 * 1000);
      });


      it('the scope helper defaults to ALL tenants (owner 2026-11-25, incl. Deoleo)', () => {
        jest.restoreAllMocks();
        expect(TargetsService.confirmRequired('deoleo')).toBe(true);
        expect(TargetsService.confirmRequired('any-other-tenant')).toBe(true);
      });

      it('parseAckParam: "CATEGORY:count:fingerprint" list; malformed parts never match', () => {
        expect(TargetsService.parseAckParam('OVERWRITE:12:abcdef0123456789,BLANK_ROWS')).toEqual([
          { category: 'OVERWRITE', count: 12, fingerprint: 'abcdef0123456789' },
          { category: 'BLANK_ROWS', count: NaN, fingerprint: '' },
        ]);
        expect(TargetsService.parseAckParam('')).toEqual([]);
        expect(TargetsService.parseAckParam(undefined)).toEqual([]);
      });
    });
  });

  // ─── listBatches ───────────────────────────────────────────────────────────

  describe('listBatches', () => {
    it('scopes query to caller tenant, newest first, one page of 100 (+1 to know if there is more)', async () => {
      mockPrisma.targetUploadBatch.findMany.mockResolvedValue([]);
      const r = await service.listBatches(admin, {} as ListBatchesQueryDto);

      const arg = mockPrisma.targetUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(arg.take).toBe(101);
      expect(r).toEqual({ items: [], pageSize: 100, hasMore: false, nextCursor: null });
    });

    it('filters by month when provided', async () => {
      mockPrisma.targetUploadBatch.findMany.mockResolvedValue([]);
      await service.listBatches(admin, { month: '2026-07' });

      const arg = mockPrisma.targetUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.month).toBe('2026-07');
    });

    it('PAGING: 101 rows → 100 shown, hasMore + nextCursor; `before` continues after that row (tenant-scoped)', async () => {
      const t0 = Date.now();
      const many = Array.from({ length: 101 }, (_, i) => ({
        id: `b${String(i).padStart(3, '0')}`, clientId: 'deoleo', uploadedById: 'admin1', month: '2026-12',
        totalRows: 1, acceptedCount: 1, rejectedCount: 0, status: 'APPLIED', createdAt: new Date(t0 - i * 1000),
      }));
      mockPrisma.targetUploadBatch.findMany.mockResolvedValueOnce(many);
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);
      mockPrisma.user.findMany.mockResolvedValueOnce([]);
      const first = await service.listBatches(admin, {} as ListBatchesQueryDto);
      expect(first.items).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe('b099');

      const cursorAt = new Date(t0 - 99_000);
      sharedBatchFindFirst.mockResolvedValueOnce({ id: 'b099', createdAt: cursorAt });
      mockPrisma.targetUploadBatch.findMany.mockResolvedValueOnce([many[100]]);
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);
      mockPrisma.user.findMany.mockResolvedValueOnce([]);
      const second = await service.listBatches(admin, { before: 'b099' });
      expect(sharedBatchFindFirst.mock.calls[0][0].where).toEqual({ id: 'b099', clientId: 'deoleo' });
      expect(mockPrisma.targetUploadBatch.findMany.mock.calls[1][0].where.OR).toEqual([
        { createdAt: { lt: cursorAt } }, { createdAt: cursorAt, id: { lt: 'b099' } },
      ]);
      expect(second).toEqual(expect.objectContaining({ hasMore: false, nextCursor: null }));
      expect(second.items).toHaveLength(1);
    });

    it("PAGING: another tenant's (or unknown) cursor → 400, never a cross-tenant page", async () => {
      sharedBatchFindFirst.mockResolvedValueOnce(null);
      await expect(service.listBatches(admin, { before: 'theirs' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.targetUploadBatch.findMany).not.toHaveBeenCalled();
    });

    it('UPLOAD HISTORY: joins the audit details + uploader name + a truthful outcome; the file only for applied uploads', async () => {
      const old = new Date(Date.now() - 60 * 60_000);
      mockPrisma.targetUploadBatch.findMany.mockResolvedValue([
        { id: 'tgtup_new', clientId: 'deoleo', uploadedById: 'admin1', month: '2026-12', totalRows: 5, acceptedCount: 4, rejectedCount: 1, status: 'APPLIED', createdAt: new Date() },
        { id: 'old1', clientId: 'deoleo', uploadedById: 'gifsy1', month: '2026-11', totalRows: 2, acceptedCount: 2, rejectedCount: 0, status: 'COMPLETED', createdAt: old },
        { id: 'tgtup_failed', clientId: 'deoleo', uploadedById: 'admin1', month: '2026-12', totalRows: 1, acceptedCount: 1, rejectedCount: 0, status: 'FAILED', createdAt: new Date() },
        { id: 'legacy_failed', clientId: 'deoleo', uploadedById: 'admin1', month: '2026-10', totalRows: 1, acceptedCount: 1, rejectedCount: 0, status: 'FAILED', createdAt: old },
        { id: 'pending_now', clientId: 'deoleo', uploadedById: 'admin1', month: '2026-12', totalRows: 1, acceptedCount: 1, rejectedCount: 0, status: 'PENDING', createdAt: new Date() },
        { id: 'pending_old', clientId: 'deoleo', uploadedById: 'admin1', month: '2026-12', totalRows: 1, acceptedCount: 1, rejectedCount: 0, status: 'PENDING', createdAt: old },
      ]);
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { entityId: 'tgtup_new', metadata: { clientId: 'deoleo', status: 'APPLIED', months: ['2026-12'], fileName: 't.xlsx', fileSize: 10, fileKey: 'target-uploads/deoleo/tgtup_new/k.xlsx', savedCount: 4, newCount: 1, overwriteCount: 3, acknowledged: [] } },
        // an audit row naming ANOTHER tenant is never trusted
        { entityId: 'old1', metadata: { clientId: 'other', fileKey: 'target-uploads/other/old1/k.xlsx' } },
        { entityId: 'tgtup_failed', metadata: { clientId: 'deoleo', status: 'FAILED', failureReason: 'WRITE_FAILED', fileKey: 'target-uploads/deoleo/tgtup_failed/k.xlsx' } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'admin1', name: 'Asha Admin', clientId: 'deoleo' },
        { id: 'gifsy1', name: 'Ravi Ops', clientId: 'gifsy' },
      ]);
      const { items: rows } = await service.listBatches(admin, {} as ListBatchesQueryDto);
      expect(mockPrisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
        entityType: 'TARGET_UPLOAD', entityId: { in: ['tgtup_new', 'old1', 'tgtup_failed', 'legacy_failed', 'pending_now', 'pending_old'] },
      });
      expect(rows[0]).toEqual(expect.objectContaining({
        id: 'tgtup_new', outcome: 'APPLIED', uploadedByName: 'Asha Admin', months: ['2026-12'], newCount: 1, overwriteCount: 3, fileKept: true,
      }));
      expect(rows[1]).toEqual(expect.objectContaining({ id: 'old1', outcome: 'APPLIED', uploadedByName: 'Gifsy team', fileKept: false, overwriteCount: null }));
      expect(rows[2]).toEqual(expect.objectContaining({ id: 'tgtup_failed', outcome: 'FAILED', failureReason: 'WRITE_FAILED', fileKept: false }));
      expect(rows[3]).toEqual(expect.objectContaining({ id: 'legacy_failed', outcome: 'LEGACY_FAILED' }));
      expect(rows[4]).toEqual(expect.objectContaining({ id: 'pending_now', outcome: 'IN_PROGRESS' }));
      expect(rows[5]).toEqual(expect.objectContaining({ id: 'pending_old', outcome: 'ABANDONED' }));
    });
  });

  describe('listTargetHistory (Target history)', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 26, 6, min));
    const row = (id: string, extra: Record<string, unknown> = {}) => ({
      id, clientId: 'deoleo', outletCode: 'O001', month: '2026-12', kpiCode: 'MONTH_TGT', field: 'VALUE',
      oldValue: 10, newValue: 12, changeType: 'UPDATED', batchId: 'b1', changedById: 'admin1', changedAt: at(5), ...extra,
    });
    beforeEach(() => {
      mockPrisma.targetChangeHistory.findMany.mockReset();
      mockPrisma.targetChangeHistory.findFirst.mockReset();
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'admin1', name: 'Asha Admin', clientId: 'deoleo' },
        { id: 'gifsy1', name: 'Ravi Ops', clientId: 'gifsy' },
      ]);
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { entityId: 'b1', metadata: { clientId: 'deoleo', status: 'APPLIED', fileKey: 'target-uploads/deoleo/b1/x.xlsx' } },
        // another tenant's audit row for a colliding id is never trusted
        { entityId: 'b2', metadata: { clientId: 'other', status: 'APPLIED', fileKey: 'target-uploads/other/b2/x.xlsx' } },
      ]);
    });

    it('TENANT-SCOPED: the query, the tracking start and the cursor are all limited to the caller tenant', async () => {
      mockPrisma.targetChangeHistory.findMany.mockResolvedValueOnce([row('h2'), row('h1', { batchId: 'b2', changedById: 'gifsy1' })]);
      mockPrisma.targetChangeHistory.findFirst.mockResolvedValueOnce({ changedAt: at(1) }); // tracking since
      const r = await service.listTargetHistory(admin, { outletCode: 'O001' });
      const args = mockPrisma.targetChangeHistory.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ clientId: 'deoleo', outletCode: 'O001' });
      expect(args.orderBy).toEqual([{ changedAt: 'desc' }, { id: 'desc' }]);
      expect(args.take).toBe(101);
      expect(mockPrisma.targetChangeHistory.findFirst.mock.calls[0][0].where).toEqual({ clientId: 'deoleo' });
      expect(r.trackingSince).toEqual(at(1));
      expect(r.items[0]).toEqual(expect.objectContaining({
        id: 'h2', kpiLabel: 'Month Target', oldValue: 10, newValue: 12, changeType: 'UPDATED', changedByName: 'Asha Admin', batchFileKept: true,
      }));
      // another tenant's operator is not named; another tenant's file is never linked
      expect(r.items[1]).toEqual(expect.objectContaining({ changedByName: 'Gifsy team', batchFileKept: false }));
      expect(r).toEqual(expect.objectContaining({ hasMore: false, nextCursor: null, pageSize: 100 }));
    });

    it('filters by month / KPI; pages with `before` (cursor looked up in THIS tenant only)', async () => {
      mockPrisma.targetChangeHistory.findFirst.mockResolvedValueOnce({ id: 'h9', changedAt: at(9) }); // cursor
      mockPrisma.targetChangeHistory.findMany.mockResolvedValueOnce([]);
      mockPrisma.targetChangeHistory.findFirst.mockResolvedValueOnce(null); // tracking since
      const r = await service.listTargetHistory(admin, { outletCode: 'O001', month: '2026-12', kpiCode: 'MONTH_TGT', before: 'h9' });
      expect(mockPrisma.targetChangeHistory.findFirst.mock.calls[0][0].where).toEqual({ id: 'h9', clientId: 'deoleo' });
      expect(mockPrisma.targetChangeHistory.findMany.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo', outletCode: 'O001', month: '2026-12', kpiCode: 'MONTH_TGT',
        OR: [{ changedAt: { lt: at(9) } }, { changedAt: at(9), id: { lt: 'h9' } }],
      });
      expect(r.trackingSince).toBeNull();
    });

    it("another tenant's (or unknown) cursor → 400, never a cross-tenant page", async () => {
      mockPrisma.targetChangeHistory.findFirst.mockResolvedValueOnce(null);
      await expect(service.listTargetHistory(admin, { outletCode: 'O001', before: 'theirs' })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.targetChangeHistory.findMany).not.toHaveBeenCalled();
    });

    it('101 rows → 100 shown + nextCursor', async () => {
      mockPrisma.targetChangeHistory.findMany.mockResolvedValueOnce(Array.from({ length: 101 }, (_, i) => row(`h${i}`)));
      const r = await service.listTargetHistory(admin, { outletCode: 'O001' });
      expect(r.items).toHaveLength(100);
      expect(r).toEqual(expect.objectContaining({ hasMore: true, nextCursor: 'h99' }));
    });
  });


  describe('openBatchFile (Download file)', () => {
    const obj = { stream: {} as never, size: 3, contentType: 'application/x' };
    beforeEach(() => { mockStorage.openBoundedObject.mockResolvedValue(obj); });

    it("streams the kept file of the caller tenant's batch", async () => {
      (mockPrisma.targetUploadBatch as unknown as { findFirst: jest.Mock }).findFirst = jest.fn().mockResolvedValue({ id: 'tgtup_a' });
      mockPrisma.auditLog.findFirst.mockResolvedValue({ metadata: { clientId: 'deoleo', fileName: 'mine.xlsx', fileKey: 'target-uploads/deoleo/tgtup_a/2026-11/u-mine.xlsx' } });
      const r = await service.openBatchFile(admin, 'tgtup_a');
      expect(r).toEqual(expect.objectContaining({ size: 3, fileName: 'mine.xlsx' }));
      expect(mockStorage.openBoundedObject).toHaveBeenCalledWith('target-uploads/deoleo/tgtup_a/2026-11/u-mine.xlsx');
      // the batch lookup is tenant-scoped
      const findFirst = (mockPrisma.targetUploadBatch as unknown as { findFirst: jest.Mock }).findFirst;
      expect(findFirst.mock.calls[0][0].where).toEqual({ id: 'tgtup_a', clientId: 'deoleo' });
    });

    it("TENANT ISOLATION: another tenant's batch id -> 404, storage never touched", async () => {
      (mockPrisma.targetUploadBatch as unknown as { findFirst: jest.Mock }).findFirst = jest.fn().mockResolvedValue(null);
      await expect(service.openBatchFile(admin, 'tgtup_theirs')).rejects.toThrow(NotFoundException);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('TENANT ISOLATION: an audit row naming another tenant, or a key outside this tenant/batch folder -> 404', async () => {
      (mockPrisma.targetUploadBatch as unknown as { findFirst: jest.Mock }).findFirst = jest.fn().mockResolvedValue({ id: 'tgtup_a' });
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({ metadata: { clientId: 'other', fileKey: 'target-uploads/deoleo/tgtup_a/k.xlsx' } });
      await expect(service.openBatchFile(admin, 'tgtup_a')).rejects.toThrow(/not kept/);
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({ metadata: { clientId: 'deoleo', fileKey: 'target-uploads/other/tgtup_b/k.xlsx' } });
      await expect(service.openBatchFile(admin, 'tgtup_a')).rejects.toThrow(/not kept/);
      expect(mockStorage.openBoundedObject).not.toHaveBeenCalled();
    });

    it('an older upload (no audit row) or a missing object -> 404 "not kept"', async () => {
      (mockPrisma.targetUploadBatch as unknown as { findFirst: jest.Mock }).findFirst = jest.fn().mockResolvedValue({ id: 'old1' });
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce(null);
      await expect(service.openBatchFile(admin, 'old1')).rejects.toThrow(/not kept/);
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({ metadata: { clientId: 'deoleo', fileKey: 'target-uploads/deoleo/old1/k.xlsx' } });
      mockStorage.openBoundedObject.mockResolvedValueOnce(null);
      await expect(service.openBatchFile(admin, 'old1')).rejects.toThrow(/not kept/);
    });
  });

  // ─── listTargets ───────────────────────────────────────────────────────────

  describe('listTargets', () => {
    it('scopes query to tenant and filters by month', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      await service.listTargets(admin, { month: '2026-07' } as ListTargetsQueryDto);

      const arg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.where.month).toBe('2026-07');
    });

    it('optionally filters by outletCode', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      await service.listTargets(admin, { month: '2026-07', outletCode: 'O001' });

      const arg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(arg.where.outletCode).toBe('O001');
    });

    it('throws BadRequestException when month is not provided', async () => {
      await expect(
        service.listTargets(admin, {} as ListTargetsQueryDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── exportTargetsBuffer (Download Final Targets) ───────────────────────────

  describe('exportTargetsBuffer', () => {
    const XLSX = require('xlsx');

    it('rejects a non-YYYY-MM month', async () => {
      await expect(exportTargetsBuffer(admin, 'July')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when the tenant has no enabled KPIs', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      await expect(exportTargetsBuffer(admin, '2026-07')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('dumps stored targetValues verbatim, blank for an omitted KPI key', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        // RT-1 has both KPIs; RT-2 only the primary (FOCUS_PACK_1 omitted → blank).
        // The denormalized outletType snapshot is gone; type resolves from the Outlet join below.
        { outletCode: 'RT-1', outletName: 'Shop One', targetValues: { MONTH_TGT: 100, FOCUS_PACK_1: 20 } },
        { outletCode: 'RT-2', outletName: 'Shop Two', targetValues: { MONTH_TGT: 50 } },
      ]);
      // programName AND the AUTHORITATIVE outletType are joined from Outlet by (clientId, outletCode).
      // RT-1 was reclassified to WHOLESALER since upload — the export must reflect that, not "SSS".
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'RT-1', programName: 'Trade Loyalty', outletType: { code: 'WHOLESALER' } },
        { outletCode: 'RT-2', programName: 'Gold Programme', outletType: { code: 'SSS' } },
      ]);

      const buf = await exportTargetsBuffer(admin, '2026-07');

      // Tenant + month scoped read.
      const where = mockPrisma.outletTarget.findMany.mock.calls.at(-1)[0].where;
      expect(where).toEqual({ clientId: 'deoleo', month: '2026-07' });

      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      // 2-row month-group header (matches generateTargetTemplateBuffer) so the
      // "Download Final Targets" export re-uploads cleanly through parseTargetUploadBuffer.
      // Row 0 = month-group label over the KPI columns; row 1 = column labels.
      // A read-only "Program Name" identity column is injected after Outlet Type (shifts KPI cols +1).
      expect(rows[0][4]).toBe("Jul '26 Target");
      expect(rows[1]).toEqual(['Outlet ID', 'Outlet Name', 'Outlet Type', 'Program Name', 'Month Target', 'Focus Pack - 1']);
      // Outlet Type is the AUTHORITATIVE current type (WHOLESALER), NOT the frozen "SSS" snapshot.
      expect(rows[2]).toEqual(['RT-1', 'Shop One', 'WHOLESALER', 'Trade Loyalty', 100, 20]);
      // RT-2's omitted FOCUS_PACK_1 cell is blank (empty), not 0.
      expect(rows[3][3]).toBe('Gold Programme');
      expect(rows[3][4]).toBe(50);
      expect(rows[3][5]).toBe('');
    });
  });

  // ─── exportAchievementsBuffer (Download Sales Data) ─────────────────────────

  describe('exportAchievementsBuffer', () => {
    const XLSX = require('xlsx');

    it('rejects a non-YYYY-MM month', async () => {
      await expect(exportAchievementsBuffer(admin, 'July')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when the tenant has no enabled KPIs', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      await expect(exportAchievementsBuffer(admin, '2026-07')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reads OutletSalesRecord for the month (tenant + month scoped)', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      mockPrisma.outlet.findMany.mockResolvedValue([]);

      await exportAchievementsBuffer(admin, '2026-07');

      const where = mockPrisma.outletSalesRecord.findMany.mock.calls.at(-1)[0].where;
      expect(where).toEqual({ clientId: 'deoleo', month: '2026-07' });
    });

    it('dumps stored kpiValues verbatim + a Program Name column sourced from the Outlet join', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        // RT-1 has both KPIs; RT-2 only the primary (FOCUS_PACK_1 omitted → blank).
        // The denormalized outletType snapshot is gone; type resolves from the Outlet join below.
        { outletCode: 'RT-1', outletName: 'Shop One', kpiValues: { MONTH_TGT: 100, FOCUS_PACK_1: 20 } },
        { outletCode: 'RT-2', outletName: 'Shop Two', kpiValues: { MONTH_TGT: 50 } },
      ]);
      // programName AND the AUTHORITATIVE outletType come from the Outlet join (NOT the sales snapshot).
      // RT-1 was reclassified to WHOLESALER since upload — the export must reflect that.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'RT-1', programName: 'Deoleo Gold', outletType: { code: 'WHOLESALER' } },
        { outletCode: 'RT-2', programName: null, outletType: { code: 'SSS' } }, // unset programName → blank cell
      ]);

      const buf = await exportAchievementsBuffer(admin, '2026-07');

      // Outlet join is tenant-scoped, excludes soft-deleted, and is BOUNDED to only
      // the outletCodes being exported (mirrors exportTargetsBuffer).
      const outletWhere = mockPrisma.outlet.findMany.mock.calls.at(-1)[0].where;
      expect(outletWhere).toEqual({
        clientId: 'deoleo',
        outletCode: { in: ['RT-1', 'RT-2'] },
        deletedAt: null,
      });

      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // 2-row month-group header, Program Name inserted AFTER the identity cols.
      expect(rows[0][4]).toBe("Jul '26 Target"); // month label now at col 4 (after Program Name)
      expect(rows[1]).toEqual([
        'Outlet ID', 'Outlet Name', 'Outlet Type', 'Program Name', 'Month Target', 'Focus Pack - 1',
      ]);
      // RT-1: AUTHORITATIVE outletType (WHOLESALER) from the join + program name + KPI values verbatim.
      expect(rows[2]).toEqual(['RT-1', 'Shop One', 'WHOLESALER', 'Deoleo Gold', 100, 20]);
      // RT-2: null programName → blank; omitted FOCUS_PACK_1 → blank (not 0).
      expect(rows[3][3]).toBe('');   // Program Name blank
      expect(rows[3][4]).toBe(50);   // MONTH_TGT
      expect(rows[3][5]).toBe('');   // FOCUS_PACK_1 omitted
    });
  });

  // ─── uploadAchievements ────────────────────────────────────────────────────

  describe('uploadAchievements', () => {
    const mockOutlets = [
      { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
      { outletCode: 'O002', name: 'Outlet Two', outletType: { code: 'HORECA' } },
    ];

    beforeEach(() => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outlet.findMany.mockResolvedValue(mockOutlets);
      mockTx.salesUploadBatch.create.mockResolvedValue({
        id: 'sales-batch-1',
        clientId: 'deoleo',
        month: '2026-07',
        totalRows: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        status: 'COMPLETED',
      });
      mockTx.outletSalesRecord.upsert.mockResolvedValue({});
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        service.uploadAchievements(admin, undefined as unknown as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no enabled KPIs exist', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      await expect(service.uploadAchievements(admin, file)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a corrupted (non-xlsx) buffer', async () => {
      const file = {
        buffer: Buffer.from('NOT AN XLSX FILE'),
        originalname: 'bad.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      await expect(service.uploadAchievements(admin, file)).rejects.toThrow(BadRequestException);
    });

    it('writes verbatim kpiValues into OutletSalesRecord and returns batch summary', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 55.5, 30]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadAchievements(admin, file);

      expect(result.batchId).toBe('sales-batch-1');
      expect(result.acceptedCount).toBeGreaterThanOrEqual(1);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      const stored = upsertCall.create.kpiValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(55.5);
      expect(stored['FOCUS_PACK_1']).toBe(30);
    });

    it('CRITICAL: blank cell → key OMITTED from kpiValues (not 0)', async () => {
      // O001: MONTH_TGT=100, FOCUS_PACK_1=blank
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, null]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      const stored = upsertCall.create.kpiValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(100);
      expect('FOCUS_PACK_1' in stored).toBe(false);
    });

    it('CRITICAL: 0 is stored verbatim in kpiValues (0 ≠ blank)', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 0, 75]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      const stored = upsertCall.create.kpiValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(0);
      expect(stored['FOCUS_PACK_1']).toBe(75);
    });

    it('unknown outlet code → rejected, no OutletSalesRecord upsert', async () => {
      const file = {
        buffer: buildTestXlsx([['GHOST', 'Ghost Outlet', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      expect(mockTx.outletSalesRecord.upsert).not.toHaveBeenCalled();
    });

    it('REGRESSION: an achievement row for a pending-KYC (isActive:false) outlet is ACCEPTED, not rejected_outlet', async () => {
      // Achievement roster query no longer filters isActive → pending outlet is known.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'PENDING1', name: 'Pending Outlet', outletType: { code: 'RETAIL' } },
      ]);

      const file = {
        buffer: buildTestXlsx([['PENDING1', 'Pending Outlet', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadAchievements(admin, file);

      // Accepted rows are counted, not echoed (memory-safety) — PENDING1 is NOT among the rejected rows.
      expect(result.acceptedCount).toBe(1);
      expect(result.problemRows.find((r) => r.outletCode === 'PENDING1')).toBeUndefined();
      expect(result.problemRowCount).toBe(0);
      expect(mockTx.outletSalesRecord.upsert).toHaveBeenCalledTimes(1);
    });

    it('ROSTER: fetches ALL non-deleted outlets — no isActive filter', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 20]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const arg = mockPrisma.outlet.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId: 'deoleo', deletedAt: null });
      expect('isActive' in arg.where).toBe(false);
    });

    it('tenant-scopes SalesUploadBatch.create with clientId', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 20]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const batchCreate = mockTx.salesUploadBatch.create.mock.calls[0][0];
      expect(batchCreate.data.clientId).toBe('deoleo');
      expect(batchCreate.data.uploadedById).toBe('admin1');
    });

    it('tenant-scopes OutletSalesRecord.upsert with clientId', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 20]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      expect(upsertCall.create.clientId).toBe('deoleo');
      expect(upsertCall.where.clientId_outletCode_month.clientId).toBe('deoleo');
    });
  });

  // ─── listAchievementBatches ────────────────────────────────────────────────

  describe('listAchievementBatches', () => {
    it('scopes query to caller tenant, newest first', async () => {
      mockPrisma.salesUploadBatch.findMany.mockResolvedValue([]);
      await service.listAchievementBatches(admin, {} as ListAchievementBatchesQueryDto);

      const arg = mockPrisma.salesUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('filters by month when provided', async () => {
      mockPrisma.salesUploadBatch.findMany.mockResolvedValue([]);
      await service.listAchievementBatches(admin, { month: '2026-07' });

      const arg = mockPrisma.salesUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.month).toBe('2026-07');
    });
  });

  // ─── listAchievements ──────────────────────────────────────────────────────

  describe('listAchievements', () => {
    it('scopes query to tenant and filters by month', async () => {
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      await service.listAchievements(admin, { month: '2026-07' } as ListAchievementsQueryDto);

      const arg = mockPrisma.outletSalesRecord.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.where.month).toBe('2026-07');
    });

    it('optionally filters by outletCode', async () => {
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      await service.listAchievements(admin, { month: '2026-07', outletCode: 'O001' });

      const arg = mockPrisma.outletSalesRecord.findMany.mock.calls[0][0];
      expect(arg.where.outletCode).toBe('O001');
    });

    it('throws BadRequestException when month is not provided', async () => {
      await expect(
        service.listAchievements(admin, {} as ListAchievementsQueryDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── getPace ───────────────────────────────────────────────────────────────

  describe('getPace', () => {
    beforeEach(() => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      // getPace now joins Outlet for the AUTHORITATIVE outletType (Phase 1 root-fix);
      // default to an empty roster so existing pace tests resolve outletType to ''.
      mockPrisma.outlet.findMany.mockResolvedValue([]);
    });

    it('ROOT-FIX Phase 1: outletType resolves from the AUTHORITATIVE Outlet.outletType.code, NOT the stale snapshot', async () => {
      // The denormalized target-type snapshot is gone — type must come from the Outlet join…
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      // …but the Outlet is authoritatively WHOLESALER now.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O001', outletType: { code: 'WHOLESALER' } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });

      // Resolved by joining Outlet, scoped to the result codes + tenant.
      const outletArg = mockPrisma.outlet.findMany.mock.calls.at(-1)![0];
      expect(outletArg.where.clientId).toBe('deoleo');
      expect(outletArg.where.outletCode).toEqual({ in: ['O001'] });
      expect(outletArg.select).toEqual(
        expect.objectContaining({ outletType: { select: { code: true } } }),
      );
      expect(res.outlets[0].outletType).toBe('WHOLESALER');
    });

    it('throws BadRequestException when month is not provided', async () => {
      await expect(service.getPace(admin, {} as PaceQueryDto)).rejects.toThrow(BadRequestException);
    });

    it('tenant-scopes both outletTarget and outletSalesRecord queries', async () => {
      await service.getPace(admin, { month: '2026-07' });

      const tArg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      const aArg = mockPrisma.outletSalesRecord.findMany.mock.calls[0][0];
      expect(tArg.where.clientId).toBe('deoleo');
      expect(tArg.where.month).toBe('2026-07');
      expect(aArg.where.clientId).toBe('deoleo');
      expect(aArg.where.month).toBe('2026-07');
    });

    it('optionally scopes to a single outletCode', async () => {
      await service.getPace(admin, { month: '2026-07', outletCode: 'O001' });

      const tArg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(tArg.where.outletCode).toBe('O001');
    });

    it('returns empty outlets array when no target or achievement data', async () => {
      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res).toEqual({ month: '2026-07', outlets: [] });
    });

    it('computes pace = achieved / target correctly', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 200 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 150 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBe(200);
      expect(kpi.achieved).toBe(150);
      expect(kpi.pace).toBeCloseTo(0.75);
    });

    it('CRITICAL: pace is null when target is 0 (divide-by-zero guard)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 0 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 50 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.pace).toBeNull();
    });

    it('ignores the reserved __names key (no phantom KPI in pace output)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100, __names: { MONTH_TGT: 'Diwali Combo' } },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 80 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const codes = res.outlets[0].kpis.map((k: { code: string }) => k.code);
      expect(codes).toContain('MONTH_TGT');
      expect(codes).not.toContain('__names');
    });

    it('CRITICAL: pace is null when target key is absent', async () => {
      // Target row has no MONTH_TGT key; achievement side has it
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: {},
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 80 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('includes outlets with only achievement data (target null)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 40 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res.outlets).toHaveLength(1);
      const kpi = res.outlets[0].kpis[0]!;
      expect(kpi.achieved).toBe(40);
      expect(kpi.target).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('includes outlets with only target data (achieved null, pace null)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res.outlets).toHaveLength(1);
      const kpi = res.outlets[0].kpis[0]!;
      expect(kpi.target).toBe(100);
      expect(kpi.achieved).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('handles outlet with achieved=0 and non-zero target — pace=0 (not null)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 0 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis[0]!;
      expect(kpi.achieved).toBe(0);
      expect(kpi.pace).toBe(0);  // 0 / 100 = 0, NOT null
    });

    it('results are sorted by outletCode', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'Z999', outletName: 'Z', targetValues: { MONTH_TGT: 1 } },
        { outletCode: 'A001', outletName: 'A', targetValues: { MONTH_TGT: 2 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res.outlets[0].outletCode).toBe('A001');
      expect(res.outlets[1].outletCode).toBe('Z999');
    });
  });
});

// ─── Sales Import source ownership (plan §7.4, task K-7) ──────────────────────
//
// The BYTE-IDENTICAL guard: a tenant with NO importer-owned KPI (Deoleo, every tenant today) must issue exactly the
// same writes and return exactly the same response shape as before the ownership edits.

describe('TargetsService — Sales Import ownership (K-7)', () => {
  let service: TargetsService;
  const xlsxFile = (rows: (string | number | null)[][]) =>
    ({
      buffer: buildTestXlsx(rows),
      originalname: 'test.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }) as Express.Multer.File;
  // Prisma.Sql (tagged-template $executeRaw) → text + bound values.
  const sqlText = (call: unknown[]) => {
    const q = call[0] as { strings?: readonly string[]; sql?: string } | readonly string[];
    if (Array.isArray(q)) return (q as readonly string[]).join('?');
    return (q as { strings: readonly string[] }).strings.join('?');
  };
  const sqlValues = (call: unknown[]): unknown[] => {
    if (Array.isArray(call[0])) return call.slice(1);
    return (call[0] as { values?: unknown[] }).values ?? [];
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.salesKpiDefinition.findMany.mockResolvedValue([]);
    mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
    mockPrisma.outlet.findMany.mockResolvedValue([
      { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
    ]);
    mockTx.salesUploadBatch.create.mockResolvedValue({ id: 'sales-batch-1' });
    mockTx.outletSalesRecord.upsert.mockResolvedValue({});
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockTx.$executeRaw.mockResolvedValue(1);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TargetsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SalesNotificationsService, useValue: {} },
      ],
    }).compile();
    service = module.get(TargetsService);
  });
  afterAll(() => mockPrisma.salesKpiDefinition.findMany.mockResolvedValue([]));

  describe('BYTE-IDENTICAL when the tenant owns no KPI (Deoleo)', () => {
    it('uploadAchievements: exact same upsert args, no raw SQL, no extra read, no new response key', async () => {
      const result = await service.uploadAchievements(admin, xlsxFile([['O001', 'Outlet One', 'RETAIL', 55.5, 30]]));

      expect(mockPrisma.salesKpiDefinition.findMany).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', enabled: true },
        select: { kpiCode: true },
      });
      expect(mockTx.outletSalesRecord.upsert).toHaveBeenCalledTimes(1);
      // The full pre-change argument shape, field by field (only updatedAt is a fresh Date).
      expect(mockTx.outletSalesRecord.upsert.mock.calls[0][0]).toEqual({
        where: { clientId_outletCode_month: { clientId: 'deoleo', outletCode: 'O001', month: WRITABLE_MONTH.ym } },
        create: {
          clientId: 'deoleo',
          outletCode: 'O001',
          outletName: 'Outlet One',
          month: WRITABLE_MONTH.ym,
          kpiValues: { MONTH_TGT: 55.5, FOCUS_PACK_1: 30 },
          batchId: 'sales-batch-1',
        },
        update: {
          kpiValues: { MONTH_TGT: 55.5, FOCUS_PACK_1: 30 },
          outletName: 'Outlet One',
          batchId: 'sales-batch-1',
          updatedAt: expect.any(Date),
        },
      });
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(mockPrisma.outletSalesRecord.findMany).not.toHaveBeenCalled();
      expect(Object.keys(result).sort()).toEqual(
        // Byte-identical for an all-unscoped tenant: APPLIES-TO `ignoredOutOfScope` is ABSENT unless the
        // tenant has a scoped KPI (mirrors the conditional `skippedImporterOwnedKpis`).
        // Memory-safety (2026-11-13, owner-approved platform-wide): `rows` (every parsed row) was replaced
        // by the capped problem/warning echo + skippedBlankCount.
        [
          'acceptedCount', 'batchId', 'month', 'monthsInBatch', 'rejectedCount', 'totalRows',
          'problemRows', 'problemRowCount', 'problemRowsTruncated',
          'warningRows', 'warningRowCount', 'warningRowsTruncated', 'skippedBlankCount',
        ].sort(),
      );
      expect('skippedImporterOwnedKpis' in result).toBe(false);
      expect('ignoredOutOfScope' in result).toBe(false);
    });

    it('buildAchievementTemplate: every enabled KPI keeps its column', async () => {
      const buf = await buildAchievementTemplate(admin, WRITABLE_MONTH.ym);
      const wb = XLSX.read(buf);
      const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      expect(aoa[1]).toEqual(expect.arrayContaining(['Month Target', 'Focus Pack - 1']));
    });

    it('deleteAchievementBatch: the plain cascade delete, no transaction, no raw SQL', async () => {
      mockPrisma.salesUploadBatch.findFirst.mockResolvedValue({ id: 'b1', clientId: 'deoleo', status: 'COMPLETED', acceptedCount: 4 });
      mockPrisma.salesUploadBatch.delete.mockResolvedValue({});
      await expect(service.deleteAchievementBatch(admin, 'b1')).resolves.toEqual({ deleted: true, id: 'b1', removedRecords: 4 });
      expect(mockPrisma.salesUploadBatch.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('tenant owns FOCUS_PACK_1 (importer-owned)', () => {
    beforeEach(() => mockPrisma.salesKpiDefinition.findMany.mockResolvedValue([{ kpiCode: 'FOCUS_PACK_1' }]));

    it('upload: the owned column is skipped + reported; the write keeps existing owned keys atomically', async () => {
      const result = await service.uploadAchievements(admin, xlsxFile([['O001', 'Outlet One', 'RETAIL', 10, 999]]));

      expect(result.skippedImporterOwnedKpis).toEqual(['FOCUS_PACK_1']);
      expect(mockTx.outletSalesRecord.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      const call = mockPrisma.$executeRaw.mock.calls[0];
      const sql = sqlText(call);
      expect(sql).toContain('ON CONFLICT ("clientId","outletCode","month") DO UPDATE');
      expect(sql).toContain('jsonb_each');
      const values = sqlValues(call);
      // kpiValues written = manual keys only (owned value 999 NOT written) …
      expect(values).toContain(JSON.stringify({ MONTH_TGT: 10 }));
      // Only the JSON kpiValues payloads matter — the row id is a random UUID that can contain "999" by chance.
      expect(values.some((v) => typeof v === 'string' && v.startsWith('{') && v.includes('999'))).toBe(false);
      // … and the owned list drives the carry-over of the existing row's owned keys.
      expect(values).toContainEqual(['FOCUS_PACK_1']);
      expect(values).toContain('deoleo');
    });

    it('upload without an owned column → skippedImporterOwnedKpis: []', async () => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['', '', '', WRITABLE_MONTH.label],
          ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target'],
          ['O001', 'Outlet One', 'RETAIL', 7],
        ]),
        'Targets',
      );
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), originalname: 'a.xlsx' } as Express.Multer.File;
      const result = await service.uploadAchievements(admin, file);
      expect(result.skippedImporterOwnedKpis).toEqual([]);
    });

    it('upload when EVERY enabled KPI is owned → 400 with a clear message', async () => {
      mockPrisma.salesKpiDefinition.findMany.mockResolvedValue([{ kpiCode: 'FOCUS_PACK_1' }, { kpiCode: 'MONTH_TGT' }]);
      await expect(service.uploadAchievements(admin, xlsxFile([['O001', 'O', 'RETAIL', 1, 2]]))).rejects.toThrow(/fed by Sales Import/);
    });

    it('template excludes the owned column', async () => {
      const buf = await buildAchievementTemplate(admin, WRITABLE_MONTH.ym);
      const wb = XLSX.read(buf);
      const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      expect(aoa[1]).toContain('Month Target');
      expect(aoa[1]).not.toContain('Focus Pack - 1');
    });

    it('delete a MANUAL batch: owned keys kept + re-pointed to the latest SALES_IMPORT batch, manual keys stripped', async () => {
      mockPrisma.salesUploadBatch.findFirst.mockResolvedValue({ id: 'b1', clientId: 'deoleo', status: 'COMPLETED', acceptedCount: 2 });
      mockTx.outletSalesRecord.findMany.mockResolvedValue([{ month: '2026-10' }, { month: '2026-09' }]);
      mockTx.salesUploadBatch.findFirst.mockImplementation(async ({ where }: { where: { month: string } }) =>
        where.month === '2026-10' ? { id: 'imp-batch-oct' } : null,
      );
      mockTx.salesUploadBatch.delete.mockResolvedValue({});
      // after the re-pointing, 1 of the batch's 2 rows still points at it (it held only manual data)
      mockTx.outletSalesRecord.count.mockResolvedValue(1);

      // L4: removedRecords = rows the cascade ACTUALLY removes, not the batch's acceptedCount
      await expect(service.deleteAchievementBatch(admin, 'b1')).resolves.toEqual({ deleted: true, id: 'b1', removedRecords: 1 });
      expect(mockTx.outletSalesRecord.count).toHaveBeenCalledWith({ where: { clientId: 'deoleo', batchId: 'b1' } });
      expect(mockTx.outletSalesRecord.count.mock.invocationCallOrder[0]).toBeLessThan(mockTx.salesUploadBatch.delete.mock.invocationCallOrder[0]);

      const raw = mockTx.$executeRaw.mock.calls.map((c) => ({ sql: sqlText(c), values: sqlValues(c) }));
      // advisory locks for BOTH months first (sorted), then ONE strip/re-point (Oct only — Sep was never applied)
      expect(raw[0].sql).toContain('pg_advisory_xact_lock');
      expect(raw[0].values).toEqual(['sales-month:deoleo:2026-09']);
      expect(raw[1].values).toEqual(['sales-month:deoleo:2026-10']);
      const updates = raw.filter((r) => r.sql.includes('UPDATE "outlet_sales_records"'));
      expect(updates).toHaveLength(1);
      expect(updates[0].values).toEqual(expect.arrayContaining(['imp-batch-oct', 'deoleo', 'b1', '2026-10', ['FOCUS_PACK_1']]));
      expect(mockTx.salesUploadBatch.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
      expect(mockPrisma.salesUploadBatch.delete).not.toHaveBeenCalled();
    });
  });

  it('delete a SALES_IMPORT batch → 409 (always), nothing deleted', async () => {
    mockPrisma.salesUploadBatch.findFirst.mockResolvedValue({ id: 'b9', clientId: 'deoleo', status: 'SALES_IMPORT', acceptedCount: 1 });
    await expect(service.deleteAchievementBatch(admin, 'b9')).rejects.toBeInstanceOf(ConflictException);
    expect(mockPrisma.salesUploadBatch.delete).not.toHaveBeenCalled();
  });
});
