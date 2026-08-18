// Regression guard for the RBAC Option-X DI wiring.
//
// GifsyRolesService (declared in GifsyModule) injects GifsyRoleService. That resolver was
// originally registered ONLY in AppModule.providers, which an imported module's own providers
// cannot see — so the Nest container failed to boot at runtime (green `nest build` + unit tests
// did NOT catch it, since neither exercises the DI graph). GifsyRoleService is now provided by
// the @Global RbacModule. This test boots a minimal graph that reproduces the exact resolution
// path (a separate module declaring GifsyRolesService, with GifsyRoleService only reachable via
// the global RbacModule) and fails to compile if that wiring regresses.

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RbacModule } from '../common/rbac/rbac.module';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRolesService } from './gifsy-roles.service';
import { GifsyStaffService } from './gifsy-staff.service';

// Stand-in for PrismaModule (@Global in the real app) so the resolver's PrismaService dep resolves.
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: {} }],
  exports: [PrismaService],
})
class FakePrismaModule {}

// Stand-in for GifsyModule: declares the P1 services WITHOUT re-declaring GifsyRoleService,
// exactly as the real GifsyModule does — so they must resolve it via the global RbacModule.
@Module({ providers: [GifsyRolesService, GifsyStaffService] })
class FakeGifsyModule {}

describe('RBAC Option-X module wiring', () => {
  it('resolves GifsyRolesService + GifsyStaffService with GifsyRoleService from the @Global RbacModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule, RbacModule, FakeGifsyModule],
    }).compile();

    expect(moduleRef.get(GifsyRolesService)).toBeInstanceOf(GifsyRolesService);
    expect(moduleRef.get(GifsyStaffService)).toBeInstanceOf(GifsyStaffService);
    // The resolver is a single shared instance (cache coherence for the guard + editor).
    expect(moduleRef.get(GifsyRoleService)).toBeInstanceOf(GifsyRoleService);
  });
});
