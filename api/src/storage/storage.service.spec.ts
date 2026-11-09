import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PassThrough, Readable, Writable } from 'node:stream';
import { StorageService } from './storage.service';

const mockConfig = { get: jest.fn(() => undefined) };

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService, { provide: ConfigService, useValue: mockConfig }],
    }).compile();
    service = module.get(StorageService);
  });

  describe('config sanitization (BOM / CRLF-dirty secrets)', () => {
    /** Build a service whose ConfigService returns the given raw secret values. */
    async function withConfig(values: Record<string, string | undefined>) {
      const mod: TestingModule = await Test.createTestingModule({
        providers: [
          StorageService,
          { provide: ConfigService, useValue: { get: (k: string) => values[k] } },
        ],
      }).compile();
      return mod.get(StorageService);
    }

    it('strips a leading UTF-8 BOM and trailing CR/LF from GCS_BUCKET', async () => {
      // The exact contamination seen in Secret Manager: BOM + name + CR CR LF.
      const svc = await withConfig({ GCS_BUCKET: '\uFEFFgifsy-platform-files\r\r\n' });
      // publicUrl is the only window onto the private bucket field.
      expect(svc.publicUrl('kyc/x.jpg')).toBe(
        'https://storage.googleapis.com/gifsy-platform-files/kyc/x.jpg',
      );
    });

    it('falls back to the default bucket when GCS_BUCKET is unset', async () => {
      const svc = await withConfig({ GCS_BUCKET: undefined });
      expect(svc.publicUrl('k')).toBe(
        'https://storage.googleapis.com/gifsy-platform-files/k',
      );
    });

    it('does not alter a clean bucket name', async () => {
      const svc = await withConfig({ GCS_BUCKET: 'gifsy-platform-files' });
      expect(svc.publicUrl('k')).toBe(
        'https://storage.googleapis.com/gifsy-platform-files/k',
      );
    });
  });

  describe('generateKey', () => {
    it('namespaces by folder + YYYY-MM and a uuid, preserving the extension', () => {
      const key = service.generateKey('kyc', 'pan card.JPG');
      expect(key).toMatch(/^kyc\/\d{4}-\d{2}\/[0-9a-f-]+-pan_card\.JPG$/);
    });

    it('sanitizes unsafe filename characters', () => {
      const key = service.generateKey('docs', 'a/b*c?.pdf');
      // path.basename strips the dir; remaining unsafe chars become underscores
      expect(key).toMatch(/^docs\/\d{4}-\d{2}\/[0-9a-f-]+-.*\.pdf$/);
      expect(key).not.toContain('*');
      expect(key).not.toContain('?');
    });
  });

  describe('downloadAsDataUrl', () => {
    /** Swap in a fake GCS file whose metadata + bytes we control. */
    function stubFile(opts: { size: number; contentType?: string; bytes?: Buffer }) {
      const file = {
        getMetadata: jest.fn().mockResolvedValue([{ size: opts.size, contentType: opts.contentType }]),
        download: jest.fn().mockResolvedValue([opts.bytes ?? Buffer.from('xx')]),
      };
      (service as unknown as { storage: unknown }).storage = {
        bucket: () => ({ file: () => file }),
      };
      return file;
    }

    it('returns a base64 data URL using the object metadata content-type', async () => {
      stubFile({ size: 3, contentType: 'image/png', bytes: Buffer.from('abc') });
      const out = await service.downloadAsDataUrl('kyc/x.png');
      expect(out).toBe(`data:image/png;base64,${Buffer.from('abc').toString('base64')}`);
    });

    it('prefers the caller-supplied content-type over the object metadata', async () => {
      stubFile({ size: 2, contentType: 'application/octet-stream', bytes: Buffer.from('hi') });
      const out = await service.downloadAsDataUrl('kyc/x.jpg', 'image/jpeg');
      expect(out).toBe(`data:image/jpeg;base64,${Buffer.from('hi').toString('base64')}`);
    });

    it('returns null (no download) when the object exceeds the size cap', async () => {
      const file = stubFile({ size: 20 * 1024 * 1024, contentType: 'image/jpeg' });
      const out = await service.downloadAsDataUrl('kyc/big.jpg', undefined, 8 * 1024 * 1024);
      expect(out).toBeNull();
      expect(file.download).not.toHaveBeenCalled();
    });

    it('falls back to octet-stream when no content-type is known', async () => {
      stubFile({ size: 1, bytes: Buffer.from('z') });
      const out = await service.downloadAsDataUrl('kyc/x.bin');
      expect(out).toBe(`data:application/octet-stream;base64,${Buffer.from('z').toString('base64')}`);
    });
  });

  describe('large-object helpers (Sales Import)', () => {
    function stubBucket() {
      const written: Buffer[] = [];
      const file = {
        createReadStream: jest.fn(() => Readable.from([Buffer.from('abc')])),
        createWriteStream: jest.fn(() =>
          new Writable({
            write(chunk, _enc, cb) {
              written.push(Buffer.from(chunk));
              cb();
            },
          }),
        ),
      };
      const bucket = {
        file: jest.fn(() => file),
        getFiles: jest.fn().mockResolvedValue([[{ name: 'p/parts/00000', metadata: { size: '4' } }, { name: 'p/parts/00001', metadata: {} }]]),
        deleteFiles: jest.fn().mockResolvedValue(undefined),
      };
      (service as unknown as { storage: unknown }).storage = { bucket: () => bucket };
      return { bucket, file, written };
    }

    it('openReadStream passes a byte range (validation off) or reads the whole object', () => {
      const { file } = stubBucket();
      service.openReadStream('k', { start: 10, end: 19 });
      expect(file.createReadStream).toHaveBeenLastCalledWith({ start: 10, end: 19, validation: false });
      service.openReadStream('k');
      expect(file.createReadStream).toHaveBeenLastCalledWith();
    });

    it('listPrefix returns names and numeric sizes', async () => {
      const { bucket } = stubBucket();
      await expect(service.listPrefix('p/parts/')).resolves.toEqual([
        { name: 'p/parts/00000', size: 4 },
        { name: 'p/parts/00001', size: 0 },
      ]);
      expect(bucket.getFiles).toHaveBeenCalledWith({ prefix: 'p/parts/' });
    });

    it('deletePrefix deletes by folder prefix and refuses a non-folder prefix', async () => {
      const { bucket } = stubBucket();
      await service.deletePrefix('sales-imports/c/i/');
      expect(bucket.deleteFiles).toHaveBeenCalledWith({ prefix: 'sales-imports/c/i/', force: true });
      await expect(service.deletePrefix('')).rejects.toThrow('non-folder');
      await expect(service.deletePrefix('sales-imports/c')).rejects.toThrow('non-folder');
    });

    it('uploadStream pipes the source into a non-resumable write stream', async () => {
      const { file, written } = stubBucket();
      const src = new PassThrough();
      const done = service.uploadStream('x/u.csv', src, 'text/csv');
      src.end('a,b;');
      await expect(done).resolves.toBe('https://storage.googleapis.com/gifsy-platform-files/x/u.csv');
      expect(file.createWriteStream).toHaveBeenCalledWith({ resumable: false, contentType: 'text/csv' });
      expect(Buffer.concat(written).toString()).toBe('a,b;');
    });
  });
});
