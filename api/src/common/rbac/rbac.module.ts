import { Global, Module } from '@nestjs/common';
import { GifsyRoleService } from './gifsy-role.service';
import { GifsyTenantGrantService } from './gifsy-tenant-grant.service';

/**
 * RBAC Option-X — app-wide singletons for the two staff-access axes.
 *
 * GifsyRoleService (FEATURE axis) is injected in two independent places: the global
 * PermissionGuard (APP_GUARD in AppModule) AND GifsyRolesService (in GifsyModule). A provider
 * listed only in AppModule.providers is NOT visible to an imported module's own providers, so
 * GifsyRolesService could not resolve it — the Nest container failed to boot. Marking this
 * @Global and exporting the service makes the SAME instance available everywhere, which also
 * keeps each resolver's in-proc cache coherent (a single cache, not one per consumer).
 *
 * GifsyTenantGrantService (P5, TENANT axis) is likewise shared: AuthService (assume-tenant +
 * refresh) and GifsyStaffService (grant CRUD + cache invalidation) both need the SAME instance
 * so a grant change invalidates the one cache the assume/refresh path reads. Both services only
 * need PrismaService, which is itself @Global.
 */
@Global()
@Module({
  providers: [GifsyRoleService, GifsyTenantGrantService],
  exports: [GifsyRoleService, GifsyTenantGrantService],
})
export class RbacModule {}
