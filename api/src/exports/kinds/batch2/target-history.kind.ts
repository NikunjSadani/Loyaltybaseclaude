/**
 * Target change history report — GET /v1/admin/targets/history/export (owner 2026-11-25, all clients). One sheet
 * "Target history": every change a target upload made (target_change_history), oldest first, optionally filtered by
 * month / outlet / KPI. Tenant-scoped from the JWT; CLIENT_ADMIN / GIFSY_ADMIN + targets:read (as every target route).
 *
 * Paging: rows ordered changedAt ↑ (id ↑ keyset tiebreak), ≤ 2,000 per read, each page written before the next read.
 * Every string cell goes through cellSafe (XlsxStreamWriter). A note row says from when history is recorded (changes
 * before that were made before tracking started — never a silent gap), and a visible notice marks a row-cap truncation.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { istDateTimeCell } from '../../../common/ist-date';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TargetHistoryExportQueryDto } from '../../../targets/dto/targets.dto';
import type { ExportAccess, ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { keysetPages, monthWords, parseQueryDto } from './kind-support';

export interface TargetHistoryParams {
  clientId: string;
  month: string | null;
  outletCode: string | null;
  kpiCode: string | null;
}

const TARGETS_READ: ExportAccess = { roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' };
export const TARGET_HISTORY_EXPORT_MAX_ROWS = 500_000;

const HEADERS = ['Changed At (IST)', 'Outlet ID', 'Month', 'KPI', 'KPI Code', 'What changed', 'Change', 'Old value', 'New value', 'Changed by', 'Upload'];
const CHANGE_WORDS: Record<string, string> = { CREATED: 'Added', UPDATED: 'Changed', DELETED: 'Removed' };

const valueCell = (v: unknown): string | number => {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? v : typeof v === 'string' ? v : JSON.stringify(v);
};

function whereFor(p: TargetHistoryParams): Prisma.TargetChangeHistoryWhereInput {
  return {
    clientId: p.clientId,
    ...(p.month ? { month: p.month } : {}),
    ...(p.outletCode ? { outletCode: p.outletCode } : {}),
    ...(p.kpiCode ? { kpiCode: p.kpiCode } : {}),
  };
}

async function run(ctx: ExportRunContext, p: TargetHistoryParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const cap = TARGET_HISTORY_EXPORT_MAX_ROWS;
  const [first, kpis] = await Promise.all([
    ctx.prisma.targetChangeHistory.findFirst({ where: { clientId: p.clientId }, orderBy: { changedAt: 'asc' }, select: { changedAt: true } }),
    ctx.prisma.kpiDef.findMany({ where: { clientId: p.clientId }, select: { code: true, label: true } }),
  ]);
  const label = new Map(kpis.map((k) => [k.code, k.label]));
  const userNames = new Map<string, string>();
  const sheet = await out.addSheet('Target history', HEADERS, { widths: [20, 14, 10, 24, 16, 14, 10, 14, 14, 20, 26] });
  await sheet.addRow([
    first
      ? `Target history is recorded from ${istDateTimeCell(first.changedAt)} IST. Changes made before then are not listed (made before history tracking started).`
      : 'No target changes have been recorded yet. History is recorded from the first target upload after tracking started.',
    '', '', '', '', '', '', '', '', '', '',
  ]);
  let written = 0;
  for await (const page of keysetPages((q) =>
    ctx.prisma.targetChangeHistory.findMany({
      where: whereFor(p),
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      ...q,
      take: Math.min(q.take, cap - written),
    }),
  )) {
    const missing = [...new Set(page.map((r) => r.changedById).filter((x): x is string => !!x && !userNames.has(x)))];
    if (missing.length) {
      const users = await ctx.prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, clientId: true } });
      for (const u of users) userNames.set(u.id, u.clientId === p.clientId ? u.name : 'Gifsy team');
    }
    for (const r of page) {
      await sheet.addRow([
        istDateTimeCell(r.changedAt),
        r.outletCode,
        r.month,
        label.get(r.kpiCode) ?? r.kpiCode,
        r.kpiCode,
        r.field === 'NAME' ? 'Custom name' : 'Target',
        CHANGE_WORDS[r.changeType] ?? r.changeType,
        valueCell(r.oldValue),
        valueCell(r.newValue),
        r.changedById ? userNames.get(r.changedById) ?? '' : '',
        r.batchId ?? '',
      ]);
      written++;
    }
    if (written >= cap) break;
  }
  if (written >= cap) {
    await sheet.addRow([
      `⚠️ Export truncated at ${cap.toLocaleString('en-US')} rows — filter by month, outlet or KPI for a complete export.`,
      '', '', '', '', '', '', '', '', '', '',
    ]);
  }
  return { rowCount: written };
}

export const TARGET_HISTORY_KIND: ExportKindDef<TargetHistoryParams> = {
  kind: 'target-history',
  label: 'Target change history',
  access: TARGETS_READ,
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(TargetHistoryExportQueryDto, raw);
    if (!user.clientId) throw new ForbiddenException('The target history report requires a program (tenant).');
    return { clientId: user.clientId, month: q.month ?? null, outletCode: q.outletCode ?? null, kpiCode: q.kpiCode ?? null };
  },
  // One outlet streams instantly; a whole program (any month) is prepared on the Downloads page.
  isHeavy: (p) => !p.outletCode,
  describeParams: (p) =>
    [p.outletCode ? `Outlet ${p.outletCode}` : 'All outlets', p.month ? monthWords(p.month) : 'All months', ...(p.kpiCode ? [p.kpiCode] : [])].join(' · '),
  fileName: (p, now) =>
    `target-history${p.outletCode ? `-${p.outletCode.replace(/[^\w-]+/g, '_').slice(0, 40)}` : ''}${p.month ? `-${p.month}` : ''}-${now.toISOString().slice(0, 10)}.xlsx`,
  run,
};
