import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../common/decorators/roles.decorator';
import { TenantRoutingService, TenantRoutingResponse } from './tenant-routing.service';

/**
 * GET /v1/tenants/routing — PUBLIC, unauthenticated tenant-routing table.
 *
 * The Next.js edge proxy calls this pre-login (there is no token yet) to
 * resolve any request host → tenant slug + the public branding subset needed
 * to paint the sign-in screen. `@Public()` opts out of the global JwtAuthGuard
 * (APP_GUARD in app.module.ts).
 *
 * Intentionally public but leaks nothing beyond slug / status / domains /
 * public-branding — all of which are already visible on the served pages.
 * The branding subset is whitelisted in the service (never spreads the raw
 * `Client.branding` blob).
 */
@Controller('tenants')
export class TenantRoutingController {
  constructor(private readonly routing: TenantRoutingService) {}

  @Public()
  @Get('routing')
  // Short shared cache — the FE also caches this. Tenant/branding changes are
  // rare, so a 60s TTL is safe and keeps the pre-login path cheap.
  @Header('Cache-Control', 'public, max-age=60')
  async getRouting(): Promise<TenantRoutingResponse> {
    return this.routing.getRouting();
  }
}
