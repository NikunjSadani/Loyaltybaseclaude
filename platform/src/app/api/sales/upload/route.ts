import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

interface SalesRow {
  invoiceNumber: string
  invoiceDate: string
  outletId: string
  skuCode: string
  quantity: number
  unitPrice: number
  totalAmount: number
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return err('No file uploaded')

    const fileName = file.name.toLowerCase()
    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls') && !fileName.endsWith('.csv')) {
      return err('Only Excel (.xlsx, .xls) and CSV files are supported')
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null })

    if (rows.length === 0) return err('File is empty')

    const now = new Date()
    const errors: { row: number; error: string }[] = []
    const valid: SalesRow[] = []
    const seenInvoiceNumbers = new Set<string>()

    // Pre-fetch valid SKU codes and outlet IDs
    const [validSkus, validOutlets] = await Promise.all([
      prisma.sKU.findMany({ select: { code: true } }),
      prisma.outlet.findMany({ where: { status: 'ACTIVE' }, select: { id: true } }),
    ])
    const skuSet = new Set(validSkus.map((s) => s.code))
    const outletSet = new Set(validOutlets.map((o) => o.id))

    // Check existing invoice numbers in DB
    const allInvoiceNos = rows
      .map((r) => r['invoiceNumber'] ?? r['invoice_number'] ?? r['Invoice Number'])
      .filter(Boolean)
      .map(String)

    const existingInvoices = await prisma.invoice.findMany({
      where: { invoiceNumber: { in: allInvoiceNos } },
      select: { invoiceNumber: true },
    })
    const existingInvoiceSet = new Set(existingInvoices.map((i) => i.invoiceNumber))

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2 // 1-indexed + header
      const rowErrors: string[] = []

      const invoiceNumber = String(row['invoiceNumber'] ?? row['invoice_number'] ?? row['Invoice Number'] ?? '')
      const invoiceDateRaw = row['invoiceDate'] ?? row['invoice_date'] ?? row['Invoice Date']
      const outletId = String(row['outletId'] ?? row['outlet_id'] ?? row['Outlet ID'] ?? '')
      const skuCode = String(row['skuCode'] ?? row['sku_code'] ?? row['SKU Code'] ?? '')
      const quantity = Number(row['quantity'] ?? row['Quantity'] ?? 0)
      const unitPrice = Number(row['unitPrice'] ?? row['unit_price'] ?? row['Unit Price'] ?? 0)
      const totalAmount = Number(row['totalAmount'] ?? row['total_amount'] ?? row['Total Amount'] ?? 0)

      if (!invoiceNumber) rowErrors.push('Missing invoiceNumber')
      if (!invoiceDateRaw) rowErrors.push('Missing invoiceDate')
      if (!outletId) rowErrors.push('Missing outletId')
      if (!skuCode) rowErrors.push('Missing skuCode')
      if (!quantity || quantity <= 0) rowErrors.push('Invalid quantity')
      if (!unitPrice || unitPrice <= 0) rowErrors.push('Invalid unitPrice')

      const invoiceDate = invoiceDateRaw instanceof Date ? invoiceDateRaw : new Date(invoiceDateRaw)
      if (isNaN(invoiceDate.getTime())) {
        rowErrors.push('Invalid invoiceDate format')
      } else if (invoiceDate > now) {
        rowErrors.push('Invoice date cannot be in the future')
      }

      if (skuCode && !skuSet.has(skuCode)) rowErrors.push(`Invalid SKU code: ${skuCode}`)
      if (outletId && !outletSet.has(outletId)) rowErrors.push(`Invalid outlet ID: ${outletId}`)
      if (invoiceNumber && existingInvoiceSet.has(invoiceNumber)) rowErrors.push(`Duplicate invoice number: ${invoiceNumber}`)
      if (invoiceNumber && seenInvoiceNumbers.has(invoiceNumber)) rowErrors.push(`Duplicate invoice number in file: ${invoiceNumber}`)

      if (rowErrors.length > 0) {
        errors.push({ row: rowNum, error: rowErrors.join('; ') })
      } else {
        seenInvoiceNumbers.add(invoiceNumber)
        valid.push({ invoiceNumber, invoiceDate: invoiceDate.toISOString(), outletId, skuCode, quantity, unitPrice, totalAmount })
      }
    }

    // Create upload batch
    const batch = await prisma.uploadBatch.create({
      data: {
        uploadedBy: authUser.userId,
        fileName: file.name,
        fileUrl: '',
        status: 'PROCESSING',
        totalRecords: rows.length,
        processedRecords: 0,
        failedRecords: errors.length,
      },
    })

    // Insert valid rows
    let uploaded = 0
    if (valid.length > 0) {
      for (const row of valid) {
        await prisma.invoice.create({
          data: {
            invoiceNumber: row.invoiceNumber,
            invoiceDate: new Date(row.invoiceDate),
            outletId: row.outletId,
            skuCode: row.skuCode,
            quantity: row.quantity,
            unitPricePaise: Math.round(row.unitPrice * 100),
            totalAmountPaise: Math.round(row.totalAmount * 100),
            uploadBatchId: batch.id,
            uploadedById: authUser.userId,
            status: 'PENDING',
          },
        })
        uploaded++
      }

      // Update batch status
      await prisma.uploadBatch.update({
        where: { id: batch.id },
        data: {
          status: errors.length > 0 ? 'PARTIAL' : 'COMPLETED',
          processedRecords: uploaded,
        },
      })

      // Trigger incentive calculation batch job (async, non-blocking)
      // In production, enqueue to a job queue (e.g. BullMQ)
      console.log(`[sales/upload] Triggering incentive calculation for batch ${batch.id}`)
    } else {
      await prisma.uploadBatch.update({
        where: { id: batch.id },
        data: { status: 'FAILED' },
      })
    }

    return ok({
      batchId: batch.id,
      uploaded,
      skipped: errors.length,
      errors,
    })
  } catch (e: any) {
    console.error('[sales/upload]', e)
    return err('Failed to process sales upload', 500)
  }
}
