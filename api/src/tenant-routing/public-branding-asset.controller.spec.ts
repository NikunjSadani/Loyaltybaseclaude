import { NotFoundException, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import { PublicBrandingAssetController } from './public-branding-asset.controller';
import { TenantRoutingModule } from './tenant-routing.module';
import { TenantRoutingService } from './tenant-routing.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const KEY = 'branding/bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-bajaj-logo.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.7 fake');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]);
const MB = 1024 * 1024;

/** A storage double: one object (or none) with the given bytes; `size` may be overridden. */
function setup(obj: { bytes: Buffer; contentType?: string; size?: number } | null) {
  const storage = {
    statObject: jest.fn().mockResolvedValue(
      obj ? { size: obj.size ?? obj.bytes.length, contentType: obj.contentType ?? 'image/png' } : null,
    ),
    downloadBytes: jest.fn().mockResolvedValue(
      obj ? { bytes: obj.bytes, contentType: obj.contentType ?? 'image/png' } : null,
    ),
    downloadObject: jest.fn().mockResolvedValue(obj ? obj.bytes : null),
    openReadStream: jest.fn((_k: string, range?: { start?: number; end?: number }) => {
      if (!obj) throw new Error('missing');
      const b = range ? obj.bytes.subarray(range.start ?? 0, (range.end ?? obj.bytes.length - 1) + 1) : obj.bytes;
      return Readable.from([b]);
    }),
  };
  const routing = { isKnownTenantSlug: jest.fn().mockResolvedValue(true) };
  const controller = new PublicBrandingAssetController(storage as any, routing as any);
  return { storage, controller, routing };
}

function mockRes() {
  const headers: Record<string, string> = {};
  const res = { setHeader: jest.fn((k: string, v: string) => (headers[k] = v)) } as any;
  return { res, headers };
}

async function bodyOf(file: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of file.getStream()) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('PublicBrandingAssetController', () => {
  it('Nest DI wires the module (controller + TenantRoutingService with its optional clock)', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'bajaj' }]);
    const mod = await Test.createTestingModule({ imports: [TenantRoutingModule] })
      .useMocker((token) => {
        if (token === PrismaService) return { client: { findMany } };
        if (token === StorageService) return {};
        return undefined;
      })
      .compile();
    expect(mod.get(PublicBrandingAssetController)).toBeInstanceOf(PublicBrandingAssetController);
    await expect(mod.get(TenantRoutingService).isKnownTenantSlug('bajaj')).resolves.toBe(true);
  });

  it('is @Public() and @SkipThrottle() (the IP throttler sees the frontend egress IP, not users)', () => {
    const handler = PublicBrandingAssetController.prototype.get;
    expect(Reflect.getMetadata('isPublic', handler)).toBe(true);
    const keys = [
      ...Reflect.getMetadataKeys(handler),
      ...Reflect.getMetadataKeys(PublicBrandingAssetController),
    ].map(String);
    expect(keys.some((k) => k.startsWith('THROTTLER:SKIP'))).toBe(true);
    expect(Reflect.getMetadata('roles', handler)).toBeUndefined();
  });

  it('serves a small branding PNG with the SNIFFED type, nosniff and an immutable public cache', async () => {
    const { controller } = setup({ bytes: PNG });
    const { res, headers } = mockRes();
    const out = await controller.get(KEY, res);
    expect(out).toBeInstanceOf(StreamableFile);
    expect(await bodyOf(out)).toEqual(PNG);
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Disposition']).toBe('inline');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('caches small objects in-process: the second request does not touch storage', async () => {
    const { controller, storage } = setup({ bytes: PNG });
    await controller.get(KEY, mockRes().res);
    const { res, headers } = mockRes();
    const out = await controller.get(KEY, res);
    expect(await bodyOf(out)).toEqual(PNG);
    expect(headers['Content-Type']).toBe('image/png');
    expect(storage.statObject).toHaveBeenCalledTimes(1);
    expect(storage.downloadObject).toHaveBeenCalledTimes(1);
  });

  it('a small cold miss costs ONE metadata call + ONE direct download (no second stat)', async () => {
    const { controller, storage } = setup({ bytes: PNG });
    await controller.get(KEY, mockRes().res);
    expect(storage.statObject).toHaveBeenCalledTimes(1);
    expect(storage.downloadObject).toHaveBeenCalledWith(KEY);
    expect(storage.downloadBytes).not.toHaveBeenCalled(); // (it re-reads metadata)
  });

  it('404s (negative-cached) a key whose slug is not a known tenant, before any storage call', async () => {
    const { controller, storage, routing } = setup({ bytes: PNG });
    routing.isKnownTenantSlug.mockResolvedValue(false);
    await expect(controller.get(KEY, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.get(KEY, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    expect(routing.isKnownTenantSlug).toHaveBeenCalledTimes(1);
    expect(routing.isKnownTenantSlug).toHaveBeenCalledWith('bajaj');
    expect(storage.statObject).not.toHaveBeenCalled();
    expect(storage.openReadStream).not.toHaveBeenCalled();
  });

  it('remembers a 404 briefly so a repeated missing key does not hit storage each time', async () => {
    const { controller, storage } = setup(null);
    await expect(controller.get(KEY, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.get(KEY, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.statObject).toHaveBeenCalledTimes(1);
  });

  it('STREAMS a larger (uncached) object after sniffing only its first bytes', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024, 7)]);
    const { controller, storage } = setup({ bytes: big });
    const { res, headers } = mockRes();
    const out = await controller.get(KEY, res);
    expect(storage.downloadObject).not.toHaveBeenCalled();
    expect(storage.openReadStream).toHaveBeenCalledWith(KEY, { start: 0, end: 15 });
    expect(storage.openReadStream).toHaveBeenLastCalledWith(KEY);
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Length']).toBe(String(big.length));
    expect((await bodyOf(out)).length).toBe(big.length);
    // Not cached → a repeat streams again.
    await controller.get(KEY, mockRes().res);
    expect(storage.statObject).toHaveBeenCalledTimes(2);
  });

  describe('large-object stream error (GCS fails mid-stream)', () => {
    const GCS_ERR = new Error('No such object: gifsy-platform-files/branding/bajaj/2026-11/x.png');

    async function streamed() {
      const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024, 7)]);
      const { controller } = setup({ bytes: big });
      return controller.get(KEY, mockRes().res);
    }

    function errRes(headersSent: boolean) {
      const headers: Record<string, string> = {
        'Content-Type': 'image/png',
        'Content-Length': '614412',
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      };
      let body = '';
      const res: any = {
        headersSent,
        destroyed: false,
        statusCode: 200,
        removeHeader: jest.fn((k: string) => delete headers[k]),
        setHeader: jest.fn((k: string, v: string) => (headers[k] = v)),
        end: jest.fn((b?: string) => (body += b ?? '')),
        send: jest.fn((b?: string) => (body += b ?? '')),
        destroy: jest.fn(),
      };
      return { res, headers, body: () => body };
    }

    it('before headers are sent: bare 404, no-store, image/length headers removed, NO storage error text', async () => {
      const out = await streamed();
      const { res, headers, body } = errRes(false);
      out.errorHandler(GCS_ERR, res);
      expect(res.statusCode).toBe(404);
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['Content-Length']).toBeUndefined();
      expect(headers['Content-Disposition']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(body()).not.toMatch(/gifsy-platform-files|No such object/);
      expect(JSON.parse(body())).toEqual({ success: false, error: 'Not found' });
      expect(res.send).not.toHaveBeenCalled();
      expect(res.destroy).not.toHaveBeenCalled();
    });

    it('after headers were sent: the connection is destroyed (no truncated "complete" image), no error text', async () => {
      const out = await streamed();
      const { res, body } = errRes(true);
      out.errorHandler(GCS_ERR, res);
      expect(res.destroy).toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
      expect(body()).toBe('');
    });

    it('an already-destroyed response is left alone', async () => {
      const out = await streamed();
      const { res } = errRes(false);
      res.destroyed = true;
      out.errorHandler(GCS_ERR, res);
      expect(res.end).not.toHaveBeenCalled();
      expect(res.destroy).not.toHaveBeenCalled();
    });
  });

  it('404s an object over the 5 MB cap WITHOUT reading any bytes', async () => {
    const { controller, storage } = setup({ bytes: PNG, size: 5 * MB + 1 });
    await expect(controller.get(KEY, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.downloadObject).not.toHaveBeenCalled();
    expect(storage.openReadStream).not.toHaveBeenCalled();
  });

  it('ignores a lying stored content-type — the bytes decide', async () => {
    const { controller } = setup({ bytes: PNG, contentType: 'text/html' });
    const { res, headers } = mockRes();
    await controller.get(KEY, res);
    expect(headers['Content-Type']).toBe('image/png');
  });

  it.each([
    ['path traversal', 'branding/../kyc/2026-01/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-pan.jpg'],
    ['wrong prefix (KYC)', 'kyc/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-pan.png'],
    ['wrong prefix (sales import)', 'sales-import/x/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-f.csv'],
    ['leading slash', `/${KEY}`],
    ['missing key', undefined],
    ['repeated key param', [KEY, KEY]],
  ])('404s %s WITHOUT touching storage', async (_l, key) => {
    const { controller, storage } = setup({ bytes: PNG });
    await expect(controller.get(key as any, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.statObject).not.toHaveBeenCalled();
    expect(storage.downloadObject).not.toHaveBeenCalled();
    expect(storage.openReadStream).not.toHaveBeenCalled();
  });

  it.each([
    ['PDF', PDF],
    ['HTML', HTML],
    ['TIFF (not browser-renderable)', TIFF],
  ])('404s a small %s object even under branding/', async (_l, bytes) => {
    const { controller } = setup({ bytes });
    const { res, headers } = mockRes();
    await expect(controller.get(KEY, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('404s a LARGE non-image object (head sniff) without streaming it', async () => {
    const bigPdf = Buffer.concat([PDF, Buffer.alloc(600 * 1024)]);
    const { controller, storage } = setup({ bytes: bigPdf });
    await expect(controller.get(KEY, mockRes().res)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.openReadStream).toHaveBeenCalledTimes(1); // the 16-byte head read only
  });
});
