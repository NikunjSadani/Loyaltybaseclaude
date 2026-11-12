// Unit tests for OffersAdminService — tenant scoping, flag gate, validation, audit, copy-month.
// Run: npx jest src/offers/offers-admin.service.spec.ts --no-coverage

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { OffersAdminService } from './offers-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { istDayToDate } from './offers.helpers';
import { CreateOfferTileDto } from './dto/offers.dto';

const mockPrisma = {
  offerTile: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  kpiDef: { findFirst: jest.fn(), findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $executeRaw: jest.fn(),
  $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
};
const tenantSettings = { getOutletTypes: jest.fn() };
const tenant = { resolveClient: jest.fn() };

const admin: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };
const ownerUnassumed: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '', assumed: false };
const ownerAssumed: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '', name: '', assumed: true };
const staffUnassumed: JwtPayload = { sub: 's1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '', name: '', assumed: false };
const staffAssumed: JwtPayload = { sub: 's1', role: 'GIFSY_STAFF', clientId: 'bajaj', phone: '', name: '', assumed: true };

const body: CreateOfferTileDto = {
  group: 'TARGET_REWARD',
  valueType: 'POINTS',
  valueNumber: 35,
  valueText: null,
  unitLabel: 'per case',
  product: 'ADHO 50 ml',
  label: 'Earn on every case',
  details: 'Valid on billed cases only.',
  validFrom: '2026-11-01',
  validTo: '2026-11-30',
  sortOrder: 0,
  isActive: true,
  programNames: ['Gold'],
  outletTypeCodes: ['WHOLESALER'],
  zones: [],
  states: [],
  kpiCode: 'ADHO50',
};

/** A DB row as Prisma would return it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 't1', clientId: 'bajaj', group: 'TARGET_REWARD', valueType: 'POINTS',
    valueNumber: new Prisma.Decimal('35.00'), valueText: null, unitLabel: 'per case', product: 'ADHO 50 ml',
    label: 'Earn on every case', details: null,
    validFrom: istDayToDate('2026-11-01'), validTo: istDayToDate('2026-11-30'),
    sortOrder: 0, isActive: true, programNames: [], outletTypeCodes: [], zones: [], states: [],
    kpiCode: null, copiedFromId: null, copiedToMonth: null, createdById: 'u1', updatedById: null,
    createdAt: new Date('2026-11-01T10:00:00Z'), updatedAt: new Date('2026-11-01T10:00:00Z'), deletedAt: null,
    ...over,
  };
}

describe('OffersAdminService', () => {
  let service: OffersAdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tenant.resolveClient.mockResolvedValue({ features: { offerTiles: true } });
    tenantSettings.getOutletTypes.mockResolvedValue([{ code: 'SSS' }, { code: 'WHOLESALER' }]);
    mockPrisma.kpiDef.findFirst.mockResolvedValue({ code: 'ADHO50' });
    mockPrisma.kpiDef.findMany.mockResolvedValue([]);
    mockPrisma.offerTile.create.mockImplementation(async ({ data }) => row({ ...data, id: 'new1' }));
    mockPrisma.offerTile.update.mockImplementation(async ({ data }) => row(data));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OffersAdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: tenant },
        { provide: TenantSettingsService, useValue: tenantSettings },
      ],
    }).compile();
    service = module.get(OffersAdminService);
  });

  it('1. create writes clientId/createdById/IST dates + a CREATE audit row in the same $transaction', async () => {
    const res = await service.create(admin, body);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    const data = mockPrisma.offerTile.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      clientId: 'bajaj', createdById: 'u1', group: 'TARGET_REWARD', valueNumber: 35, valueText: null,
      validFrom: istDayToDate('2026-11-01'), validTo: istDayToDate('2026-11-30'), kpiCode: 'ADHO50',
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'u1', action: 'CREATE', entityType: 'OFFER_TILE', entityId: 'new1',
        metadata: { clientId: 'bajaj' },
      }),
    });
    expect(res.tile).toMatchObject({ id: 'new1', validFrom: '2026-11-01', validTo: '2026-11-30', valueNumber: 35 });
  });

  it('1b. an ASSUMED GIFSY_ADMIN writes under the assumed tenant', async () => {
    await service.create(ownerAssumed, body);
    expect(mockPrisma.offerTile.create.mock.calls[0][0].data).toMatchObject({ clientId: 'bajaj', createdById: 'g1' });
  });

  it('2. un-assumed GIFSY_ADMIN → 400 on every route, no prisma access', async () => {
    await expect(service.create(ownerUnassumed, body)).rejects.toThrow('Assume a tenant to manage offers.');
    await expect(service.list(ownerUnassumed, '2026-11')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.segmentOptions(ownerUnassumed)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(ownerUnassumed, 't1', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove(ownerUnassumed, 't1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.copyMonth(ownerUnassumed, { fromMonth: '2026-10', toMonth: '2026-11' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
    expect(mockPrisma.offerTile.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
  });

  it('2a. un-assumed GIFSY_STAFF → the same 400 on every route; an ASSUMED staff works', async () => {
    await expect(service.create(staffUnassumed, body)).rejects.toThrow('Assume a tenant to manage offers.');
    await expect(service.list(staffUnassumed, '2026-11')).rejects.toThrow('Assume a tenant to manage offers.');
    await expect(service.segmentOptions(staffUnassumed)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(staffUnassumed, 't1', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove(staffUnassumed, 't1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.copyMonth(staffUnassumed, { fromMonth: '2026-10', toMonth: '2026-11' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenant.resolveClient).not.toHaveBeenCalled();
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
    await service.create(staffAssumed, body);
    expect(mockPrisma.offerTile.create.mock.calls[0][0].data).toMatchObject({ clientId: 'bajaj', createdById: 's1' });
  });

  it('2b. tenant flag offerTiles OFF → 403 on every route, no offer query', async () => {
    tenant.resolveClient.mockResolvedValue({ features: {} });
    await expect(service.list(admin, '2026-11')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(admin, body)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.segmentOptions(admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(admin, 't1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(admin, 't1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.copyMonth(admin, { fromMonth: '2026-10', toMonth: '2026-11' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockPrisma.offerTile.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.offerTile.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
    // fail-closed when the tenant cannot be resolved
    tenant.resolveClient.mockRejectedValue(new Error('db down'));
    await expect(service.list(admin, '2026-11')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('3. unknown kpiCode → 400; query is tenant + enabled scoped', async () => {
    mockPrisma.kpiDef.findFirst.mockResolvedValue(null);
    await expect(service.create(admin, body)).rejects.toThrow('Unknown KPI');
    expect(mockPrisma.kpiDef.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', code: 'ADHO50', enabled: true } }),
    );
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
  });

  it('4. outletTypeCodes outside the tenant set → 400', async () => {
    await expect(service.create(admin, { ...body, outletTypeCodes: ['RETAILER'] })).rejects.toThrow(/outlet type/i);
    expect(tenantSettings.getOutletTypes).toHaveBeenCalledWith('bajaj');
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
  });

  it('5. update on another tenant / deleted id → 404', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(null);
    await expect(service.update(admin, 'foreign', { label: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.offerTile.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', clientId: 'bajaj', deletedAt: null } });
    expect(mockPrisma.offerTile.update).not.toHaveBeenCalled();
  });

  it('6. update validates the MERGED row (POINTS → TEXT without valueText → 400)', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(row());
    await expect(service.update(admin, 't1', { valueType: 'TEXT' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.offerTile.update).not.toHaveBeenCalled();
  });

  it('6b. update applies a partial patch, writes updatedById + UPDATE audit', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(row());
    const res = await service.update(admin, 't1', { isActive: false });
    const call = mockPrisma.offerTile.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 't1' });
    expect(call.data).toMatchObject({ isActive: false, updatedById: 'u1', label: 'Earn on every case', valueNumber: 35 });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'UPDATE', entityType: 'OFFER_TILE', entityId: 't1', metadata: { clientId: 'bajaj' } }),
    });
    expect(res.tile.isActive).toBe(false);
  });

  it('6c. a patch that does not touch kpiCode/outletTypeCodes does not re-check them (stale refs never block a publish toggle)', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(row({ kpiCode: 'OLD', outletTypeCodes: ['RETIRED'] }));
    mockPrisma.kpiDef.findFirst.mockResolvedValue(null);
    await service.update(admin, 't1', { isActive: false });
    expect(mockPrisma.kpiDef.findFirst).not.toHaveBeenCalled();
    expect(tenantSettings.getOutletTypes).not.toHaveBeenCalled();
    // …but a patch that SETS them is checked.
    await expect(service.update(admin, 't1', { kpiCode: 'NOPE' })).rejects.toThrow('Unknown KPI');
  });

  it('6d. PUBLISHING a draft (isActive false→true) re-validates kpiCode + outletTypeCodes', async () => {
    // dead KPI (deleted or disabled → findFirst with enabled:true returns null)
    mockPrisma.offerTile.findFirst.mockResolvedValue(row({ isActive: false, kpiCode: 'OLD' }));
    mockPrisma.kpiDef.findFirst.mockResolvedValue(null);
    await expect(service.update(admin, 't1', { isActive: true })).rejects.toThrow('Unknown KPI');
    expect(mockPrisma.kpiDef.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', code: 'OLD', enabled: true } }),
    );
    // retired outlet type
    mockPrisma.offerTile.findFirst.mockResolvedValue(row({ isActive: false, outletTypeCodes: ['RETIRED'] }));
    await expect(service.update(admin, 't1', { isActive: true })).rejects.toThrow(/Unknown outlet type: RETIRED/);
    expect(mockPrisma.offerTile.update).not.toHaveBeenCalled();
    // healthy draft publishes
    mockPrisma.kpiDef.findFirst.mockResolvedValue({ code: 'ADHO50' });
    mockPrisma.offerTile.findFirst.mockResolvedValue(
      row({ isActive: false, kpiCode: 'ADHO50', outletTypeCodes: ['SSS'] }),
    );
    const res = await service.update(admin, 't1', { isActive: true });
    expect(res.tile.isActive).toBe(true);
    // an already-active tile edited without touching refs is NOT re-checked
    jest.clearAllMocks();
    mockPrisma.offerTile.update.mockImplementation(async ({ data }) => row(data));
    mockPrisma.offerTile.findFirst.mockResolvedValue(row({ isActive: true, kpiCode: 'OLD' }));
    tenant.resolveClient.mockResolvedValue({ features: { offerTiles: true } });
    await service.update(admin, 't1', { isActive: true, label: 'New' });
    expect(mockPrisma.kpiDef.findFirst).not.toHaveBeenCalled();
  });

  it('6e. explicit null on a non-nullable field → 400 (PATCH and POST), never a silent default', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(row({ isActive: false }));
    const nulls: [string, RegExp][] = [
      ['isActive', /Published can't be empty/],
      ['sortOrder', /Sort order can't be empty/],
      ['label', /Headline can't be empty/],
      ['validFrom', /Valid from can't be empty/],
      ['group', /Group can't be empty/],
      ['programNames', /empty list/],
      ['outletTypeCodes', /empty list/],
      ['zones', /empty list/],
      ['states', /empty list/],
    ];
    for (const [k, msg] of nulls) {
      await expect(service.update(admin, 't1', { [k]: null } as never)).rejects.toThrow(msg);
    }
    await expect(service.create(admin, { ...body, isActive: null } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.offerTile.update).not.toHaveBeenCalled();
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
    // nullable fields still clear with null; an empty list still means "all"
    const res = await service.update(admin, 't1', { product: null, kpiCode: null, zones: [] });
    expect(res.tile.product).toBeNull();
  });

  it('7. remove soft-deletes + DELETE audit, never hard-deletes', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(row());
    const res = await service.remove(admin, 't1');
    expect(res).toEqual({ id: 't1' });
    const call = mockPrisma.offerTile.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 't1' });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DELETE', entityType: 'OFFER_TILE', entityId: 't1' }),
    });
    expect((mockPrisma.offerTile as Record<string, unknown>).delete).toBeUndefined();
  });

  it('7b. remove of a foreign/deleted id → 404', async () => {
    mockPrisma.offerTile.findFirst.mockResolvedValue(null);
    await expect(service.remove(admin, 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('8. list queries the month overlap and maps Decimal→number, Date→YYYY-MM-DD, sorted', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([
      row({ id: 'e', group: 'EXTRA_SCHEME' }),
      row({ id: 't', valueNumber: new Prisma.Decimal('2.50'), valueType: 'PERCENT' }),
    ]);
    const res = await service.list(admin, '2026-11');
    expect(mockPrisma.offerTile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: 'bajaj', deletedAt: null,
          validFrom: { lte: istDayToDate('2026-11-30') }, validTo: { gte: istDayToDate('2026-11-01') },
        },
      }),
    );
    expect(res.month).toBe('2026-11');
    expect(res.tiles.map((t) => t.id)).toEqual(['t', 'e']);
    expect(res.tiles[0].valueNumber).toBe(2.5);
    expect(res.tiles[0].validFrom).toBe('2026-11-01');
    expect(res.tiles[0].createdAt).toBe('2026-11-01T10:00:00.000Z');
    expect(Object.keys(res.tiles[0])).toEqual([
      'id', 'group', 'valueType', 'valueNumber', 'valueText', 'unitLabel', 'product', 'label', 'details',
      'validFrom', 'validTo', 'sortOrder', 'isActive', 'programNames', 'outletTypeCodes', 'zones', 'states',
      'kpiCode', 'copiedFromId', 'copiedToMonth', 'createdAt', 'updatedAt',
    ]);
  });

  it('9. copyMonth creates drafts, skips already-copied sources, rejects from===to', async () => {
    await expect(service.copyMonth(admin, { fromMonth: '2026-11', toMonth: '2026-11' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    mockPrisma.offerTile.findMany
      .mockResolvedValueOnce([row({ id: 's1', validFrom: istDayToDate('2026-10-05'), validTo: istDayToDate('2026-10-20') }), row({ id: 's2' })])
      .mockResolvedValueOnce([{ copiedFromId: 's2' }]);
    const res = await service.copyMonth(admin, { fromMonth: '2026-10', toMonth: '2026-11' });
    // source query: validFrom inside October
    expect(mockPrisma.offerTile.findMany.mock.calls[0][0].where).toEqual({
      clientId: 'bajaj', deletedAt: null,
      validFrom: { gte: istDayToDate('2026-10-01'), lte: istDayToDate('2026-10-31') },
    });
    // already-copied query: keyed on copiedToMonth (NOT the editable validFrom)
    expect(mockPrisma.offerTile.findMany.mock.calls[1][0].where).toEqual({
      clientId: 'bajaj', deletedAt: null, copiedFromId: { in: ['s1', 's2'] }, copiedToMonth: '2026-11',
    });
    expect(mockPrisma.$executeRaw).toHaveBeenCalled(); // advisory lock against a double-click race
    expect(mockPrisma.offerTile.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.offerTile.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      clientId: 'bajaj', isActive: false, copiedFromId: 's1', copiedToMonth: '2026-11', createdById: 'u1',
      validFrom: istDayToDate('2026-11-01'), validTo: istDayToDate('2026-11-30'),
      label: 'Earn on every case',
    });
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.tiles).toHaveLength(1);
    expect(res.tiles[0].copiedToMonth).toBe('2026-11');
    expect(res.kpiCleared).toEqual([]);
    expect(res.unknownOutletTypes).toEqual([]);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CREATE', entityType: 'OFFER_TILE', entityId: 'copy:2026-10→2026-11',
        metadata: expect.objectContaining({ clientId: 'bajaj', createdIds: ['new1'] }),
      }),
    });
  });

  it('9b. copyMonth idempotency survives an edited validFrom (a moved copy is still "already copied")', async () => {
    // The copy of s1 was moved to start in December — but it is still tagged copiedToMonth=2026-11.
    mockPrisma.offerTile.findMany
      .mockResolvedValueOnce([row({ id: 's1', validFrom: istDayToDate('2026-10-05') })])
      .mockImplementationOnce(async ({ where }) =>
        where.copiedToMonth === '2026-11' ? [{ copiedFromId: 's1' }] : [],
      );
    const res = await service.copyMonth(admin, { fromMonth: '2026-10', toMonth: '2026-11' });
    expect(res).toMatchObject({ created: 0, skipped: 1 });
    expect(mockPrisma.offerTile.create).not.toHaveBeenCalled();
  });

  it('9c. copyMonth: dead KPI → copy gets kpiCode=null + reported; unknown outlet type → kept + reported', async () => {
    mockPrisma.offerTile.findMany
      .mockResolvedValueOnce([
        row({ id: 's1', kpiCode: 'GONE' }),
        row({ id: 's2', kpiCode: 'ADHO50', outletTypeCodes: ['RETIRED', 'SSS'] }),
        row({ id: 's3', kpiCode: null, outletTypeCodes: ['sss'] }),
      ])
      .mockResolvedValueOnce([]);
    mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'ADHO50' }]);
    let n = 0;
    mockPrisma.offerTile.create.mockImplementation(async ({ data }) => row({ ...data, id: `c${++n}` }));
    const res = await service.copyMonth(admin, { fromMonth: '2026-10', toMonth: '2026-11' });
    expect(mockPrisma.kpiDef.findMany).toHaveBeenCalledWith({
      where: { clientId: 'bajaj', code: { in: ['GONE', 'ADHO50'] }, enabled: true },
      select: { code: true },
    });
    const datas = mockPrisma.offerTile.create.mock.calls.map((c) => c[0].data);
    expect(datas.map((d) => d.kpiCode)).toEqual([null, 'ADHO50', null]);
    // outlet types are NEVER rewritten (dropping one could widen the audience to "all")
    expect(datas[1].outletTypeCodes).toEqual(['RETIRED', 'SSS']);
    expect(datas.every((d) => d.isActive === false)).toBe(true);
    expect(res.kpiCleared).toEqual(['c1']);
    expect(res.unknownOutletTypes).toEqual(['c2']);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ kpiCleared: ['c1'], unknownOutletTypes: ['c2'] }),
      }),
    });
  });

  it('10. segmentOptions returns distinct, trimmed, sorted, non-null values (first-seen spelling)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([
      { programName: ' Gold ', zone: 'North', state: 'Maharashtra' },
      { programName: 'gold', zone: null, state: 'Gujarat' },
      { programName: 'Silver', zone: '  ', state: 'maharashtra' },
      { programName: null, zone: 'East', state: 'Gujarat' },
    ]);
    const res = await service.segmentOptions(admin);
    expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', deletedAt: null } }),
    );
    expect(res).toEqual({
      programNames: ['Gold', 'Silver'],
      zones: ['East', 'North'],
      states: ['Gujarat', 'Maharashtra'],
    });
  });
});
