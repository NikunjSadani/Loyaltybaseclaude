/**
 * GET /api/admin/schemes/[id]/enrollments/export
 *
 * Returns an Excel (.xlsx) file with all enrollment records for the scheme,
 * including all standard fields, custom form fields, GPS columns, photo
 * columns, and a full audit trail.
 *
 * Access: GIFSY_ADMIN and CLIENT_ADMIN (both roles can download).
 *
 * In DEMO_MODE this uses the mock data from lib/campaign.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import {
  MOCK_ENROLLMENTS,
  buildExcelExportRows,
  type FormField,
} from '@/lib/campaign';

// Demo form fields — in production these come from the scheme's stored config
const DEMO_FORM_FIELDS: FormField[] = [
  {
    id: 'f-name', type: 'TEXT', label: 'Contact Name', required: true,
    order: 0, autoFillFromExcel: false, autoFillEditable: true,
  },
  {
    id: 'f-type', type: 'DROPDOWN', label: 'Shop Type', required: true,
    order: 1, options: ['Kirana', 'Supermarket', 'Pharmacy', 'Bakery'],
    autoFillFromExcel: false, autoFillEditable: false,
  },
  {
    id: 'f-area', type: 'NUMBER', label: 'Shop Area (sqft)', required: false,
    order: 2, autoFillFromExcel: true, autoFillEditable: true,
  },
  {
    id: 'f-photo', type: 'IMAGE', label: 'Shop Front Photo', required: true,
    order: 3, autoFillFromExcel: false, autoFillEditable: false,
  },
];

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: schemeId } = await params;

  // TODO: In production, verify session role is GIFSY_ADMIN or CLIENT_ADMIN here.
  // For demo we allow all requests.

  // Fetch enrollments for this scheme
  const enrollments = MOCK_ENROLLMENTS.filter(
    (e) => e.schemeId === schemeId || schemeId === 'SCH001',
  );

  if (enrollments.length === 0) {
    return NextResponse.json({ error: 'No enrollments found for this scheme.' }, { status: 404 });
  }

  // TODO: In production, fetch the scheme's form field config from the database.
  const formFields = DEMO_FORM_FIELDS;

  // Build flat rows
  const rows = buildExcelExportRows(enrollments, formFields);

  // Create xlsx
  const ws = XLSX.utils.json_to_sheet(rows);

  // Auto-size columns (approximate)
  const headers = Object.keys(rows[0] ?? {});
  ws['!cols'] = headers.map((h) => ({ wch: Math.min(Math.max(h.length + 4, 12), 40) }));

  // Freeze top row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Enrollments');

  const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as number[];
  const buf = new Uint8Array(raw);

  const filename = `enrollments_${schemeId}_${new Date().toISOString().split('T')[0]}.xlsx`;

  return new NextResponse(buf.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
