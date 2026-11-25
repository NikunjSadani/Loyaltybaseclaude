/**
 * 'target-history' export kind (owner 2026-11-25): tenant-scoped rows (filters month / outlet / KPI), the "recorded
 * from …" note (no silent gap), formula-injection-safe cells, user names, access + heavy rule.
 */
import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TARGET_HISTORY_KIND } from './target-history.kind';
import { ctxFor, renderKind } from './parity.support-spec';

const admin = { sub: 'admin1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const at = new Date(Date.UTC(2026, 10, 26, 6, 30));

function prismaWith(rows: unknown[], first: Date | null) {
  return {
    targetChangeHistory: {
      findFirst: jest.fn().mockResolvedValue(first ? { changedAt: first } : null),
      findMany: jest.fn().mockImplementation(async (a: { cursor?: unknown }) => (a.cursor ? [] : rows)),
    },
    kpiDef: { findMany: jest.fn().mockResolvedValue([{ code: 'MONTH_TGT', label: 'Month Target' }]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin1', name: 'Asha', clientId: 'bajaj' }, { id: 'g1', name: 'Ravi', clientId: 'gifsy' }]) },
  };
}
const aoa = (buf: Buffer) => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
};

describe('target-history export kind', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, clientId: 'bajaj', outletCode: 'R1', month: '2026-12', kpiCode: 'MONTH_TGT', field: 'VALUE', oldValue: 10, newValue: 12,
    changeType: 'UPDATED', batchId: 'b1', changedById: 'admin1', changedAt: at, ...extra,
  });

  it('writes the tracking note, then one row per change (tenant-scoped, filtered), cells formula-safe', async () => {
    const prisma = prismaWith([
      row('h1'),
      row('h2', { kpiCode: '=HYPERLINK("http://x")', oldValue: null, newValue: '=cmd', changeType: 'CREATED', field: 'NAME', changedById: 'g1' }),
    ], new Date(Date.UTC(2026, 10, 25, 12, 0)));
    const params = TARGET_HISTORY_KIND.parseParams({ outletCode: 'R1', month: '2026-12' }, admin);
    const { buffer, rowCount } = await renderKind(TARGET_HISTORY_KIND, ctxFor(admin, prisma), params);
    expect(rowCount).toBe(2);
    expect(prisma.targetChangeHistory.findMany.mock.calls[0][0].where).toEqual({ clientId: 'bajaj', month: '2026-12', outletCode: 'R1' });
    expect(prisma.targetChangeHistory.findFirst.mock.calls[0][0].where).toEqual({ clientId: 'bajaj' });
    const rows = aoa(buffer);
    expect(rows[0]).toEqual(['Changed At (IST)', 'Outlet ID', 'Month', 'KPI', 'KPI Code', 'What changed', 'Change', 'Old value', 'New value', 'Changed by', 'Upload']);
    expect(String(rows[1][0])).toMatch(/^Target history is recorded from .* IST\. Changes made before then are not listed/);
    expect(rows[2].slice(1)).toEqual(['R1', '2026-12', 'Month Target', 'MONTH_TGT', 'Target', 'Changed', 10, 12, 'Asha', 'b1']);
    // formula-injection guard on every string cell; another tenant's operator is not named
    expect(rows[3][3]).toBe(`'=HYPERLINK("http://x")`);
    expect(rows[3][8]).toBe(`'=cmd`);
    expect(rows[3].slice(5, 7)).toEqual(['Custom name', 'Added']);
    expect(rows[3][9]).toBe('Gifsy team');
  });

  it('nothing recorded yet → says so (never an empty, unexplained file)', async () => {
    const prisma = prismaWith([], null);
    const { buffer } = await renderKind(TARGET_HISTORY_KIND, ctxFor(admin, prisma), TARGET_HISTORY_KIND.parseParams({}, admin));
    expect(String(aoa(buffer)[1][0])).toMatch(/No target changes have been recorded yet/);
  });

  it('access = CLIENT_ADMIN / GIFSY_ADMIN + targets:read; one outlet streams now, a whole program is heavy', () => {
    expect(TARGET_HISTORY_KIND.access).toEqual({ roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' });
    expect(TARGET_HISTORY_KIND.isHeavy(TARGET_HISTORY_KIND.parseParams({ outletCode: 'R1' }, admin))).toBe(false);
    expect(TARGET_HISTORY_KIND.isHeavy(TARGET_HISTORY_KIND.parseParams({ month: '2026-12' }, admin))).toBe(true);
    // the tenant always comes from the JWT — a clientId param is refused, never honoured
    expect(() => TARGET_HISTORY_KIND.parseParams({ clientId: 'other' }, admin)).toThrow(BadRequestException);
    expect(() => TARGET_HISTORY_KIND.parseParams({ month: '2026-13' }, admin)).toThrow(BadRequestException);
  });
});
