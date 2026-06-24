import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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
});
