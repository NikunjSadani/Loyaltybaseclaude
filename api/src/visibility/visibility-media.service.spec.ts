/**
 * Unit tests for visibility-media.service.ts.
 *
 * Covers: computeImageHash (determinism), recordImageHashes (cross-capture dup
 * detection, self-exclusion, idempotent insert), viewMedia (tenant-from-key
 * enforcement + bare 404), and uploadMedia (magic-byte guard + tenant-foldered key).
 *
 * Run: npx jest src/visibility/visibility-media.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VisibilityMediaService } from './visibility-media.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockStorage = {
  generateKey: jest.fn((folder: string, name: string) => `${folder}/2026-07/uuid-${name}`),
  uploadFile: jest.fn().mockResolvedValue('https://storage/x'),
  downloadBytes: jest.fn(),
};

const admin: JwtPayload = { sub: 'a1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'A' };
const t1User: JwtPayload = { sub: 'u1', role: 'SALES_SO', clientId: 't1', phone: '9', name: 'U' };
const t2User: JwtPayload = { sub: 'u2', role: 'SALES_SO', clientId: 't2', phone: '9', name: 'V' };
const t1ClientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '9', name: 'CA' };

// A minimal valid JPEG (FF D8 FF) so sniffFileType accepts it.
const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe('VisibilityMediaService', () => {
  let service: VisibilityMediaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [VisibilityMediaService, { provide: StorageService, useValue: mockStorage }],
    }).compile();
    service = module.get(VisibilityMediaService);
  });

  describe('computeImageHash', () => {
    it('is a deterministic sha256 hex digest', () => {
      const h1 = service.computeImageHash(Buffer.from('abc'));
      const h2 = service.computeImageHash(Buffer.from('abc'));
      const h3 = service.computeImageHash(Buffer.from('abd'));
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('recordImageHashes', () => {
    it('flags hashes seen on a DIFFERENT capture and inserts the new rows', async () => {
      const tx = {
        visibilityImageHash: {
          findMany: jest.fn().mockResolvedValue([{ hash: 'h1' }]),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const res = await service.recordImageHashes(tx, 't1', 'capB', ['h1', 'h2', 'h1']);
      expect(res.dupHashes).toEqual(['h1']);

      // Dedup before the "seen elsewhere" query; excludes this capture.
      const whereArg = tx.visibilityImageHash.findMany.mock.calls[0][0].where;
      expect(whereArg.captureId).toEqual({ not: 'capB' });
      expect(whereArg.clientId).toBe('t1');
      expect(whereArg.hash).toEqual({ in: ['h1', 'h2'] });

      // Insert is de-duplicated + idempotent.
      const createArg = tx.visibilityImageHash.createMany.mock.calls[0][0];
      expect(createArg.skipDuplicates).toBe(true);
      expect(createArg.data).toEqual([
        { clientId: 't1', captureId: 'capB', hash: 'h1' },
        { clientId: 't1', captureId: 'capB', hash: 'h2' },
      ]);
    });

    it('returns no dups + skips the query for an empty hash list', async () => {
      const tx = {
        visibilityImageHash: { findMany: jest.fn(), createMany: jest.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const res = await service.recordImageHashes(tx, 't1', 'capB', []);
      expect(res.dupHashes).toEqual([]);
      expect(tx.visibilityImageHash.findMany).not.toHaveBeenCalled();
      expect(tx.visibilityImageHash.createMany).not.toHaveBeenCalled();
    });
  });

  describe('viewMedia (tenant-from-key)', () => {
    it('serves a same-tenant object inline for safe mime', async () => {
      mockStorage.downloadBytes.mockResolvedValue({ bytes: jpegBuffer, contentType: 'image/jpeg' });
      const out = await service.viewMedia(t1User, 'visibility-media/t1/2026-07/a.jpg');
      expect(out.inline).toBe(true);
      expect(out.contentType).toBe('image/jpeg');
    });

    it('404s a cross-tenant key for a non-admin', async () => {
      await expect(
        service.viewMedia(t2User, 'visibility-media/t1/2026-07/a.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('M4: lets a CLIENT_ADMIN read its OWN tenant media (export photo links, D15)', async () => {
      mockStorage.downloadBytes.mockResolvedValue({ bytes: jpegBuffer, contentType: 'image/jpeg' });
      const out = await service.viewMedia(t1ClientAdmin, 'visibility-media/t1/2026-07/a.jpg');
      expect(out.inline).toBe(true);
      expect(out.contentType).toBe('image/jpeg');
    });

    it('M4: pins a CLIENT_ADMIN to its own tenant — 404s a cross-tenant key', async () => {
      await expect(
        service.viewMedia(t1ClientAdmin, 'visibility-media/t2/2026-07/a.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('lets a GIFSY_ADMIN read any tenant key (cross-tenant operator)', async () => {
      mockStorage.downloadBytes.mockResolvedValue({ bytes: jpegBuffer, contentType: 'image/jpeg' });
      const out = await service.viewMedia(admin, 'visibility-media/t1/2026-07/a.jpg');
      expect(out.inline).toBe(true);
    });

    it('404s a key outside the visibility-media prefix', async () => {
      await expect(
        service.viewMedia(admin, 'scheme-media/t1/2026-07/a.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a missing object', async () => {
      mockStorage.downloadBytes.mockResolvedValue(null);
      await expect(
        service.viewMedia(t1User, 'visibility-media/t1/2026-07/a.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forces a non-safe mime to an octet-stream download', async () => {
      mockStorage.downloadBytes.mockResolvedValue({ bytes: jpegBuffer, contentType: 'image/svg+xml' });
      const out = await service.viewMedia(t1User, 'visibility-media/t1/2026-07/a.svg');
      expect(out.inline).toBe(false);
      expect(out.contentType).toBe('application/octet-stream');
    });
  });

  describe('uploadMedia', () => {
    it('stores under a tenant-foldered visibility-media key and returns it', async () => {
      const file = {
        buffer: jpegBuffer,
        size: jpegBuffer.length,
        originalname: 'shelf.jpg',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const res = await service.uploadMedia(t1User, file);
      expect(mockStorage.generateKey).toHaveBeenCalledWith('visibility-media/t1', 'shelf.jpg');
      expect(res.key).toContain('visibility-media/t1/');
      expect(res.mimeType).toBe('image/jpeg');
    });

    it('rejects a payload whose magic bytes are not an allowed type', async () => {
      const file = {
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        size: 40,
        originalname: 'x.svg',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await expect(service.uploadMedia(t1User, file)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an oversized file', async () => {
      const file = {
        buffer: jpegBuffer,
        size: 6 * 1024 * 1024,
        originalname: 'big.jpg',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await expect(service.uploadMedia(t1User, file)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
