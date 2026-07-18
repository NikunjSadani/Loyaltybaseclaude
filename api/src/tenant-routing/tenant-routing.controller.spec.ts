import { TenantRoutingController } from './tenant-routing.controller';

describe('TenantRoutingController', () => {
  it('delegates to TenantRoutingService.getRouting', async () => {
    const payload = { tenants: [] };
    const service = { getRouting: jest.fn().mockResolvedValue(payload) } as any;
    const controller = new TenantRoutingController(service);

    await expect(controller.getRouting()).resolves.toBe(payload);
    expect(service.getRouting).toHaveBeenCalledTimes(1);
  });

  it('is marked @Public() so the global JwtAuthGuard lets it through unauthenticated', () => {
    // The @Public() decorator sets `isPublic` metadata; JwtAuthGuard reads it to opt out.
    const isPublic = Reflect.getMetadata('isPublic', TenantRoutingController.prototype.getRouting);
    expect(isPublic).toBe(true);
  });

  it('sets a short public Cache-Control header (@Header decorator)', () => {
    // NestJS stores @Header() entries under the '__headers__' metadata key.
    const headers = Reflect.getMetadata('__headers__', TenantRoutingController.prototype.getRouting);
    expect(headers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Cache-Control', value: 'public, max-age=60' }),
      ]),
    );
  });
});
