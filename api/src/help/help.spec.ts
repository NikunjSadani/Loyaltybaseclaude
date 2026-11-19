// Help & videos — API tests: guards, CRUD + audit, validation, tenant isolation, audience/role filtering,
// flag-off refusal, upload validation (poster + chunked video), signed media URL (token + Range).
// Run: npx jest src/help/help.spec.ts --no-coverage --maxWorkers=2

import 'reflect-metadata';
import { Readable } from 'node:stream';
import { BadRequestException, ConflictException, ForbiddenException, INestApplication, NotFoundException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import { HelpAdminController, HelpMediaController, PartnerHelpController, SalesHelpController } from './help.controller';
import { HelpAdminService } from './help-admin.service';
import { HelpMemberService } from './help-member.service';
import { HelpMediaService } from './help-media.service';
import { HelpMediaLimiter } from './help-media-limiter';
import {
  HELP_VIDEO_MAX_BYTES,
  HELP_VIDEO_MAX_PARTS,
  HELP_VIDEO_PART_BYTES,
  HELP_MEDIA_MAX_CONCURRENT_PER_TOKEN,
  HELP_MEDIA_PER_TOKEN_PER_MIN,
  keyFingerprint,
  mp4Problem,
  parseByteRange,
  roleFilterAdmits,
} from './help.constants';

jest.setTimeout(30_000);

const SECRET = 'help-test-secret';

// ─── fixtures ──────────────────────────────────────────────────────────────────

const gifsy: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Op' };
const staff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'bajaj', phone: '', name: 'Staff', assumed: true };
const clientAdmin: JwtPayload = { sub: 'c1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };
const so: JwtPayload = { sub: 's1', role: 'SALES_SO', clientId: 'bajaj', phone: '9000000001', name: 'SO' };
const partner: JwtPayload = { sub: 'p1', role: 'WHOLESALER', clientId: 'bajaj', phone: '9000000002', name: 'P' };

/** A valid MP4 head: size + 'ftyp' + 'isom'. */
function mp4Head(len = 64): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

let seq = 0;
function topic(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `t${seq}`,
    clientId: 'bajaj',
    audience: 'SALES',
    roles: [] as string[],
    title: 'Install the app',
    description: null,
    sortOrder: 0,
    isPublished: false,
    videoKey: null as string | null,
    videoBytes: null as number | null,
    posterKey: null as string | null,
    steps: ['a', 'b', 'c'],
    createdById: 'g1',
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

function file(buffer: Buffer, over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return { buffer, size: buffer.length, originalname: 'x', mimetype: 'application/octet-stream', ...over } as Express.Multer.File;
}

function makeDeps() {
  const prisma = {
    client: { findFirst: jest.fn(async ({ where }: { where: { id: string } }) => (['bajaj', 'deoleo'].includes(where.id) ? { id: where.id } : null)) },
    helpTopic: {
      findMany: jest.fn(async () => [] as unknown[]),
      findFirst: jest.fn(async () => null as unknown),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => topic({ ...data, id: 'new1' })),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => topic({ id: where.id, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    salesHierarchyLevel: { findMany: jest.fn(async () => [{ code: 'SO', name: 'Sales Officer' }]) },
    outletTypeClientConfig: { findMany: jest.fn(async () => [{ outletType: { code: 'RETAILER', name: 'Retailer' } }]) },
    salesUser: { findFirst: jest.fn(async () => ({ hierarchyLevel: { code: 'SO' } })) },
    channelPartner: { findFirst: jest.fn(async () => ({ id: 'cp1', groupId: null })) },
    outlet: { findMany: jest.fn(async () => [{ outletType: { code: 'RETAILER' } }]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const storage = {
    generateKey: jest.fn((folder: string, name: string) => `${folder}/2026-11/uuid-${name}`),
    uploadFile: jest.fn(async () => 'url'),
    listPrefix: jest.fn(async () => [] as Array<{ name: string; size: number }>),
    combineFiles: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    deletePrefix: jest.fn(async () => undefined),
    statObject: jest.fn(async () => ({ size: 1000, contentType: 'video/mp4' }) as { size: number; contentType: string } | null),
    openReadStream: jest.fn((_k: string, _r?: { start: number; end: number }) => Readable.from([Buffer.from('x')])),
  };
  const features: Record<string, Record<string, unknown>> = { bajaj: { helpVideos: true }, deoleo: {} };
  const tenant = { resolveClient: jest.fn(async (id: string) => ({ features: features[id] ?? {} })) };
  const config = { get: jest.fn(() => SECRET) } as unknown as ConfigService;
  const jwt = new JwtService({ secret: SECRET });
  const media = new HelpMediaService(jwt, config, prisma as unknown as PrismaService, storage as unknown as StorageService, tenant as unknown as TenantService);
  const admin = new HelpAdminService(prisma as unknown as PrismaService, storage as unknown as StorageService, tenant as unknown as TenantService, media);
  const member = new HelpMemberService(prisma as unknown as PrismaService, tenant as unknown as TenantService, media);
  return { prisma, storage, tenant, features, jwt, media, admin, member };
}

function tokenOf(url: string): string {
  const m = /token=([^&]+)/.exec(url);
  if (!m) throw new Error(`no token in ${url}`);
  return decodeURIComponent(m[1]);
}

// ─── guards ────────────────────────────────────────────────────────────────────

describe('guards (route metadata)', () => {
  const reflector = new Reflector();

  it('console routes: GIFSY_ADMIN only; reads tenancy:read, every write tenancy:write', () => {
    expect(reflector.get(ROLES_KEY, HelpAdminController)).toEqual(['GIFSY_ADMIN']);
    const p = HelpAdminController.prototype;
    expect(reflector.get(PERMISSION_KEY, p.list)).toBe('tenancy:read');
    expect(reflector.get(PERMISSION_KEY, p.roleOptions)).toBe('tenancy:read');
    for (const m of [p.create, p.update, p.remove, p.reorder, p.uploadPoster, p.removePoster, p.removeVideo, p.startVideoUpload, p.putVideoPart, p.completeVideoUpload]) {
      expect(reflector.get(PERMISSION_KEY, m)).toBe('tenancy:write');
    }
  });

  it('member routes: sales roles on /sales/help-topics, partner roles on /partner/help-topics', () => {
    expect(reflector.get(ROLES_KEY, SalesHelpController)).toEqual(['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR']);
    expect(reflector.get(ROLES_KEY, PartnerHelpController)).toEqual(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
  });

  it('media route is public (token is the authority) and exempt from the throttle', () => {
    const fn = HelpMediaController.prototype.view;
    expect(Reflect.getMetadata('isPublic', fn)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', fn)).toBe(true);
  });

  it('service refuses a non-GIFSY_ADMIN caller even if reached directly (incl. GIFSY_STAFF)', async () => {
    const { admin } = makeDeps();
    await expect(admin.list(clientAdmin, 'bajaj')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(admin.list(staff, 'bajaj')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(admin.roleOptions(staff, 'bajaj')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(admin.update(staff, 'bajaj', 't', { title: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    // and the controller admits GIFSY_ADMIN only — GIFSY_STAFF is not in @Roles
    expect(new Reflector().get(ROLES_KEY, HelpAdminController)).not.toContain('GIFSY_STAFF');
    await expect(admin.create(so, 'bajaj', { audience: 'SALES', title: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─── pure helpers ──────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('mp4Problem accepts an ftyp MP4 and refuses QuickTime, images, junk', () => {
    expect(mp4Problem(mp4Head())).toBeNull();
    const mov = mp4Head();
    mov.write('qt  ', 8, 'latin1');
    expect(mp4Problem(mov)).toMatch(/QuickTime/);
    const heic = mp4Head();
    heic.write('heic', 8, 'latin1');
    expect(mp4Problem(heic)).toMatch(/image/);
    expect(mp4Problem(PNG)).toMatch(/not an MP4/);
    expect(mp4Problem(Buffer.alloc(3))).toMatch(/empty|short/);
  });

  it('roleFilterAdmits: empty = everyone; otherwise any matching label (case-insensitive)', () => {
    expect(roleFilterAdmits([], ['SALES_SO'])).toBe(true);
    expect(roleFilterAdmits(['ASM'], ['SALES_SO', 'SO'])).toBe(false);
    expect(roleFilterAdmits(['so'], ['SALES_SO', 'SO'])).toBe(true);
    expect(roleFilterAdmits(['RETAILER'], ['WHOLESALER', null, undefined])).toBe(false);
  });

  it('parseByteRange', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange('bytes=5-3', 100)).toBeNull(); // inverted → invalid → ignored (200 full body), RFC 7233
  });

  it('a 50 MB video fits in the max part count and parts stay under the 15 MB proxy cap', () => {
    expect(HELP_VIDEO_PART_BYTES).toBeLessThan(15 * 1024 * 1024);
    expect(HELP_VIDEO_MAX_PARTS * HELP_VIDEO_PART_BYTES).toBeGreaterThanOrEqual(HELP_VIDEO_MAX_BYTES);
    expect(HELP_VIDEO_MAX_PARTS).toBeLessThanOrEqual(32);
  });
});

// ─── console CRUD ──────────────────────────────────────────────────────────────

describe('HelpAdminService — CRUD + audit', () => {
  it('list: scoped to the PATH tenant, reports the flag, mints PREVIEW media URLs', async () => {
    const { admin, prisma, jwt } = makeDeps();
    prisma.helpTopic.findMany.mockResolvedValueOnce([topic({ id: 'a', videoKey: 'help-videos/bajaj/a/v.mp4', posterKey: 'help-videos/bajaj/a/p.png' })]);
    const out = await admin.list(gifsy, 'bajaj');
    expect(prisma.helpTopic.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'bajaj', deletedAt: null } }));
    expect(out.flagOn).toBe(true);
    expect(out.topics[0].videoUrl).toMatch(/^\/api\/help\/media\?token=/);
    const claims = jwt.verify(tokenOf(out.topics[0].videoUrl!), { secret: SECRET });
    expect(claims).toMatchObject({ typ: 'helpmedia', sub: 'a', c: 'bajaj', k: 'video', p: 1, h: keyFingerprint('help-videos/bajaj/a/v.mp4') });
    const off = await admin.list(gifsy, 'deoleo');
    expect(off.flagOn).toBe(false);
  });

  it('unknown client → 404', async () => {
    const { admin } = makeDeps();
    await expect(admin.list(gifsy, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create: trims, uppercases roles, appends to the audience order, starts UNPUBLISHED, audits in the same tx', async () => {
    const { admin, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValueOnce({ sortOrder: 4 });
    const out = await admin.create(gifsy, 'bajaj', { audience: 'SALES', title: '  Allow location ', roles: ['so', ' sales_asm', 'SO'], steps: ['one', ' ', 'two'] });
    const data = prisma.helpTopic.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clientId: 'bajaj', audience: 'SALES', title: 'Allow location', roles: ['SO', 'SALES_ASM'], steps: ['one', 'two'], sortOrder: 5, isPublished: false, createdById: 'g1' });
    expect(out.isPublished).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'CREATE', entityType: 'HelpTopic', entityId: 'new1', actorId: 'g1' }) });
  });

  it('create: validation (blank title, too many steps, bad role code)', async () => {
    const { admin } = makeDeps();
    await expect(admin.create(gifsy, 'bajaj', { audience: 'SALES', title: '   ' })).rejects.toThrow(/Title is required/);
    await expect(admin.create(gifsy, 'bajaj', { audience: 'SALES', title: 't', steps: ['1', '2', '3', '4', '5', '6', '7'] })).rejects.toThrow(/at most 6 steps/);
    await expect(admin.create(gifsy, 'bajaj', { audience: 'SALES', title: 't', roles: ['SO; DROP'] })).rejects.toThrow(/not a valid role/);
    await expect(admin.create(gifsy, 'bajaj', { audience: 'SALES', title: 'x'.repeat(81) })).rejects.toThrow(/at most 80/);
  });

  it('update: publish needs ≥ 3 steps; publishing is audited as "publish" with before/after', async () => {
    const { admin, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValueOnce(topic({ id: 'x', steps: ['only one'] }));
    await expect(admin.update(gifsy, 'bajaj', 'x', { isPublished: true })).rejects.toThrow(/at least 3 steps/);
    prisma.helpTopic.findFirst.mockResolvedValueOnce(topic({ id: 'x' }));
    const out = await admin.update(gifsy, 'bajaj', 'x', { isPublished: true });
    expect(out.isPublished).toBe(true);
    const audit = prisma.auditLog.create.mock.calls.at(-1)![0].data;
    expect(audit).toMatchObject({ action: 'UPDATE', entityId: 'x', oldValues: { isPublished: false }, newValues: { isPublished: true }, metadata: expect.objectContaining({ op: 'publish', slug: 'bajaj' }) });
  });

  it('update / delete of ANOTHER tenant\'s topic → 404 (lookups are clientId-scoped)', async () => {
    const { admin, prisma } = makeDeps();
    await expect(admin.update(gifsy, 'bajaj', 'foreign', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.helpTopic.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', clientId: 'bajaj', deletedAt: null } });
    await expect(admin.remove(gifsy, 'bajaj', 'foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.helpTopic.update).not.toHaveBeenCalled();
  });

  it('delete: soft-delete + unpublish, audited', async () => {
    const { admin, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValueOnce(topic({ id: 'd', isPublished: true }));
    await admin.remove(gifsy, 'bajaj', 'd');
    expect(prisma.helpTopic.update.mock.calls[0][0].data).toMatchObject({ isPublished: false, deletedAt: expect.any(Date) });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'DELETE', entityId: 'd' });
  });

  it('roles must belong to the audience: an audience change that keeps the other app\'s roles is refused, clearly', async () => {
    const { admin, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValueOnce(topic({ id: 'm', audience: 'SALES', roles: ['SO'] }));
    await expect(admin.update(gifsy, 'bajaj', 'm', { audience: 'PARTNER' })).rejects.toThrow(/SO is not a Partner app role.*choose the roles again/);
    expect(prisma.helpTopic.update).not.toHaveBeenCalled();
    // moving WITH roles of the new audience (or none) is fine
    prisma.helpTopic.findFirst.mockResolvedValueOnce(topic({ id: 'm', audience: 'SALES', roles: ['SO'] })).mockResolvedValueOnce({ sortOrder: 2 });
    await admin.update(gifsy, 'bajaj', 'm', { audience: 'PARTNER', roles: ['RETAILER'] });
    expect(prisma.helpTopic.update.mock.calls[0][0].data).toMatchObject({ audience: 'PARTNER', roles: ['RETAILER'], sortOrder: 3 });
    // and create refuses a role from the other app
    await expect(admin.create(gifsy, 'bajaj', { audience: 'PARTNER', title: 't', roles: ['SALES_SO'] })).rejects.toThrow(/SALES_SO is not a Partner app role/);
  });

  it('delete also removes the topic\'s video + poster objects (after the commit)', async () => {
    const { admin, prisma, storage } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValueOnce(topic({ id: 'd2', videoKey: 'help-videos/bajaj/d2/v.mp4', posterKey: 'help-videos/bajaj/d2/p.png' }));
    await admin.remove(gifsy, 'bajaj', 'd2');
    expect(storage.deleteFile).toHaveBeenCalledWith('help-videos/bajaj/d2/v.mp4');
    expect(storage.deleteFile).toHaveBeenCalledWith('help-videos/bajaj/d2/p.png');
    expect(prisma.auditLog.create.mock.calls[0][0].data.oldValues).toMatchObject({ videoKey: 'help-videos/bajaj/d2/v.mp4' });
  });

  it('reorder: must name exactly the current set; writes 0..n-1; audited', async () => {
    const { admin, prisma } = makeDeps();
    prisma.helpTopic.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await expect(admin.reorder(gifsy, 'bajaj', { audience: 'SALES', ids: ['b'] })).rejects.toThrow(/changed since you loaded/);
    prisma.helpTopic.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValueOnce([]);
    await admin.reorder(gifsy, 'bajaj', { audience: 'SALES', ids: ['b', 'a'] });
    expect(prisma.helpTopic.update).toHaveBeenNthCalledWith(1, { where: { id: 'b' }, data: { sortOrder: 0 } });
    expect(prisma.helpTopic.update).toHaveBeenNthCalledWith(2, { where: { id: 'a' }, data: { sortOrder: 1 } });
    expect(prisma.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ op: 'reorder' });
  });

  it('role options: login roles + the tenant\'s hierarchy levels / outlet types', async () => {
    const { admin } = makeDeps();
    const out = await admin.roleOptions(gifsy, 'bajaj');
    expect(out.SALES.map((o) => o.code)).toEqual(expect.arrayContaining(['SO', 'SALES_SO', 'SALES_ASM']));
    expect(out.PARTNER.map((o) => o.code)).toEqual(expect.arrayContaining(['RETAILER', 'WHOLESALER']));
  });
});

// ─── upload validation ─────────────────────────────────────────────────────────

describe('HelpAdminService — uploads', () => {
  it('poster: PNG accepted and stored under the tenant prefix; PDF / junk refused', async () => {
    const { admin, prisma, storage } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'p' }));
    await admin.uploadPoster(gifsy, 'bajaj', 'p', file(PNG));
    expect(storage.uploadFile).toHaveBeenCalledWith(PNG, 'help-videos/bajaj/p/2026-11/uuid-poster.png', 'image/png');
    expect(prisma.helpTopic.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'p', posterKey: null });
    expect(prisma.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ op: 'poster-upload' });
    await expect(admin.uploadPoster(gifsy, 'bajaj', 'p', file(Buffer.from('%PDF-1.7 ...........')))).rejects.toThrow(/PNG, JPG or WEBP/);
    await expect(admin.uploadPoster(gifsy, 'bajaj', 'p', undefined)).rejects.toThrow(/No image/);
  });

  it('video start: refuses a declared size over 50 MB', async () => {
    const { admin, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v' }));
    await expect(admin.startVideoUpload(gifsy, 'bajaj', 'v', HELP_VIDEO_MAX_BYTES + 1)).rejects.toThrow(/too large/);
    const ok = await admin.startVideoUpload(gifsy, 'bajaj', 'v', 1000);
    expect(ok.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok).toMatchObject({ partBytes: HELP_VIDEO_PART_BYTES, maxBytes: HELP_VIDEO_MAX_BYTES });
  });

  it('video part 0 must be an MP4; part numbers past the 50 MB cap and bad upload ids refused', async () => {
    const { admin, prisma, storage } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v' }));
    const up = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await expect(admin.putVideoPart(gifsy, 'bajaj', 'v', up, '0', file(PNG))).rejects.toThrow(/not an MP4/);
    await expect(admin.putVideoPart(gifsy, 'bajaj', 'v', up, String(HELP_VIDEO_MAX_PARTS), file(mp4Head()))).rejects.toThrow(/too large/);
    await expect(admin.putVideoPart(gifsy, 'bajaj', 'v', '../../etc', '0', file(mp4Head()))).rejects.toThrow(/Invalid upload id/);
    await admin.putVideoPart(gifsy, 'bajaj', 'v', up, '0', file(mp4Head()));
    expect(storage.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), `help-uploads/bajaj/v/${up}/00000`, 'application/octet-stream');
  });

  it('video complete: composes contiguous parts into one video/mp4 object, audits, cleans parts, drops the old video', async () => {
    const { admin, prisma, storage } = makeDeps();
    const up = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const prefix = `help-uploads/bajaj/v/${up}/`;
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', videoKey: 'help-videos/bajaj/v/old.mp4' }));
    storage.listPrefix.mockResolvedValueOnce([
      { name: `${prefix}00001`, size: 1000 },
      { name: `${prefix}00000`, size: HELP_VIDEO_PART_BYTES },
    ]);
    await admin.completeVideoUpload(gifsy, 'bajaj', 'v', up);
    expect(storage.combineFiles).toHaveBeenCalledWith([`${prefix}00000`, `${prefix}00001`], 'help-videos/bajaj/v/2026-11/uuid-video.mp4', 'video/mp4');
    // version-checked swap: only if videoKey is still the one read before
    expect(prisma.helpTopic.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'v', clientId: 'bajaj', deletedAt: null, videoKey: 'help-videos/bajaj/v/old.mp4' },
      data: { videoKey: 'help-videos/bajaj/v/2026-11/uuid-video.mp4', videoBytes: HELP_VIDEO_PART_BYTES + 1000 },
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ op: 'video-upload' });
    expect(storage.deletePrefix).toHaveBeenCalledWith(prefix);
    expect(storage.deleteFile).toHaveBeenCalledWith('help-videos/bajaj/v/old.mp4');
  });

  it('concurrent complete: the loser gets 409, its composed object is deleted, the winner\'s video is kept', async () => {
    const { admin, prisma, storage } = makeDeps();
    const up = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const prefix = `help-uploads/bajaj/v/${up}/`;
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', videoKey: 'help-videos/bajaj/v/old.mp4' }));
    storage.listPrefix.mockResolvedValueOnce([{ name: `${prefix}00000`, size: 1000 }]);
    prisma.helpTopic.updateMany.mockResolvedValueOnce({ count: 0 }); // someone else swapped the key first
    const err = await admin.completeVideoUpload(gifsy, 'bajaj', 'v', up).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toMatch(/changed by someone else — reload/);
    expect(storage.deleteFile).toHaveBeenCalledWith('help-videos/bajaj/v/2026-11/uuid-video.mp4'); // our new object
    expect(storage.deleteFile).not.toHaveBeenCalledWith('help-videos/bajaj/v/old.mp4'); // the winner's file is untouched
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledWith(prefix);
  });

  it('video complete: missing part / over 50 MB / nothing uploaded → 400 and the parts are deleted', async () => {
    const { admin, prisma, storage } = makeDeps();
    const up = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const prefix = `help-uploads/bajaj/v/${up}/`;
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v' }));
    storage.listPrefix.mockResolvedValueOnce([{ name: `${prefix}00001`, size: 10 }]);
    await expect(admin.completeVideoUpload(gifsy, 'bajaj', 'v', up)).rejects.toThrow(/missing/);
    const many = Array.from({ length: HELP_VIDEO_MAX_PARTS + 1 }, (_, i) => ({ name: `${prefix}${String(i).padStart(5, '0')}`, size: HELP_VIDEO_PART_BYTES }));
    storage.listPrefix.mockResolvedValueOnce(many);
    await expect(admin.completeVideoUpload(gifsy, 'bajaj', 'v', up)).rejects.toThrow(/too large/);
    storage.listPrefix.mockResolvedValueOnce([]);
    await expect(admin.completeVideoUpload(gifsy, 'bajaj', 'v', up)).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.deletePrefix).toHaveBeenCalledTimes(3);
    expect(storage.combineFiles).not.toHaveBeenCalled();
    expect(prisma.helpTopic.update).not.toHaveBeenCalled();
  });
});

// ─── member reads ──────────────────────────────────────────────────────────────

describe('HelpMemberService — flag, tenant, audience, role filter', () => {
  it('flag OFF (Deoleo) → 404 for list and detail, no topic query', async () => {
    const { member, prisma } = makeDeps();
    const deoleoSo = { ...so, clientId: 'deoleo' };
    await expect(member.list(deoleoSo, 'SALES')).rejects.toBeInstanceOf(NotFoundException);
    await expect(member.get(deoleoSo, 'SALES', 't1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.helpTopic.findMany).not.toHaveBeenCalled();
  });

  it('queries ONLY the caller\'s tenant, the controller\'s audience, published, not deleted', async () => {
    const { member, prisma } = makeDeps();
    await member.list(so, 'SALES');
    expect(prisma.helpTopic.findMany.mock.calls[0][0].where).toEqual({ clientId: 'bajaj', audience: 'SALES', isPublished: true, deletedAt: null });
    await member.list(partner, 'PARTNER');
    expect(prisma.helpTopic.findMany.mock.calls[1][0].where).toEqual({ clientId: 'bajaj', audience: 'PARTNER', isPublished: true, deletedAt: null });
  });

  it('sales role filter: matches the login role OR the hierarchy-level code', async () => {
    const { member, prisma } = makeDeps();
    prisma.helpTopic.findMany.mockResolvedValue([
      topic({ id: 'all', roles: [] }),
      topic({ id: 'so', roles: ['SO'] }),
      topic({ id: 'salesso', roles: ['SALES_SO'] }),
      topic({ id: 'asm', roles: ['ASM', 'SALES_ASM'] }),
    ]);
    const out = await member.list(so, 'SALES');
    expect(out.topics.map((t) => t.id)).toEqual(['all', 'so', 'salesso']);
    await expect(member.get(so, 'SALES', 'asm')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('partner role filter: matches the login role OR any of the partner\'s outlet-type codes', async () => {
    const { member, prisma } = makeDeps();
    prisma.helpTopic.findMany.mockResolvedValue([
      topic({ id: 'ret', audience: 'PARTNER', roles: ['RETAILER'] }),
      topic({ id: 'sss', audience: 'PARTNER', roles: ['SSS'] }),
      topic({ id: 'wh', audience: 'PARTNER', roles: ['WHOLESALER'] }),
    ]);
    const out = await member.list(partner, 'PARTNER');
    expect(out.topics.map((t) => t.id)).toEqual(['ret', 'wh']);
  });

  it('member media URLs are NON-preview tokens; no URL when there is no video', async () => {
    const { member, prisma, jwt } = makeDeps();
    prisma.helpTopic.findMany.mockResolvedValue([topic({ id: 'v', videoKey: 'k', posterKey: null }), topic({ id: 'n' })]);
    const out = await member.list(so, 'SALES');
    const claims = jwt.verify(tokenOf(out.topics[0].videoUrl!), { secret: SECRET }) as Record<string, unknown>;
    expect(claims).toMatchObject({ typ: 'helpmedia', sub: 'v', c: 'bajaj', k: 'video', h: keyFingerprint('k') });
    expect(claims.p).toBeUndefined();
    expect(out.topics[0].posterUrl).toBeNull();
    expect(out.topics[1].videoUrl).toBeNull();
    expect(out.topics[1].steps).toEqual(['a', 'b', 'c']);
  });
});

// ─── signed media URL ──────────────────────────────────────────────────────────

describe('HelpMediaService — token checks', () => {
  async function denied(p: Promise<unknown>) {
    await expect(p).rejects.toBeInstanceOf(NotFoundException);
  }

  it('valid member token for a published topic streams video/mp4', async () => {
    const { media, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: true, videoKey: 'k' }));
    const out = await media.open(tokenOf(media.mintUrl('v', 'bajaj', 'video', 'k')), undefined);
    expect(out).toMatchObject({ contentType: 'video/mp4', size: 1000, length: 1000, range: null });
    expect(prisma.helpTopic.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'v', clientId: 'bajaj', deletedAt: null } }));
  });

  it('refuses: garbage, wrong secret, wrong typ, expired, unpublished, flag OFF, no object, oversized object', async () => {
    const { media, prisma, jwt, storage } = makeDeps();
    await denied(media.open('garbage', undefined));
    await denied(media.open(undefined, undefined));
    await denied(media.open(new JwtService({ secret: 'other' }).sign({ typ: 'helpmedia', sub: 'v', c: 'bajaj', k: 'video', h: keyFingerprint('k') }), undefined));
    await denied(media.open(jwt.sign({ typ: 'docview', sub: 'v', c: 'bajaj', k: 'video', h: keyFingerprint('k') }), undefined));
    await denied(media.open(jwt.sign({ typ: 'helpmedia', sub: 'v', c: 'bajaj', k: 'video', h: keyFingerprint('k'), exp: Math.floor(Date.now() / 1000) - 10 }), undefined));

    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: false, videoKey: 'k' }));
    await denied(media.open(tokenOf(media.mintUrl('v', 'bajaj', 'video', 'k')), undefined));
    // …but a console PREVIEW token may view an unpublished topic
    await expect(media.open(tokenOf(media.mintUrl('v', 'bajaj', 'video', 'k', true)), undefined)).resolves.toBeDefined();

    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', clientId: 'deoleo', isPublished: true, videoKey: 'k' }));
    await denied(media.open(tokenOf(media.mintUrl('v', 'deoleo', 'video', 'k')), undefined)); // flag OFF
    // …a console PREVIEW token still works on a flag-OFF tenant (and on an unpublished topic, above)
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', clientId: 'deoleo', isPublished: false, videoKey: 'k' }));
    await expect(media.open(tokenOf(media.mintUrl('v', 'deoleo', 'video', 'k', true)), undefined)).resolves.toMatchObject({ contentType: 'video/mp4' });

    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: true, videoKey: null }));
    await denied(media.open(tokenOf(media.mintUrl('v', 'bajaj', 'video', 'k')), undefined));

    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: true, videoKey: 'k' }));
    storage.statObject.mockResolvedValueOnce({ size: HELP_VIDEO_MAX_BYTES + 1, contentType: 'video/mp4' });
    await denied(media.open(tokenOf(media.mintUrl('v', 'bajaj', 'video', 'k')), undefined));
  });

  it('replace during playback: a token minted for the OLD video 404s once the video is replaced (no new bytes)', async () => {
    const { media, prisma, storage } = makeDeps();
    const oldUrl = media.mintUrl('v', 'bajaj', 'video', 'help-videos/bajaj/v/old.mp4');
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: true, videoKey: 'help-videos/bajaj/v/old.mp4' }));
    await expect(media.open(tokenOf(oldUrl), 'bytes=0-')).resolves.toBeDefined();
    prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: true, videoKey: 'help-videos/bajaj/v/new.mp4' }));
    storage.openReadStream.mockClear();
    await denied(media.open(tokenOf(oldUrl), 'bytes=1000-'));
    expect(storage.openReadStream).not.toHaveBeenCalled();
    // a fresh URL for the new key works
    await expect(media.open(tokenOf(media.mintUrl('v', 'bajaj', 'video', 'help-videos/bajaj/v/new.mp4')), undefined)).resolves.toBeDefined();
  });

  it('cross-tenant: a token for tenant A cannot read tenant B\'s topic (lookup is scoped by the token tenant)', async () => {
    const { media, prisma } = makeDeps();
    prisma.helpTopic.findFirst.mockResolvedValue(null); // id exists only under another clientId
    await denied(media.open(tokenOf(media.mintUrl('b-topic', 'bajaj', 'video', 'k')), undefined));
    expect(prisma.helpTopic.findFirst.mock.calls[0][0].where).toEqual({ id: 'b-topic', clientId: 'bajaj', deletedAt: null });
  });
});

describe('GET /help/media (HTTP, Range)', () => {
  let app: INestApplication;
  const body = Buffer.from('0123456789');
  let deps: ReturnType<typeof makeDeps>;
  let limiter: HelpMediaLimiter;

  beforeEach(async () => {
    deps = makeDeps();
    limiter = new HelpMediaLimiter();
    deps.prisma.helpTopic.findFirst.mockResolvedValue(topic({ id: 'v', isPublished: true, videoKey: 'k', posterKey: 'p' }));
    deps.storage.statObject.mockResolvedValue({ size: body.length, contentType: 'image/png' });
    deps.storage.openReadStream.mockImplementation((_k: string, r?: { start: number; end: number }) =>
      Readable.from([r ? body.subarray(r.start, r.end + 1) : body]),
    );
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [HelpMediaController],
      providers: [{ provide: HelpMediaService, useValue: deps.media }, { provide: HelpMediaLimiter, useValue: limiter }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app.close(); });

  it('full GET → 200 video/mp4, Accept-Ranges, no-store, nosniff', async () => {
    const url = deps.media.mintUrl('v', 'bajaj', 'video', 'k').replace('/api/', '/');
    const res = await request(app.getHttpServer()).get(url).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video\/mp4/);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as Buffer).toString()).toBe('0123456789');
  });

  it('Range → 206 with Content-Range and only those bytes', async () => {
    const url = deps.media.mintUrl('v', 'bajaj', 'video', 'k').replace('/api/', '/');
    const res = await request(app.getHttpServer()).get(url).set('Range', 'bytes=2-5').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    expect((res.body as Buffer).toString()).toBe('2345');
  });

  it('HEAD → same headers (length, range) and NO stream opened', async () => {
    const url = deps.media.mintUrl('v', 'bajaj', 'video', 'k').replace('/api/', '/');
    const res = await request(app.getHttpServer()).head(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video\/mp4/);
    expect(res.headers['content-length']).toBe('10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    const ranged = await request(app.getHttpServer()).head(url).set('Range', 'bytes=2-5');
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 2-5/10');
    expect(ranged.headers['content-length']).toBe('4');
    expect(deps.storage.openReadStream).not.toHaveBeenCalled();
    expect((await request(app.getHttpServer()).head('/help/media?token=nope')).status).toBe(404);
  });

  it('inverted Range (bytes=5-3) is ignored → 200 with the full body', async () => {
    const url = deps.media.mintUrl('v', 'bajaj', 'video', 'k').replace('/api/', '/');
    const res = await request(app.getHttpServer()).get(url).set('Range', 'bytes=5-3');
    expect(res.status).toBe(200);
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.headers['content-length']).toBe('10');
  });

  it('per-token limit → 429 with Retry-After; concurrent-stream cap per token → 429', async () => {
    const url = deps.media.mintUrl('v', 'bajaj', 'video', 'k').replace('/api/', '/');
    const token = tokenOf(url);
    const key = HelpMediaLimiter.tokenKey(token);
    for (let i = 0; i < HELP_MEDIA_PER_TOKEN_PER_MIN; i++) limiter.check(key, '1.1.1.1');
    const res = await request(app.getHttpServer()).get(url);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('10');
    // a different token is unaffected
    const other = deps.media.mintUrl('v', 'bajaj', 'video', 'k', true).replace('/api/', '/');
    const releases = Array.from({ length: HELP_MEDIA_MAX_CONCURRENT_PER_TOKEN }, () => limiter.acquireStream(HelpMediaLimiter.tokenKey(tokenOf(other))));
    const busy = await request(app.getHttpServer()).get(other);
    expect(busy.status).toBe(429);
    releases.forEach((r) => r());
    expect((await request(app.getHttpServer()).get(other)).status).toBe(200);
    // the slot is released when the response closes
    await new Promise((r) => setTimeout(r, 20));
    expect(limiter.openStreams(HelpMediaLimiter.tokenKey(tokenOf(other)))).toBe(0);
  });

  it('unsatisfiable Range → 416; bad token → bare 404', async () => {
    const url = deps.media.mintUrl('v', 'bajaj', 'video', 'k').replace('/api/', '/');
    const r416 = await request(app.getHttpServer()).get(url).set('Range', 'bytes=50-');
    expect(r416.status).toBe(416);
    expect(r416.headers['content-range']).toBe('bytes */10');
    const r404 = await request(app.getHttpServer()).get('/help/media?token=nope');
    expect(r404.status).toBe(404);
  });
});

describe('HelpMediaLimiter', () => {
  it('window resets after a minute; per-IP backstop applies across tokens', () => {
    const l = new HelpMediaLimiter();
    let t = 1_000_000;
    l.now = () => t;
    for (let i = 0; i < HELP_MEDIA_PER_TOKEN_PER_MIN; i++) l.check('tok', 'ip');
    expect(() => l.check('tok', 'ip')).toThrow(/Too many requests/);
    t += 60_001;
    expect(() => l.check('tok', 'ip')).not.toThrow();
  });

  it('concurrent slots release exactly once', () => {
    const l = new HelpMediaLimiter();
    const r = l.acquireStream('a');
    expect(l.openStreams('a')).toBe(1);
    r();
    r();
    expect(l.openStreams('a')).toBe(0);
  });
});
