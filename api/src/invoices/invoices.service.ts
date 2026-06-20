import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  TECH_GIFSY,
  buildInvoiceDescription,
  buildInvoiceExportXlsx,
  buildInvoiceUploadTemplate,
  computeGST,
  formatPeriodLabel,
  generateInvoiceNumber,
  type InvoiceExportRow,
} from './invoice.helpers';
import {
  GenerateInvoicesDto,
  ListInvoicesQueryDto,
  UpdateInvoiceNumberDto,
} from './dto/invoices.dto';

/**
 * Self-bill visibility invoicing service (P6.7).
 *
 * Visibility base source: CreditPayoutEntry.amountPaise summed per outletCode for the
 * given period, scoped to fields where CreditField.isSeparatePayout = true (the
 * visibility / separate-UTR payout fields). This is the canonical source because
 * CreditPayoutEntry rows are created at batch-confirm time, are already in integer
 * paise, and are GST-exclusive per the contract.
 *
 * OutletVisibilityRecord was considered as a fallback but has NO amountPaise field,
 * so it cannot serve as a money source. CreditPayoutEntry is the only viable source.
 *
 * Idempotency: enforced by @@unique([clientId, outletCode, period]) on AutoInvoice.
 * The upsert create path catches Prisma P2002 (unique violation) and skips, so a
 * second run for the same period returns the same result without double-issuing.
 *
 * TDS: OUT OF SCOPE (deferred to P6.5). Not computed here.
 * PDF generation: OUT OF SCOPE (P6.8). pdfUrl stays null.
 * Email delivery: OUT OF SCOPE (P6.9). emailSentAt stays null.
 */
@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── generateForPeriod ──────────────────────────────────────────────────────

  /**
   * AUTOMATIC, IDEMPOTENT generation — one AutoInvoice per outlet per period.
   *
   * Steps:
   *  1. Find all separate-payout CreditField ids for this tenant.
   *  2. Sum CreditPayoutEntry.amountPaise per outletCode for those fields in the period.
   *  3. For each outlet with a positive base, load the ChannelPartner KYC snapshot.
   *  4. Skip outlets where KYC is incomplete (no panNumber, no businessName/ownerName,
   *     or REGULAR without gstNumber). Return a `skipped` list with reasons.
   *  5. Compute GST via computeGST; persist via upsert (idempotent).
   *
   * @returns { generated: number; skipped: {outletCode, reason}[] }
   */
  async generateForPeriod(user: JwtPayload, dto: GenerateInvoicesDto) {
    const { clientId } = user;
    const { period } = dto;

    // ── Step 1: resolve separate-payout field IDs ───────────────────────────
    const separateFields = await this.prisma.creditField.findMany({
      where: { clientId, isSeparatePayout: true, isActive: true },
      select: { id: true },
    });
    const separateFieldIds = separateFields.map((f) => f.id);

    // If there are no separate-payout fields yet, nothing to invoice.
    if (separateFieldIds.length === 0) {
      return { generated: 0, skipped: [], message: 'No separate-payout fields configured.' };
    }

    // ── Step 2: sum CreditPayoutEntry per outletCode for the period ─────────
    // We aggregate in application code (one query) because Prisma doesn't offer a
    // BigInt groupBy sum in all versions. The entry count is bounded (one per
    // outlet+field per period), so this is safe.
    const entries = await this.prisma.creditPayoutEntry.findMany({
      where: {
        clientId,
        period,
        fieldId: { in: separateFieldIds },
      },
      select: { outletId: true, amountPaise: true },
    });

    if (entries.length === 0) {
      return { generated: 0, skipped: [], message: `No visibility payout entries found for period ${period}.` };
    }

    // Group by outletCode (outletId is stored as outletCode in CreditPayoutEntry).
    const outletBaseMap = new Map<string, bigint>();
    for (const e of entries) {
      const prev = outletBaseMap.get(e.outletId) ?? 0n;
      outletBaseMap.set(e.outletId, prev + e.amountPaise);
    }

    const outletCodes = [...outletBaseMap.keys()];

    // ── Step 3: load outlet + partner data (KYC snapshot) ───────────────────
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId, outletCode: { in: outletCodes } },
      select: {
        outletCode: true,
        name: true,
        state: true,
        partnerId: true,
        partner: {
          select: {
            id: true,
            businessName: true,
            ownerName: true,
            phone: true,
            panNumber: true,
            gstNumber: true,
            entityType: true,
            gstRegistrationType: true,
            bankName: true,
            bankAccountNumber: true,
            ifscCode: true,
            // KYC approved ↔ partner has a non-null panNumber AND bankAccountNumber
            // (set at KYC approval side-effect). We also check the latest KycSubmission.
            kycSubmissions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    });

    const outletDbMap = new Map(outlets.map((o) => [o.outletCode, o]));

    // ── Step 4: per-outlet: KYC guard + GST compute + upsert ────────────────
    const skipped: { outletCode: string; reason: string }[] = [];
    let generated = 0;

    // Existing count for this (clientId, period) — used for sequential invoice number.
    let existingCount = await this.prisma.autoInvoice.count({
      where: { clientId, period },
    });

    const periodLabel = formatPeriodLabel(period);
    const description = buildInvoiceDescription(periodLabel);
    const invoiceDate = new Date();

    for (const outletCode of outletCodes) {
      const basePaise = outletBaseMap.get(outletCode)!;
      const outletDb = outletDbMap.get(outletCode);

      if (!outletDb) {
        skipped.push({ outletCode, reason: 'Outlet not found in master' });
        continue;
      }

      const partner = outletDb.partner;
      if (!partner) {
        skipped.push({ outletCode, reason: 'Outlet has no linked partner (KYC not started)' });
        continue;
      }

      // KYC-complete guard: require APPROVED KYC submission.
      const latestKyc = partner.kycSubmissions[0];
      if (!latestKyc || latestKyc.status !== 'APPROVED') {
        skipped.push({ outletCode, reason: `Partner KYC not approved (status: ${latestKyc?.status ?? 'none'})` });
        continue;
      }

      // Require panNumber.
      if (!partner.panNumber) {
        skipped.push({ outletCode, reason: 'Partner missing panNumber' });
        continue;
      }

      // Require businessName or ownerName (at least one).
      if (!partner.businessName && !partner.ownerName) {
        skipped.push({ outletCode, reason: 'Partner missing businessName and ownerName' });
        continue;
      }

      // REGULAR retailers must have gstNumber.
      if (partner.gstRegistrationType === 'REGULAR' && !partner.gstNumber) {
        skipped.push({ outletCode, reason: 'REGULAR GST retailer missing gstNumber' });
        continue;
      }

      // ── Compute GST ──────────────────────────────────────────────────────
      const gst = computeGST(basePaise, partner.gstRegistrationType, partner.gstNumber);

      // ── Build snapshot (frozen at generation time) ────────────────────────
      const snapshot = {
        outletCode,
        outletName: outletDb.name,
        firmName: partner.businessName,
        partnerName: partner.ownerName,
        mobile: partner.phone,
        retailerState: outletDb.state,
        retailerGstin: partner.gstNumber ?? null,
        panNumber: partner.panNumber,
        entityType: partner.entityType ?? null,
        gstRegistrationType: partner.gstRegistrationType ?? null,
        bankName: partner.bankName ?? null,
        accountNumber: partner.bankAccountNumber ?? null,
        ifscCode: partner.ifscCode ?? null,
        recipient: TECH_GIFSY,
        sacCode: TECH_GIFSY.sacCode,
        description,
      };

      // ── Assign invoice number (sequential per clientId + period) ──────────
      existingCount += 1;
      const seq = existingCount;
      const invoiceNumber = generateInvoiceNumber(outletCode, period, seq);

      // ── Line items (single line: visibility services) ─────────────────────
      const lineItems = [
        {
          description,
          sacCode: TECH_GIFSY.sacCode,
          amountPaise: Number(basePaise),
        },
      ];

      // ── Idempotent persist on @@unique([clientId, outletCode, period]) ────
      // Try create; on conflict, refresh amounts ONLY while still GENERATED. A
      // re-run must NEVER mutate a PAID (locked) invoice's money/snapshot, and
      // never change its number or status.
      try {
        await this.prisma.autoInvoice.create({
          data: {
            clientId,
            invoiceNumber,
            partnerId: partner.id,
            outletCode,
            period,
            invoiceDate,
            status: 'GENERATED',
            invoiceNumberEdited: false,
            lineItems: lineItems as unknown as Prisma.InputJsonValue,
            subtotalPaise: basePaise,
            gstPaise: gst.gstPaise,
            gstType: gst.gstType ?? null,
            totalPaise: gst.totalPaise,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
          },
        });
        generated += 1;
      } catch (err: unknown) {
        const isP2002 =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!isP2002) throw err;
        // Disambiguate WHICH unique constraint fired. AutoInvoice has TWO: the
        // (clientId,outletCode,period) tuple AND a global `invoiceNumber` unique.
        // Only the tuple means "this outlet's invoice for this period already
        // exists" → safe to refresh its amounts. A collision on the global
        // invoiceNumber (e.g. a previously EDITED number equals a freshly-computed
        // sequence) must NOT trigger the blind updateMany below — that could mutate
        // a different outlet's row. Report it as a skip instead.
        const target = (err as Prisma.PrismaClientKnownRequestError).meta?.target;
        const targetStr = Array.isArray(target) ? target.join(',') : String(target ?? '');
        if (targetStr.includes('invoiceNumber')) {
          skipped.push({ outletCode, reason: 'Invoice number collision — not regenerated' });
          continue;
        }
        // Already exists (period tuple) — refresh amounts/snapshot ONLY if still
        // GENERATED. PAID invoices are immutable; the guarded updateMany skips
        // them (count 0).
        const refreshed = await this.prisma.autoInvoice.updateMany({
          where: { clientId, outletCode, period, status: 'GENERATED' },
          data: {
            subtotalPaise: basePaise,
            gstPaise: gst.gstPaise,
            gstType: gst.gstType ?? null,
            totalPaise: gst.totalPaise,
            lineItems: lineItems as unknown as Prisma.InputJsonValue,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
          },
        });
        if (refreshed.count > 0) {
          generated += 1;
        } else {
          skipped.push({ outletCode, reason: 'Invoice already finalized (PAID) or number collision — not regenerated' });
        }
      }
    }

    return { generated, skipped };
  }

  // ── list ───────────────────────────────────────────────────────────────────

  /**
   * List invoices — paginated + filtered.
   * - Admin (CLIENT_ADMIN / GIFSY_ADMIN): all tenant invoices.
   * - Partner: only invoices where AutoInvoice.partnerId = caller's partnerId.
   *
   * The `partnerId` on the JWT comes from the partner sub-system; we resolve it
   * via the ChannelPartner linked to the caller's userId.
   */
  async list(user: JwtPayload, q: ListInvoicesQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = await this.buildScopedWhere(user, q);
    // null where ⇒ partner role with no resolvable partner ⇒ empty page.
    if (!where) return { invoices: [], pagination: { page, limit, total: 0, pages: 0 } };

    const [invoices, total] = await Promise.all([
      this.prisma.autoInvoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { invoiceDate: 'desc' },
      }),
      this.prisma.autoInvoice.count({ where }),
    ]);

    return { invoices, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Build the tenant-scoped + filtered `where` for list/export.
   * Returns `null` when a partner caller has no resolvable ChannelPartner (so
   * the caller short-circuits to an empty result rather than leaking tenant-wide
   * rows). Every branch pins `clientId` from the JWT — never from client input.
   */
  private async buildScopedWhere(
    user: JwtPayload,
    q: ListInvoicesQueryDto,
  ): Promise<Prisma.AutoInvoiceWhereInput | null> {
    const where: Prisma.AutoInvoiceWhereInput = { clientId: user.clientId };
    if (q.period) where.period = q.period;
    if (q.status) where.status = q.status as 'GENERATED' | 'PAID';
    if (q.outletCode) where.outletCode = q.outletCode;

    if (this.isPartnerRole(user.role)) {
      const partner = await this.resolveCallerPartner(user);
      if (!partner) return null;
      where.partnerId = partner.id;
    }

    return where;
  }

  // ── exportXlsx (#44) ─────────────────────────────────────────────────────────

  /**
   * Export the filtered, tenant-scoped invoice set as an .xlsx workbook (#44).
   *
   * Reuses the SAME scoped `where` as list() — so an admin export is tenant-wide,
   * a partner export is restricted to their own invoices, and a partner with no
   * partner record gets an empty (header-only) sheet (never a tenant-wide leak).
   *
   * Money stays integer paise from the DB; conversion to ₹ happens once at the
   * Excel display edge inside buildInvoiceExportXlsx.
   *
   * @returns { buffer, filename }
   */
  async exportXlsx(
    user: JwtPayload,
    q: ListInvoicesQueryDto,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const where = await this.buildScopedWhere(user, q);

    const invoices = where
      ? await this.prisma.autoInvoice.findMany({
          where,
          orderBy: { invoiceDate: 'desc' },
        })
      : [];

    const periodLabel = q.period ? formatPeriodLabel(q.period) : undefined;
    return buildInvoiceExportXlsx(invoices as unknown as InvoiceExportRow[], periodLabel);
  }

  // ── uploadTemplate (#44) ──────────────────────────────────────────────────────

  /** Blank .xlsx template for the invoice-upload page (the dead-link fix, #44). */
  uploadTemplate(): Buffer {
    return buildInvoiceUploadTemplate();
  }

  // ── getById ────────────────────────────────────────────────────────────────

  /** Get a single invoice by id — tenant-scoped; partner sees only their own. */
  async getById(user: JwtPayload, id: string) {
    const { clientId } = user;

    const invoice = await this.prisma.autoInvoice.findFirst({
      where: { id, clientId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    // Partner-scope guard.
    if (this.isPartnerRole(user.role)) {
      const partner = await this.resolveCallerPartner(user);
      if (!partner || invoice.partnerId !== partner.id) {
        throw new ForbiddenException('Access denied');
      }
    }

    return invoice;
  }

  // ── updateInvoiceNumber ────────────────────────────────────────────────────

  /**
   * PATCH invoice number (#8).
   * - Trim + uppercase the value (caller sends raw; we normalise here).
   * - Status must be GENERATED; PAID → 409 "locked once PAID".
   * - Enforce uniqueness via catch P2002 → 409.
   * - Partner may edit only their own invoice.
   * - Sets invoiceNumberEdited = true.
   */
  async updateInvoiceNumber(user: JwtPayload, id: string, dto: UpdateInvoiceNumberDto) {
    const { clientId } = user;
    const newNumber = dto.invoiceNumber.trim().toUpperCase();

    const invoice = await this.prisma.autoInvoice.findFirst({
      where: { id, clientId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    // Partner-scope guard.
    if (this.isPartnerRole(user.role)) {
      const partner = await this.resolveCallerPartner(user);
      if (!partner || invoice.partnerId !== partner.id) {
        throw new ForbiddenException('Access denied');
      }
    }

    if (invoice.status === 'PAID') {
      throw new ConflictException('Invoice number is locked once PAID');
    }

    try {
      return await this.prisma.autoInvoice.update({
        where: { id },
        data: {
          invoiceNumber: newNumber,
          invoiceNumberEdited: true,
        },
      });
    } catch (err: unknown) {
      const isP2002 =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (isP2002) {
        throw new ConflictException('Invoice number already in use');
      }
      throw err;
    }
  }

  // ── markPaid ───────────────────────────────────────────────────────────────

  /**
   * Transition GENERATED → PAID (idempotent: PAID → no-op).
   * Locks the invoice number.
   * Admin-only (enforced on controller via @Roles).
   */
  async markPaid(user: JwtPayload, id: string) {
    const { clientId } = user;

    const invoice = await this.prisma.autoInvoice.findFirst({
      where: { id, clientId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'PAID') {
      // Idempotent re-call: return without error.
      return { ...invoice, message: 'Already PAID (no-op)' };
    }

    return this.prisma.autoInvoice.update({
      where: { id },
      data: { status: 'PAID' },
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private isPartnerRole(role: string): boolean {
    return ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'PARTNER'].includes(role);
  }

  /**
   * Resolve the ChannelPartner for the calling user (partner role).
   * Returns null if not found (caller has no partner record yet).
   */
  private async resolveCallerPartner(
    user: JwtPayload,
  ): Promise<{ id: string } | null> {
    return this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });
  }
}
