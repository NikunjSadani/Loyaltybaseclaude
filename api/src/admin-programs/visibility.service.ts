import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { OutletVisibilityStatus, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListVisibilityRecordsQueryDto } from './dto/visibility.dto';
import {
  parseExcelDate,
  parseVisibilityStatus,
  VISIBILITY_UPLOAD_HEADERS,
} from './visibility/visibility-upload';
import { aoaToSheetSafe } from '../common/xlsx';

interface ErrorRow {
  rowNumber: number;
  outlet_id: string;
  month: string;
  status: string;
  date_of_capture: string;
  approved_by: string;
  captured_by_employee_id: string;
  captured_by_employee_name: string;
  captured_by_employee_phone: string;
  error_remarks: string;
}

/**
 * Outlet Visibility admin — ported from
 * platform/src/app/api/admin/visibility/{records,bulk-upload}/route.ts.
 *
 * Uses OutletVisibilityRecord / OutletVisibilityUploadBatch /
 * OutletVisibilityAuditLog (all KEPT). VisibilityProgram's `eligibleClasses`
 * is not touched by these routes. Tenant-scoped by clientId throughout.
 */
@Injectable()
export class VisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  /** Partner roles are external traders — they cannot see admin visibility data. */
  private static readonly PARTNER_ROLES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

  /**
   * Master Visibility gate — the module is opt-in per tenant (`visibilityEnabled`,
   * default OFF). A tenant's own users (CLIENT_ADMIN — clientId IS the tenant) get a
   * 403 when OFF. The GIFSY operator is EXEMPT only in TRUE platform context (`!assumed`);
   * when it has ASSUMED a tenant it acts AS that tenant, so the tenant's switch applies —
   * an operator cannot inject amount-upload records into an OFF assumed tenant. Mirrors the
   * photo service's gate.
   */
  private async assertVisibilityEnabled(user: JwtPayload): Promise<void> {
    if (user.role === 'GIFSY_ADMIN' && !user.assumed) return;
    const enabled = await this.tenant.resolveVisibilityEnabled(user.clientId);
    if (!enabled) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  /** GET /v1/admin/visibility/records */
  async listRecords(user: JwtPayload, q: ListVisibilityRecordsQueryDto) {
    await this.assertVisibilityEnabled(user);
    if (VisibilityService.PARTNER_ROLES.includes(user.role)) {
      throw new ForbiddenException('Forbidden');
    }
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.OutletVisibilityRecordWhereInput = { clientId: user.clientId };
    if (q.month) where.month = q.month;
    if (q.status) where.status = q.status;

    const [records, total] = await Promise.all([
      this.prisma.outletVisibilityRecord.findMany({
        where,
        orderBy: [{ month: 'desc' }, { outletCode: 'asc' }],
        skip,
        take: limit,
        include: {
          uploadBatch: {
            select: { fileName: true, createdAt: true, uploadedByUserId: true },
          },
        },
      }),
      this.prisma.outletVisibilityRecord.count({ where }),
    ]);

    return { records, total, page, limit };
  }

  /** POST /v1/admin/visibility/bulk-upload (multipart "file"). */
  async bulkUpload(user: JwtPayload, file: Express.Multer.File | undefined) {
    // Master gate — visibility must be enabled for the tenant.
    await this.assertVisibilityEnabled(user);

    // Mode gate — AMOUNT_UPLOAD tenants only.
    // Default mode is PHOTO_APPROVAL, so tenants that have not configured a mode
    // explicitly will be blocked here (they must opt-in to amount-upload).
    const captureMode = await this.tenant.resolveVisibilityCaptureMode(user.clientId);
    if (captureMode !== 'AMOUNT_UPLOAD') {
      throw new BadRequestException(
        'Tenant is not configured for amount-upload visibility. ' +
          'Set features.visibilityCaptureMode = "AMOUNT_UPLOAD" in the client config to enable this path.',
      );
    }

    if (!file) {
      throw new BadRequestException(
        'No file provided. Attach an .xlsx or .xls file with the field name "file".',
      );
    }

    const clientId = user.clientId;
    const fileName = file.originalname;
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (!['xlsx', 'xls'].includes(extension)) {
      throw new BadRequestException(
        'Invalid file type. Please upload an .xlsx or .xls file using the downloaded template.',
      );
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: false });
    } catch {
      throw new BadRequestException(
        'Could not parse the Excel file. Please use the downloaded template.',
      );
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new BadRequestException('The Excel file appears to be empty.');

    const sheet = workbook.Sheets[sheetName];
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
      raw: true,
      defval: '',
      header: undefined,
    });

    if (rows.length === 0) {
      throw new BadRequestException(
        'The Excel file has no data rows (only the header row found).',
      );
    }

    // Validate presence of required columns (case-insensitive).
    const fileKeys = Object.keys(rows[0]).map((k) => k.trim().toLowerCase());
    const missingCols = VISIBILITY_UPLOAD_HEADERS.filter((h) => !fileKeys.includes(h));
    if (missingCols.length > 0) {
      throw new BadRequestException(
        `Missing required columns: ${missingCols.join(', ')}. Please use the downloaded template.`,
      );
    }

    type SuccessRow = {
      outletCode: string;
      month: string;
      status: OutletVisibilityStatus;
      dateOfCapture: Date | null;
      approvedBy: string;
      capturedByEmployeeId: string;
      capturedByEmployeeName: string;
      capturedByEmployeePhone: string;
    };

    const successRows: SuccessRow[] = [];
    const errorRows: ErrorRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // row 1 = header, data starts at row 2

      const get = (key: string): string => {
        const val = row[key] ?? row[key.toLowerCase()] ?? '';
        return String(val).trim();
      };

      const outletCode = get('outlet_id');
      const month = get('month');
      const statusRaw = get('status');
      const dateRawStr = get('date_of_capture');
      const dateRawCell = row['date_of_capture'] ?? row['Date_Of_Capture'] ?? dateRawStr;
      const approvedBy = get('approved_by');
      const empId = get('captured_by_employee_id');
      const empName = get('captured_by_employee_name');
      const empPhone = get('captured_by_employee_phone');

      const addError = (reason: string) => {
        errorRows.push({
          rowNumber: rowNum,
          outlet_id: outletCode,
          month,
          status: statusRaw,
          date_of_capture: dateRawStr,
          approved_by: approvedBy,
          captured_by_employee_id: empId,
          captured_by_employee_name: empName,
          captured_by_employee_phone: empPhone,
          error_remarks: reason,
        });
      };

      if (!outletCode) {
        addError('outlet_id is required');
        continue;
      }

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        addError(`Invalid month "${month}". Expected format: YYYY-MM (e.g. 2026-06)`);
        continue;
      }

      const parsedStatus = parseVisibilityStatus(statusRaw);
      if (!parsedStatus) {
        addError(
          `Invalid status "${statusRaw}". Allowed values: PENDING, UNDER_REVIEW, APPROVED (case-insensitive)`,
        );
        continue;
      }

      const outlet = await this.prisma.outlet.findUnique({
        where: { clientId_outletCode: { clientId, outletCode } },
        select: { id: true },
      });
      if (!outlet) {
        addError(
          `Outlet code "${outletCode}" not found in the system. Check the spelling and try again.`,
        );
        continue;
      }

      let dateOfCapture: Date | null = null;
      if (dateRawCell && String(dateRawCell).trim() !== '') {
        dateOfCapture = parseExcelDate(dateRawCell);
        if (!dateOfCapture) {
          addError(
            `Invalid date_of_capture "${dateRawStr}". Expected format: DD-MM-YYYY (e.g. 15-06-2026)`,
          );
          continue;
        }
      }

      successRows.push({
        outletCode,
        month,
        status: parsedStatus,
        dateOfCapture,
        approvedBy,
        capturedByEmployeeId: empId,
        capturedByEmployeeName: empName,
        capturedByEmployeePhone: empPhone,
      });
    }

    // Create the upload-batch record.
    const batch = await this.prisma.outletVisibilityUploadBatch.create({
      data: {
        clientId,
        uploadedByUserId: user.sub,
        fileName,
        rowCount: rows.length,
        successCount: successRows.length,
        errorCount: errorRows.length,
        ...(errorRows.length > 0 && { errors: errorRows as unknown as Prisma.InputJsonValue }),
      },
    });

    // Upsert records + collect audit entries for status changes.
    type AuditEntry = {
      clientId: string;
      outletCode: string;
      month: string;
      previousStatus: OutletVisibilityStatus | null;
      newStatus: OutletVisibilityStatus;
      uploadBatchId: string;
      uploadedByUserId: string;
    };
    const auditEntries: AuditEntry[] = [];

    for (const row of successRows) {
      const existing = await this.prisma.outletVisibilityRecord.findUnique({
        where: {
          clientId_outletCode_month: { clientId, outletCode: row.outletCode, month: row.month },
        },
        select: { status: true },
      });

      await this.prisma.outletVisibilityRecord.upsert({
        where: {
          clientId_outletCode_month: { clientId, outletCode: row.outletCode, month: row.month },
        },
        create: {
          clientId,
          outletCode: row.outletCode,
          month: row.month,
          status: row.status,
          dateOfCapture: row.dateOfCapture,
          approvedBy: row.approvedBy || null,
          capturedByEmployeeId: row.capturedByEmployeeId || null,
          capturedByEmployeeName: row.capturedByEmployeeName || null,
          capturedByEmployeePhone: row.capturedByEmployeePhone || null,
          uploadBatchId: batch.id,
        },
        update: {
          status: row.status,
          dateOfCapture: row.dateOfCapture,
          approvedBy: row.approvedBy || null,
          capturedByEmployeeId: row.capturedByEmployeeId || null,
          capturedByEmployeeName: row.capturedByEmployeeName || null,
          capturedByEmployeePhone: row.capturedByEmployeePhone || null,
          uploadBatchId: batch.id,
        },
      });

      if (!existing || existing.status !== row.status) {
        auditEntries.push({
          clientId,
          outletCode: row.outletCode,
          month: row.month,
          previousStatus: existing?.status ?? null,
          newStatus: row.status,
          uploadBatchId: batch.id,
          uploadedByUserId: user.sub,
        });
      }
    }

    if (auditEntries.length > 0) {
      await this.prisma.outletVisibilityAuditLog.createMany({ data: auditEntries });
    }

    // Build error Excel (base64) when there are error rows.
    let errorFileBase64: string | null = null;
    if (errorRows.length > 0) {
      const errHeaders = [
        'row_number', 'outlet_id', 'month', 'status', 'date_of_capture',
        'approved_by', 'captured_by_employee_id', 'captured_by_employee_name',
        'captured_by_employee_phone', 'error_remarks',
      ];
      const errData = errorRows.map((r) => [
        r.rowNumber,
        r.outlet_id,
        r.month,
        r.status,
        r.date_of_capture,
        r.approved_by,
        r.captured_by_employee_id,
        r.captured_by_employee_name,
        r.captured_by_employee_phone,
        r.error_remarks,
      ]);
      const errWs = aoaToSheetSafe([errHeaders, ...errData]);
      errWs['!cols'] = errHeaders.map((h) => ({ wch: h === 'error_remarks' ? 60 : h.length + 4 }));
      const errWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(errWb, errWs, 'Errors');
      const errBuf = XLSX.write(errWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      errorFileBase64 = errBuf.toString('base64');
    }

    return {
      batchId: batch.id,
      rowCount: rows.length,
      successCount: successRows.length,
      errorCount: errorRows.length,
      errorFileBase64,
    };
  }
}
