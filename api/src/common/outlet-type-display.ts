import { Prisma } from '@prisma/client';

/**
 * Minimal structural type for the only Prisma delegate this helper needs. Keeping the
 * dependency surface this small lets both `PrismaService` and a bare `PrismaClient` (or a
 * test mock) satisfy it without importing the full service.
 */
export interface OutletTypeConfigReader {
  outletTypeClientConfig: {
    findMany(args: {
      where: { clientId: string; isEnabled: boolean };
      select: { outletTypeId: true; displayName: true };
    }): Prisma.PrismaPromise<Array<{ outletTypeId: string; displayName: string | null }>>;
  };
}

/**
 * Load a tenant's per-outlet-type DISPLAY labels, keyed by `OutletType.id`. Returns ONLY the
 * enabled types that carry a non-blank (trimmed) `OutletTypeClientConfig.displayName`; a
 * tenant with no displayName (e.g. Deoleo) yields an EMPTY map ⇒ every caller's
 * `displayName ?? <current source>` falls back to the original value ⇒ byte-identical to
 * before. Mirrors the private `loadOutletTypeLabels` in admin-outlets.service.ts, but as a
 * reusable standalone keyed by outletTypeId.
 */
export async function loadOutletTypeDisplayNames(
  prisma: OutletTypeConfigReader,
  clientId: string,
): Promise<Map<string, string>> {
  const configs = await prisma.outletTypeClientConfig.findMany({
    where: { clientId, isEnabled: true },
    select: { outletTypeId: true, displayName: true },
  });
  const map = new Map<string, string>();
  for (const c of configs) {
    const dn = c.displayName?.trim();
    if (dn) map.set(c.outletTypeId, dn);
  }
  return map;
}

/**
 * Resolve the display label for one outlet type id: the tenant's displayName if present and
 * non-blank, else the given fallback (its current source — `name` or `code`). `fallback` is
 * returned as-is so a surface stays byte-identical when the tenant set no displayName.
 */
export function labelFor(
  displayNames: ReadonlyMap<string, string>,
  outletTypeId: string | null | undefined,
  fallback: string,
): string {
  if (!outletTypeId) return fallback;
  return displayNames.get(outletTypeId)?.trim() || fallback;
}
