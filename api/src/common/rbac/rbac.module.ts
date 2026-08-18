import { Global, Module } from '@nestjs/common';
import { GifsyRoleService } from './gifsy-role.service';

/**
 * RBAC Option-X — makes GifsyRoleService a single app-wide singleton.
 *
 * It is injected in two independent places: the global PermissionGuard (registered as an
 * APP_GUARD in AppModule) AND GifsyRolesService (declared in GifsyModule). A provider listed
 * only in AppModule.providers is NOT visible to an imported module's own providers, so
 * GifsyRolesService could not resolve it — the Nest container failed to boot. Marking this
 * @Global and exporting the service makes the SAME instance available everywhere, which also
 * keeps the resolver's in-proc cache coherent (updateRole/deleteRole clearCache() and the
 * guard's reads hit one cache, not two). GifsyRoleService only needs PrismaService, which is
 * itself @Global.
 */
@Global()
@Module({
  providers: [GifsyRoleService],
  exports: [GifsyRoleService],
})
export class RbacModule {}
