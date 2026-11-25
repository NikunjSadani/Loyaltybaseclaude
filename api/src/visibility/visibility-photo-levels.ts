/**
 * Sales photo view — validation of `visibilityConfig.salesPhotoViewLevels` against the tenant's REAL sales levels
 * (SalesHierarchyLevel.code). Shared by both writers (PUT /visibility/config and the generic settings writer) so a typo
 * can never silently switch the feature off for a level. Case-insensitive; each value is stored in the tenant's own
 * spelling; an unknown code → 400 with a plain message.
 */
import { BadRequestException } from '@nestjs/common';

type LevelReader = {
  salesHierarchyLevel: {
    findMany(args: {
      where: { clientId: string };
      select: { code: true; name: true; level: true };
      orderBy: { level: 'asc' };
    }): Promise<Array<{ code: string; name: string; level: number }>>;
  };
};

/** The tenant's sales levels (code + display name), top-down order of the hierarchy table. */
export async function tenantSalesLevels(
  prisma: LevelReader,
  clientId: string,
): Promise<Array<{ code: string; name: string }>> {
  const rows =
    (await prisma.salesHierarchyLevel.findMany({
      where: { clientId },
      select: { code: true, name: true, level: true },
      orderBy: { level: 'asc' },
    })) ?? [];
  return rows.map((r) => ({ code: r.code, name: r.name }));
}

/**
 * Normalise a submitted list: trim, map case-insensitively onto the tenant's stored codes, de-duplicate (first wins).
 * Unknown → 400 "Unknown sales level: X. Use one of: A, B, C."
 */
export async function resolveSalesPhotoViewLevels(
  prisma: LevelReader,
  clientId: string,
  input: unknown,
): Promise<string[]> {
  if (!Array.isArray(input)) {
    throw new BadRequestException('salesPhotoViewLevels must be a list of sales level codes.');
  }
  const wanted = input.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  const levels = await tenantSalesLevels(prisma, clientId);
  const byUpper = new Map(levels.map((l) => [l.code.toUpperCase(), l.code]));
  const out: string[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const code = byUpper.get(w.toUpperCase());
    if (!code) unknown.push(w);
    else if (!out.includes(code)) out.push(code);
  }
  if (unknown.length > 0) {
    const valid = levels.map((l) => l.code).join(', ') || 'none set up yet';
    throw new BadRequestException(
      `Unknown sales level${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use one of: ${valid}.`,
    );
  }
  return out;
}
