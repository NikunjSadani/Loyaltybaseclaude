/**
 * RBAC Option-X — idempotent seed for the two isSystem Gifsy operator roles
 * (Ops, Project Manager). Upserts by the natural key (clientId, name) so
 * re-running never duplicates and always converges the permission set + flags
 * to the canonical definitions in src/common/rbac/gifsy-seed-roles.ts.
 *
 * This is a plain function (not tied to seed.ts's module-level client) so it is
 * unit-testable with a mocked client and reusable by any bootstrap path. It does
 * NOT run itself — seed.ts calls it inside the gifsy_dev/staging-guarded main().
 */

import {
  GIFSY_ROLES_CLIENT_ID,
  GIFSY_SEED_ROLES,
} from '../src/common/rbac/gifsy-seed-roles';

/** Minimal shape of the Prisma client this seed needs (keeps it mockable). */
export interface GifsyRoleSeedClient {
  gifsyRole: {
    upsert(args: {
      where: { clientId_name: { clientId: string; name: string } };
      update: { description: string; permissions: string[]; isSystem: boolean };
      create: {
        clientId: string;
        name: string;
        description: string;
        permissions: string[];
        isSystem: boolean;
      };
    }): Promise<{ id: string; name: string }>;
  };
}

export async function seedGifsyRoles(prisma: GifsyRoleSeedClient): Promise<void> {
  console.log('\n🛡️   Seeding RBAC Option-X system Gifsy roles (Ops, Project Manager)…');
  for (const role of GIFSY_SEED_ROLES) {
    const permissions = [...role.permissions];
    const result = await prisma.gifsyRole.upsert({
      where: {
        clientId_name: { clientId: GIFSY_ROLES_CLIENT_ID, name: role.name },
      },
      update: {
        description: role.description,
        permissions,
        isSystem: role.isSystem,
      },
      create: {
        clientId: GIFSY_ROLES_CLIENT_ID,
        name: role.name,
        description: role.description,
        permissions,
        isSystem: role.isSystem,
      },
    });
    console.log(`   ✓ GifsyRole "${result.name}" (${permissions.length} perms) — id: ${result.id}`);
  }
}
