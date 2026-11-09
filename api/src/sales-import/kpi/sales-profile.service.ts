import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { normalizeHeader } from '../ingest/normalize';
import {
  SALES_IMPORT_DIM_KEY_PATTERN,
  SALES_IMPORT_MAX_DIMENSIONS,
  type SalesColumnMapping,
  type SalesDimensionMapping,
} from '../sales-import.contract';
import { filterDimKeys } from './sales-kpi.helper';

const DATE_ORDERS = ['DMY', 'MDY', 'YMD'] as const;
const MAX_HEADER_ROW = 50;

function optStr(v: unknown, field: string, errors: string[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    errors.push(`${field} must be text.`);
    return null;
  }
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Validate + normalise a SalesColumnMapping (plan §5.2 PUT profile, task K-1). Throws 400 with every problem listed.
 * Rules: outletCode + invoiceDate required; ≥ 1 of amount / quantity; headerRow 'auto' or 1..50; dateOrder known;
 * ≤ 6 dimensions with unique keys matching SALES_IMPORT_DIM_KEY_PATTERN, non-empty label + header; every mapped header
 * is unique after normalizeHeader (one file column can feed one field only).
 */
export function validateColumnMapping(raw: unknown): SalesColumnMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Column mapping must be an object.');
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  const outletCode = optStr(r.outletCode, 'outletCode', errors);
  if (!outletCode) errors.push('The outlet code column is required.');
  const invoiceDate = optStr(r.invoiceDate, 'invoiceDate', errors);
  if (!invoiceDate) errors.push('The invoice date column is required.');
  const amount = optStr(r.amount, 'amount', errors);
  const quantity = optStr(r.quantity, 'quantity', errors);
  if (!amount && !quantity) errors.push('Map at least one of the amount or quantity columns.');
  const outletName = optStr(r.outletName, 'outletName', errors);
  const sheetName = optStr(r.sheetName, 'sheetName', errors);

  let headerRow: 'auto' | number = 'auto';
  if (r.headerRow !== undefined && r.headerRow !== 'auto') {
    const n = Number(r.headerRow);
    if (!Number.isInteger(n) || n < 1 || n > MAX_HEADER_ROW) {
      errors.push(`headerRow must be "auto" or a row number 1..${MAX_HEADER_ROW}.`);
    } else headerRow = n;
  }

  const dateOrder = (r.dateOrder ?? 'DMY') as SalesColumnMapping['dateOrder'];
  if (!DATE_ORDERS.includes(dateOrder)) errors.push('dateOrder must be one of DMY, MDY, YMD.');

  const dimensions: SalesDimensionMapping[] = [];
  const rawDims = r.dimensions ?? [];
  if (!Array.isArray(rawDims)) {
    errors.push('dimensions must be a list.');
  } else {
    if (rawDims.length > SALES_IMPORT_MAX_DIMENSIONS) {
      errors.push(`At most ${SALES_IMPORT_MAX_DIMENSIONS} dimensions are allowed.`);
    }
    const keys = new Set<string>();
    rawDims.forEach((d, i) => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        errors.push(`dimensions[${i}] must be an object { key, label, header }.`);
        return;
      }
      const dd = d as Record<string, unknown>;
      const key = typeof dd.key === 'string' ? dd.key.trim() : '';
      const label = optStr(dd.label, `dimensions[${i}].label`, errors);
      const header = optStr(dd.header, `dimensions[${i}].header`, errors);
      if (!SALES_IMPORT_DIM_KEY_PATTERN.test(key)) {
        errors.push(`dimensions[${i}].key "${key}" must start with a lower-case letter and use only letters/digits (max 24).`);
      } else if (keys.has(key)) {
        errors.push(`Dimension key "${key}" is used twice.`);
      }
      keys.add(key);
      if (!label) errors.push(`dimensions[${i}].label is required.`);
      if (!header) errors.push(`dimensions[${i}].header is required.`);
      dimensions.push({ key, label: label ?? '', header: header ?? '' });
    });
  }

  // Every mapped header must be distinct after normalisation.
  const mapped: Array<[string, string | null]> = [
    ['outlet code', outletCode],
    ['outlet name', outletName],
    ['invoice date', invoiceDate],
    ['amount', amount],
    ['quantity', quantity],
    ...dimensions.map((d) => [`dimension "${d.key}"`, d.header || null] as [string, string | null]),
  ];
  const byHeader = new Map<string, string[]>();
  for (const [field, h] of mapped) {
    if (!h) continue;
    const n = normalizeHeader(h);
    byHeader.set(n, [...(byHeader.get(n) ?? []), field]);
  }
  for (const [h, fields] of byHeader) {
    if (fields.length > 1) errors.push(`Column "${h}" is mapped to more than one field (${fields.join(', ')}).`);
  }

  if (errors.length > 0) throw new BadRequestException(errors.join(' '));
  return {
    sheetName,
    headerRow,
    outletCode: outletCode!,
    outletName,
    invoiceDate: invoiceDate!,
    amount,
    quantity,
    dimensions,
    dateOrder,
  };
}

/**
 * Per-tenant column mapping CRUD (GET/PUT admin/sales-import/profile; plan §5.2, task K-1). OWNER: Lane K.
 * Callers have already passed assertSalesImportAccess; every query is keyed by the caller's clientId.
 */
@Injectable()
export class SalesProfileService {
  constructor(readonly prisma: PrismaService) {}

  async get(clientId: string): Promise<SalesColumnMapping | null> {
    const row = await this.prisma.salesImportProfile.findUnique({ where: { clientId } });
    return row ? (row.columnMapping as unknown as SalesColumnMapping) : null;
  }

  async put(user: JwtPayload, raw: unknown): Promise<SalesColumnMapping> {
    const mapping = validateColumnMapping(raw);
    const clientId = user.clientId;

    // A dimension still referenced by an ENABLED importer KPI cannot be removed (its filter would silently
    // match nothing → every outlet zero-filled on the next apply).
    const keys = new Set(mapping.dimensions.map((d) => d.key));
    const defs = await this.prisma.salesKpiDefinition.findMany({
      where: { clientId, enabled: true },
      select: { kpiCode: true, filter: true },
    });
    const broken = defs
      .map((d) => ({ kpiCode: d.kpiCode, missing: filterDimKeys(d.filter as never).filter((k) => !keys.has(k)) }))
      .filter((d) => d.missing.length > 0);
    if (broken.length > 0) {
      throw new BadRequestException(
        `These KPIs use dimensions you are removing: ${broken.map((b) => `${b.kpiCode} (${b.missing.join(', ')})`).join('; ')}. Edit or disable them first.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.salesImportProfile.findUnique({ where: { clientId } });
      const json = mapping as unknown as Prisma.InputJsonValue;
      await tx.salesImportProfile.upsert({
        where: { clientId },
        create: { clientId, columnMapping: json, updatedById: user.sub },
        update: { columnMapping: json, updatedById: user.sub },
      });
      await tx.auditLog.create({
        data: {
          action: before ? 'UPDATE' : 'CREATE',
          entityType: 'SALES_IMPORT_PROFILE',
          entityId: clientId,
          actorId: user.sub,
          oldValues: (before?.columnMapping ?? undefined) as Prisma.InputJsonValue | undefined,
          newValues: json,
          metadata: { clientId },
        },
      });
    });
    return mapping;
  }
}
