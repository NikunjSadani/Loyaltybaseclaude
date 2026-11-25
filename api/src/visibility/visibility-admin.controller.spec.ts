/**
 * The visibility media stream's headers (sales photo view): a sales caller of a photo-view tenant gets a short PRIVATE
 * cache tied to the session (`Vary: Cookie, Authorization`, N3); everyone else keeps `no-store`. The capture-id hint is
 * passed to the sales access check.
 *
 * Run: npx jest src/visibility/visibility-admin.controller.spec.ts
 */
import { Readable } from 'node:stream';
import { VisibilityAdminController } from './visibility-admin.controller';
import { JwtPayload } from '../common/decorators/current-user.decorator';

function makeRes() {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (k: string, v: string) => { headers[k] = v; }, once: jest.fn() };
}

describe('VisibilityAdminController.viewMedia headers', () => {
  const media = {
    viewMedia: jest.fn().mockResolvedValue({ stream: Readable.from([Buffer.from('x')]), size: 1, contentType: 'image/jpeg', inline: true }),
  };
  const capture = { assertSalesMediaAccess: jest.fn().mockResolvedValue(undefined), salesMediaCacheable: jest.fn() };
  const ctrl = new VisibilityAdminController({} as never, media as never, capture as never);
  const user = { sub: 'u1', role: 'SALES_ASM', clientId: 't1' } as JwtPayload;

  it('sales caller of a photo-view tenant → private, max-age=300 + Vary: Cookie, Authorization; the hint is passed on', async () => {
    capture.salesMediaCacheable.mockResolvedValue(true);
    const res = makeRes();
    await ctrl.viewMedia(user, 'visibility-media/t1/a.jpg', res as never, 'cap1');
    expect(capture.assertSalesMediaAccess).toHaveBeenCalledWith(user, 'visibility-media/t1/a.jpg', 'cap1');
    expect(res.headers['Cache-Control']).toBe('private, max-age=300');
    expect(res.headers['Vary']).toBe('Cookie, Authorization');
  });

  it('everyone else → no-store and no Vary (unchanged)', async () => {
    capture.salesMediaCacheable.mockResolvedValue(false);
    const res = makeRes();
    await ctrl.viewMedia({ ...user, role: 'CLIENT_ADMIN' }, 'visibility-media/t1/a.jpg', res as never);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Vary']).toBeUndefined();
  });
});
