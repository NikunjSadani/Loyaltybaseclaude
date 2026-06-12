/**
 * POST /api/admin/visibility/bulk-upload
 *
 * Admin-only endpoint that accepts a multipart .xlsx / .xls file and upserts
 * OutletVisibilityRecord rows for the current client.
 *
 * Auth:   CLIENT_ADMIN and GIFSY_ADMIN only.
 * Method: POST  (multipart/form-data, field name: "file")
 *
 * Response:
 *  {
 *    batchId:         string,
 *    rowCount:        number,
 *    successCount:    number,
 *    errorCount:      number,
 *    errorFileBase64: string | null   ← base64 .xlsx with "error_remarks" column
 *  }
 *
 * Audit trail:
 *  • OutletVisibilityUploadBatch created for every upload (who, when, file, counts)
 *  • OutletVisibilityAuditLog appended for every row whose status CHANGED
 */

import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { OutletVisibilityStatus } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import {
  parseVisibilityStatus,
  parseExcelDate,
  VISIBILITY_UPLOAD_HEADERS,
} from '@/lib/visibility-upload';

const ok  = (data: unknown, status = 200) =>
  NextResponse.json({ success: true,  data   }, { status });
const err = (message: string, status: number) =>
  NextResponse.json({ success: false, error: message }, { status });

const WRITE_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'];

// ─── Error row type ───────────────────────────────────────────────────────────

interface ErrorRow {
  rowNumber:                  number;
  outlet_id:                  string;
  month:                      string;
  status:                     string;
  date_of_capture:            string;
  approved_by:                string;
  captured_by_employee_id:    string;
  captured_by_employee_name:  string;
  captured_by_employee_phone: string;
  error_remarks:              string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!WRITE_ROLES.includes(authUser.role)) {
      return err(
        'Forbidden — only CLIENT_ADMIN and GIFSY_ADMIN can upload visibility data',
        403,
      );
    }

    const clientId = getClientIdFromRequest(req);

    // ── Parse form data ───────────────────────────────────────────────────────
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return err('Could not parse form data. Please send multipart/form-data.', 400);
    }

    const file = formData.get('file') as File | null;
    if (!file) {
      return err(
        'No file provided. Attach an .xlsx or .xls file with the field name "file".',
        400,
      );
    }

    const fileName  = file.name;
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (!['xlsx', 'xls'].includes(extension)) {
      return err(
        'Invalid file type. Please upload an .xlsx or .xls file using the downloaded template.',
        400,
      );
    }

    // ── Parse workbook ────────────────────────────────────────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    } catch {
      return err(
        'Could not parse the Excel file. Please use the downloaded template.',
        400,
      );
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return err('The Excel file appears to be empty.', 400);

    const sheet = workbook.Sheets[sheetName];
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
      raw:     true,
      defval:  '',
      header:  undefined,   // use first row as header
    });

    if (rows.length === 0) {
      return err('The Excel file has no data rows (only the header row found).', 400);
    }

    // ── Validate presence of required columns (case-insensitive) ─────────────
    const fileKeys      = Object.keys(rows[0]).map((k) => k.trim().toLowerCase());
    const missingCols   = VISIBILITY_UPLOAD_HEADERS.filter((h) => !fileKeys.includes(h));
    if (missingCols.length > 0) {
      return err(
        `Missing required columns: ${missingCols.join(', ')}. Please use the downloaded template.`,
        400,
      );
    }

    // ── Process rows ──────────────────────────────────────────────────────────
    type SuccessRow = {
      outletCode:              string;
      month:                   string;
      status:                  string;
      dateOfCapture:           Date | null;
      approvedBy:              string;
      capturedByEmployeeId:    string;
      capturedByEmployeeName:  string;
      capturedByEmployeePhone: string;
    };

    const successRows: SuccessRow[] = [];
    const errorRows:   ErrorRow[]   = [];

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2; // row 1 = header, data starts at row 2

      /** Case-insensitive cell reader */
      const get = (key: string): string => {
        // Try exact key first, then lowercase
        const val = row[key] ?? row[key.toLowerCase()] ?? '';
        return String(val).trim();
      };

      const outletCode  = get('outlet_id');
      const month       = get('month');
      const statusRaw   = get('status');
      const dateRawStr  = get('date_of_capture');
      // Also read the raw cell (may be a number for Excel serial dates)
      const dateRawCell = row['date_of_capture'] ?? row['Date_Of_Capture'] ?? dateRawStr;
      const approvedBy  = get('approved_by');
      const empId       = get('captured_by_employee_id');
      const empName     = get('captured_by_employee_name');
      const empPhone    = get('captured_by_employee_phone');

      const addError = (reason: string) => {
        errorRows.push({
          rowNumber:                  rowNum,
          outlet_id:                  outletCode,
          month,
          status:                     statusRaw,
          date_of_capture:            dateRawStr,
          approved_by:                approvedBy,
          captured_by_employee_id:    empId,
          captured_by_employee_name:  empName,
          captured_by_employee_phone: empPhone,
          error_remarks:              reason,
        });
      };

      // Required: outlet_id
      if (!outletCode) { addError('outlet_id is required'); continue; }

      // Required: month (YYYY-MM)
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        addError(`Invalid month "${month}". Expected format: YYYY-MM (e.g. 2026-06)`);
        continue;
      }

      // Required: status
      const parsedStatus = parseVisibilityStatus(statusRaw);
      if (!parsedStatus) {
        addError(
          `Invalid status "${statusRaw}". Allowed values: PENDING, UNDER_REVIEW, APPROVED (case-insensitive)`,
        );
        continue;
      }

      // Outlet must exist in DB
      const outlet = await prisma.outlet.findUnique({
        where:  { outletCode },
        select: { id: true },
      });
      if (!outlet) {
        addError(`Outlet code "${outletCode}" not found in the system. Check the spelling and try again.`);
        continue;
      }

      // Optional: date_of_capture
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
        status:                  parsedStatus,
        dateOfCapture,
        approvedBy,
        capturedByEmployeeId:    empId,
        capturedByEmployeeName:  empName,
        capturedByEmployeePhone: empPhone,
      });
    }

    // ── Create upload-batch record ─────────────────────────────────────────────
    const batch = await prisma.outletVisibilityUploadBatch.create({
      data: {
        clientId,
        uploadedByUserId: authUser.userId,
        fileName,
        rowCount:     rows.length,
        successCount: successRows.length,
        errorCount:   errorRows.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(errorRows.length > 0 && { errors: errorRows as any }),
      },
    });

    // ── Upsert records + write audit logs ─────────────────────────────────────
    type AuditEntry = {
      clientId:         string;
      outletCode:       string;
      month:            string;
      previousStatus:   OutletVisibilityStatus | null;
      newStatus:        OutletVisibilityStatus;
      uploadBatchId:    string;
      uploadedByUserId: string;
    };
    const auditEntries: AuditEntry[] = [];

    for (const row of successRows) {
      // Fetch existing record to track status changes
      const existing = await prisma.outletVisibilityRecord.findUnique({
        where: {
          clientId_outletCode_month: {
            clientId,
            outletCode: row.outletCode,
            month:      row.month,
          },
        },
        select: { status: true },
      });

      await prisma.outletVisibilityRecord.upsert({
        where: {
          clientId_outletCode_month: {
            clientId,
            outletCode: row.outletCode,
            month:      row.month,
          },
        },
        create: {
          clientId,
          outletCode:              row.outletCode,
          month:                   row.month,
          status:                  row.status as OutletVisibilityStatus,
          dateOfCapture:           row.dateOfCapture,
          approvedBy:              row.approvedBy   || null,
          capturedByEmployeeId:    row.capturedByEmployeeId    || null,
          capturedByEmployeeName:  row.capturedByEmployeeName  || null,
          capturedByEmployeePhone: row.capturedByEmployeePhone || null,
          uploadBatchId:           batch.id,
        },
        update: {
          status:                  row.status as OutletVisibilityStatus,
          dateOfCapture:           row.dateOfCapture,
          approvedBy:              row.approvedBy   || null,
          capturedByEmployeeId:    row.capturedByEmployeeId    || null,
          capturedByEmployeeName:  row.capturedByEmployeeName  || null,
          capturedByEmployeePhone: row.capturedByEmployeePhone || null,
          uploadBatchId:           batch.id,   // point to latest batch
        },
      });

      // Log only when status changed (or is brand-new)
      if (!existing || existing.status !== row.status) {
        auditEntries.push({
          clientId,
          outletCode:       row.outletCode,
          month:            row.month,
          previousStatus:   (existing?.status ?? null) as OutletVisibilityStatus | null,
          newStatus:        row.status as OutletVisibilityStatus,
          uploadBatchId:    batch.id,
          uploadedByUserId: authUser.userId,
        });
      }
    }

    if (auditEntries.length > 0) {
      await prisma.outletVisibilityAuditLog.createMany({ data: auditEntries });
    }

    // ── Build error Excel (base64) ────────────────────────────────────────────
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
      const errWs = XLSX.utils.aoa_to_sheet([errHeaders, ...errData]);
      errWs['!cols'] = errHeaders.map((h) => ({
        wch: h === 'error_remarks' ? 60 : h.length + 4,
      }));
      const errWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(errWb, errWs, 'Errors');
      const errBuf = XLSX.write(errWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      errorFileBase64 = errBuf.toString('base64');
    }

    return ok({
      batchId:        batch.id,
      rowCount:       rows.length,
      successCount:   successRows.length,
      errorCount:     errorRows.length,
      errorFileBase64,
    });

  } catch (e) {
    console.error('[visibility/bulk-upload] unexpected error:', e);
    return err('Internal server error', 500);
  }
}
