import { NotFoundException, StreamableFile } from '@nestjs/common';
import { PublicBrandingAssetController } from './public-branding-asset.controller';

const KEY = 'branding/bajaj/2026-11/5d3daa20-92f7-4ff8-8d2e-8ff59a429201-bajaj-logo.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.7 fake');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]);

function setup(file: { bytes: Buffer; contentType: string } | null) {
  const storage = { downloadBytes: jest.fn().mockResolvedValue(file) };
  const controller = new PublicBrandingAssetController(storage as any);
  const headers: Record<string, string> = {};
  const res = { setHeader: jest.fn((k: string, v: string) => (headers[k] = v)) } as any;
  return { storage, controller, res, headers };
}

describe('PublicBrandingAssetController', () => {
  it('is @Public() (pre-login: no JWT, no tenant context) and NOT exempt from the global throttler', () => {
    const handler = PublicBrandingAssetController.prototype.get;
    expect(Reflect.getMetadata('isPublic', handler)).toBe(true);
    // No @SkipThrottle → the global ThrottlerGuard (60/min/IP) still rate-limits it.
    const keys = [
      ...Reflect.getMetadataKeys(handler),
      ...Reflect.getMetadataKeys(PublicBrandingAssetController),
    ].map(String);
    expect(keys.some((k) => k.startsWith('THROTTLER:SKIP'))).toBe(false);
    // No @Roles → RolesGuard/PermissionGuard have nothing to enforce.
    expect(Reflect.getMetadata('roles', handler)).toBeUndefined();
  });

  it('streams a branding PNG with the SNIFFED type, nosniff and an immutable public cache', async () => {
    const { controller, storage, res, headers } = setup({ bytes: PNG, contentType: 'image/png' });
    const out = await controller.get(KEY, res);
    expect(out).toBeInstanceOf(StreamableFile);
    expect(storage.downloadBytes).toHaveBeenCalledWith(KEY, 5 * 1024 * 1024);
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Disposition']).toBe('inline');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('ignores a lying stored content-type — the bytes decide', async () => {
    const { controller, res, headers } = setup({ bytes: PNG, contentType: 'text/html' });
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
    const { controller, storage, res } = setup({ bytes: PNG, contentType: 'image/png' });
    await expect(controller.get(key as any, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.downloadBytes).not.toHaveBeenCalled();
  });

  it('404s a missing / oversized object (storage returns null)', async () => {
    const { controller, res } = setup(null);
    await expect(controller.get(KEY, res)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['PDF', PDF],
    ['HTML', HTML],
    ['TIFF (not browser-renderable)', TIFF],
  ])('404s a %s object even under branding/', async (_l, bytes) => {
    const { controller, res, headers } = setup({ bytes, contentType: 'image/png' });
    await expect(controller.get(KEY, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(headers['Content-Type']).toBeUndefined();
  });
});
