import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { id } = await params

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        outlet: true,
        sku: true,
        uploadBatch: { select: { id: true, fileName: true, createdAt: true } },
        uploadedBy: { select: { id: true, name: true } },
        lineItems: true,
      },
    })

    if (!invoice) return err('Invoice not found', 404)

    // Partners can only view their own invoices
    if (
      authUser.role !== 'GIFSY_ADMIN' &&
      authUser.role !== 'CLIENT_ADMIN' &&
      invoice.uploadedById !== authUser.userId
    ) {
      return err('Forbidden', 403)
    }

    return ok({ invoice })
  } catch (e: any) {
    console.error('[sales/invoices/[id]]', e)
    return err('Failed to fetch invoice', 500)
  }
}
