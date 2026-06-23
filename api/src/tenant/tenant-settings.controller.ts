import { Controller, Get } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantSettingsService, EffectiveSettings } from './tenant-settings.service';
import { TenantService, VisibilityCaptureMode } from './tenant.service';

type SettingsResponse = (EffectiveSettings | Omit<EffectiveSettings, 'creditsPayouts'>) & {
  visibilityCaptureMode: VisibilityCaptureMode;
};

/**
 * GET /v1/settings — the caller-tenant's effective settings, for the partner/sales/admin
 * front-ends (replaces the browser localStorage blob as the source of truth). Any
 * authenticated user may read their OWN tenant's settings (scoped by JWT clientId — no
 * cross-tenant exposure). The whole `creditsPayouts` block (safety caps, cutoff day,
 * notify emails) is operator-internal, so it is omitted entirely for non-admin roles —
 * partner/sales never consume it.
 */
@Controller('settings')
export class TenantSettingsController {
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly tenant: TenantService,
  ) {}

  @Get()
  async get(@CurrentUser() user: JwtPayload): Promise<SettingsResponse> {
    const [eff, visibilityCaptureMode] = await Promise.all([
      this.settings.getEffectiveSettings(user.clientId),
      // Authoritative ClientConfig flag — included so the sales shell (which cannot read the
      // admin-only /admin/settings/config) can gate the visibility-photo action correctly.
      this.tenant.resolveVisibilityCaptureMode(user.clientId),
    ]);
    const isAdmin = user.role === 'GIFSY_ADMIN' || user.role === 'CLIENT_ADMIN';
    if (isAdmin) return { ...eff, visibilityCaptureMode };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { creditsPayouts, ...rest } = eff;
    return { ...rest, visibilityCaptureMode };
  }
}
