import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  invoiceId: z.string().min(1),
  skuId: z.string().min(1),
  quantity: z.number().positive(),
  returnAmountPaise: z.number().int().min(0),
  returnReason: z.string().optional(),
  returnDate: z.string().transform((s) => new Date(s)),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { invoiceId, skuId, quantity, returnAmountPaise, returnReason, returnDate } = parsed.data

    // Find invoice
    const invoice = await prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) return err('Invoice not found', 404)

    // Check ownership
    if (authUser.role !== 'GIFSY_ADMIN' && invoice.partnerId !== authUser.userId) {
      return err('Forbidden', 403)
    }

    const returnRecord = await prisma.invoiceReturn.create({
      data: {
        invoiceId,
        skuId,
        quantity,
        returnAmountPaise,
        returnReason: returnReason ?? null,
        returnDate,
      },
    })

    return ok({ returnId: returnRecord.id })
  } catch (e: any) {
    console.error('[sales/returns]', e)
    return err('Failed to process return', 500)
  }
}
