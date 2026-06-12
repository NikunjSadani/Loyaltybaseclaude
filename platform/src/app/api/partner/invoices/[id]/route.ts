/**
 * PATCH /api/partner/invoices/[id]
 *
 * Allows a retailer to update their invoice number while
 * the invoice status is still GENERATED.
 *
 * Body: { invoiceNumber: string }
 *
 * Rules enforced here (not just on the client):
 *   - Invoice must exist
 *   - Invoice status must be GENERATED (locked once PAID)
 *   - New invoice number must be non-empty and contain only
 *     alphanumeric characters, hyphens, and slashes
 *   - Max length: 60 characters
 *
 * In DEMO_MODE the write is skipped and a success response is returned
 * so the UI can demonstrate the full flow without a real DB.
 */

import { NextRequest, NextResponse } from 'next/server';
import { MOCK_VISIBILITY_INVOICES } from '@/lib/invoice';

const INVOICE_NUMBER_RE = /^[A-Z0-9\-\/]+$/i;
const MAX_LEN = 60;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).invoiceNumber !== 'string'
  ) {
    return NextResponse.json(
      { error: 'Body must include invoiceNumber (string).' },
      { status: 400 },
    );
  }

  const newNumber = ((body as Record<string, unknown>).invoiceNumber as string).trim().toUpperCase();

  // ── Validate new number ───────────────────────────────────────────────────
  if (!newNumber) {
    return NextResponse.json(
      { error: 'Invoice number cannot be empty.' },
      { status: 422 },
    );
  }
  if (!INVOICE_NUMBER_RE.test(newNumber)) {
    return NextResponse.json(
      { error: 'Invoice number may only contain letters, numbers, hyphens, and slashes.' },
      { status: 422 },
    );
  }
  if (newNumber.length > MAX_LEN) {
    return NextResponse.json(
      { error: `Invoice number must be ${MAX_LEN} characters or fewer.` },
      { status: 422 },
    );
  }

  // ── Find invoice (mock lookup; replace with Prisma in production) ─────────
  const invoice = MOCK_VISIBILITY_INVOICES.find((inv) => inv.id === id);

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
  }

  if (invoice.status !== 'GENERATED') {
    return NextResponse.json(
      { error: 'Invoice number can only be edited while the invoice is in GENERATED status.' },
      { status: 409 },
    );
  }

  // ── Persist (DEMO_MODE: mutate in-memory array; production: Prisma) ───────
  const DEMO_MODE = process.env.DEMO_MODE !== 'false';

  if (DEMO_MODE) {
    // Mutate the shared mock array so the list page also reflects the change
    // within the same server process lifetime.
    invoice.invoiceNumber = newNumber;
    invoice.invoiceNumberEdited = true;
  } else {
    // Production path (uncomment and adapt when DB is wired):
    // await prisma.visibilityInvoice.update({
    //   where: { id },
    //   data: { invoiceNumber: newNumber, invoiceNumberEdited: true },
    // });
  }

  return NextResponse.json({
    id,
    invoiceNumber: newNumber,
    invoiceNumberEdited: true,
  });
}
