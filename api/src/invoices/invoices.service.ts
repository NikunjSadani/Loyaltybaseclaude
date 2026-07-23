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
import { resolveActivePartnerId } from '../common/partner-group.helper';

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

      // ── Line items (single line: visibility services) ─────────────────────
      const lineItems = [
        {
          description,
          sacCode: TECH_GIFSY.sacCode,
          amountPaise: Number(basePaise),
        },
      ];

      // The amount/snapshot fields a tuple-refresh writes (never the number/status).
      const refreshData = {
        subtotalPaise: basePaise,
        gstPaise: gst.gstPaise,
        gstType: gst.gstType ?? null,
        totalPaise: gst.totalPaise,
        lineItems: lineItems as unknown as Prisma.InputJsonValue,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      };

      // ── Assign number + persist (idempotent + collision-retrying) (AF-8) ──
      // Uniqueness is DB-enforced by exactly TWO constraints on AutoInvoice: the
      // (clientId,outletCode,period) TUPLE and a GLOBAL `invoiceNumber`. We don't
      // wrap the period in one big transaction (it would hold long locks); instead
      // each create is guarded by those constraints + a bounded retry, which is the
      // correct concurrency-safe pattern for a gap-tolerant unique sequence.
      //
      // On a P2002 we must know WHICH constraint fired. We DELIBERATELY do not parse
      // Prisma's `err.meta.target` — its shape is connector-specific (on PostgreSQL it
      // is the constraint NAME string, not a field array), so a substring/shape test is
      // fragile. Instead we check deterministically whether THIS outlet's invoice for
      // the period already exists (the only two constraints make this binary):
      //   • exists  → the TUPLE collided (re-run / concurrent run). Refresh amounts ONLY
      //     while still GENERATED — a PAID invoice is immutable (guarded updateMany
      //     matches 0 rows → skip).
      //   • absent  → the GLOBAL invoiceNumber collided (a MANUALLY-edited number, or a
      //     concurrent run's number, equals ours). The old code SKIPPED the outlet here →
      //     no invoice was ever issued (AF-8). We now BUMP the sequence and RETRY so the
      //     outlet always gets a unique number.
      // Numbers embed the outletCode (TGSL-VIS-<code>-<yyyymm>-<seq>), so a natural
      // cross-outlet collision is impossible and the retry is a rare safety net.
      let persisted = false;
      let numberCollisions = 0;
      const MAX_NUMBER_RETRIES = 50;

      while (!persisted) {
        existingCount += 1;
        const invoiceNumber = generateInvoiceNumber(outletCode, period, existingCount);
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
          persisted = true;
        } catch (err: unknown) {
          const isP2002 =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
          if (!isP2002) throw err;

          // Which constraint fired? Connector-agnostic: does this outlet's invoice
          // for the period already exist? (tenant-scoped read).
          const tupleExists = await this.prisma.autoInvoice.findFirst({
            where: { clientId, outletCode, period },
            select: { id: true },
          });

          if (!tupleExists) {
            // GLOBAL number collision — bump the sequence and retry; never skip.
            numberCollisions += 1;
            if (numberCollisions > MAX_NUMBER_RETRIES) {
              skipped.push({
                outletCode,
                reason: 'Could not assign a unique invoice number after retries',
              });
              persisted = true; // give up on THIS outlet, continue the run
            }
            continue;
          }

          // TUPLE conflict — refresh amounts ONLY while still GENERATED.
          const refreshed = await this.prisma.autoInvoice.updateMany({
            where: { clientId, outletCode, period, status: 'GENERATED' },
            data: refreshData,
          });
          if (refreshed.count > 0) {
            generated += 1;
          } else {
            skipped.push({
              outletCode,
              reason: 'Invoice already finalized (PAID) — not regenerated',
            });
          }
          persisted = true;
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
  async list(user: JwtPayload, q: ListInvoicesQueryDto, requestedPartnerId?: string) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = await this.buildScopedWhere(user, q, requestedPartnerId);
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
    requestedPartnerId?: string,
  ): Promise<Prisma.AutoInvoiceWhereInput | null> {
    const where: Prisma.AutoInvoiceWhereInput = { clientId: user.clientId };
    if (q.period) where.period = q.period;
    if (q.status) where.status = q.status as 'GENERATED' | 'PAID';
    if (q.outletCode) where.outletCode = q.outletCode;

    // Free-text search over the real invoice columns (invoiceNumber + outletCode),
    // case-insensitive. Combined with the scope/filter clauses above via AND (the
    // top-level `where` keys), so search NARROWS within the tenant scope — it can
    // never widen it. snapshot-only fields (firmName/outletName) are not queryable.
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { invoiceNumber: { contains: search, mode: 'insensitive' } },
        { outletCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (this.isPartnerRole(user.role)) {
      const partner = await this.resolveCallerPartner(user, requestedPartnerId);
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
    requestedPartnerId?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const where = await this.buildScopedWhere(user, q, requestedPartnerId);

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
  async getById(user: JwtPayload, id: string, requestedPartnerId?: string) {
    const { clientId } = user;

    const invoice = await this.prisma.autoInvoice.findFirst({
      where: { id, clientId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    // Partner-scope guard.
    if (this.isPartnerRole(user.role)) {
      const partner = await this.resolveCallerPartner(user, requestedPartnerId);
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
  async updateInvoiceNumber(
    user: JwtPayload,
    id: string,
    dto: UpdateInvoiceNumberDto,
    requestedPartnerId?: string,
  ) {
    const { clientId } = user;
    const newNumber = dto.invoiceNumber.trim().toUpperCase();

    const invoice = await this.prisma.autoInvoice.findFirst({
      where: { id, clientId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    // Partner-scope guard.
    if (this.isPartnerRole(user.role)) {
      const partner = await this.resolveCallerPartner(user, requestedPartnerId);
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
   * Resolve the ChannelPartner a partner request should read (Wave 3 login picker).
   *
   * Absent/own selector → the login's OWN partner (today's single-outlet behaviour).
   * A valid same-group same-phone sibling → that sibling (a switched context).
   * Any other selector → ForbiddenException (the shared access boundary in
   * partner-group.helper is the sole authority — never trust the raw selector).
   * Returns null when the login has no partner at all (caller short-circuits as today).
   */
  private async resolveCallerPartner(
    user: JwtPayload,
    requestedPartnerId?: string,
  ): Promise<{ id: string } | null> {
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    return partnerId ? { id: partnerId } : null;
  }
}
