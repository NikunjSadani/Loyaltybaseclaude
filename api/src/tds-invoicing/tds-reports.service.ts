import { Injectable, Optional } from '@nestjs/common';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { creditUnusableReason, currentRetailerKeys, type CreditUnusableReason } from '../tds/tds-194r.shared';
import { financialYear } from '../tds/tds.helpers';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildXlsx } from '../common/xlsx';
import { formatINR } from '../common/money';
import { creditScopeNote, istDate, maskPan } from '../credits/tds-credit';

/**
 * Visibility-payout TDS reports service — Wave 1 Stream C, §6.
 *
 * Three read-only reports (JSON + .xlsx), all money in integer paise (BigInt), serialised to
 * strings for JSON with a rupee mirror for display; the .xlsx builder (buildXlsx) runs every
 * string cell through cellSafe (formula-injection guard) at the serialisation boundary.
 *
 *   1. payoutReport       — visibility-stream payout rows with each outlet's GST registration
 *                           type + the FROZEN tdsSection / tdsMethodology (stamped at confirm).
 *   2. unregisteredReport — invoices/payouts to UNREGISTERED retailers WITH invoice numbers, so
 *                           TGSL computes RCM off-portal (D6). GIFSY-only.
 *   3. recoveryReport     — TdsRecoveryEntry rows ("in lieu of TDS deduction", GROSS_UP pro-rata
 *                           tenant recovery/attribution) + a liability summary.
 *
 * SCOPING IS THE CALLER'S RESPONSIBILITY: the controller resolves `clientId` from the JWT
 * (CLIENT_ADMIN pinned to their own tenant; GIFSY_ADMIN platform-wide or ?clientId=) and passes
 * it here. An undefined clientId means platform-wide (GIFSY only).
 */

/** IST FY label ("2026-27") of a "YYYY-MM" period. */
function fyOfPeriod(period: string): string {
  const [y, m] = period.split('-').map((s) => parseInt(s, 10));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export interface ReportScope {
  /** undefined = platform-wide (GIFSY); a value = single-tenant scope. */
  clientId?: string;
  period?: string;
  fy?: string;
}

/** Fix round B (#21): server-side page of the TDS credits panel (absent → every credit, e.g. the export). */
export interface CreditPage {
  page: number;
  limit: number;
}

/** The last instant of an FY ("2025-26" → 1 Apr 2026 00:00 IST). */
function fyEndExclusive(fyLabel: string): Date {
  const y = parseInt(fyLabel.slice(0, 4), 10) + 1;
  return new Date(Date.UTC(y, 3, 1) - (5 * 60 + 30) * 60 * 1000);
}

type CreditDb = Pick<PrismaService, 'tdsCredit'> & Partial<Pick<PrismaService, 'client' | 'outlet'>>;

@Injectable()
export class TdsReportsService {
  constructor(
    private readonly prisma: PrismaService,
    // Final item 6: the client's current 194R method for the shared credit-usability rule (TenantSettingsService is
    // @Global; optional so the unit fixtures that build this service with a prisma fake alone keep working).
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  private money(paise: bigint): { paise: string; inr: number } {
    return { paise: paise.toString(), inr: Number(paise) / 100 };
  }

  private inr(paise: bigint): number {
    return Number(paise) / 100;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. PAYOUT REPORT — GST reg type + frozen TDS treatment
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Visibility-stream payout rows (those stamped with a frozen tdsSection at confirm) enriched
   * with the outlet's GST registration type + entity type from ChannelPartner. Legacy/incentive
   * payouts (tdsSection null) are excluded — this is the TDS-regime payout report.
   */
  async payoutReport(scope: ReportScope, creditPage?: CreditPage) {
    const where: Prisma.CreditPayoutEntryWhereInput = {
      // Only entries stamped under the visibility-payout TDS regime carry a frozen section.
      tdsSection: { not: null },
    };
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.period) where.period = scope.period;

    const entries = await this.prisma.creditPayoutEntry.findMany({
      where,
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        clientId: true,
        outletId: true,
        outletName: true,
        fieldName: true,
        period: true,
        amountPaise: true,
        tdsSection: true,
        tdsMethodology: true,
        tdsDeductedPaise: true,
        autoInvoiceId: true,
        autoInvoice: { select: { invoiceNumber: true } },
        // Fix round B (L1 / D1 / D3 / D4): reversal + TDS-credit call-outs per row.
        downloadId: true,
        tdsBaseReversedAt: true,
        reversalAllocations: {
          where: { state: { in: ['APPLIED_RECEIVABLE', 'APPLIED_CANCELLED'] } } /* owner D2: a fully withheld PAID payout reversed → CANCELLED, owed 0 */,
          select: { receivablePaise: true, tdsCreditPaise: true },
        },
        tdsCreditApplications: {
          where: { releasedAt: null },
          select: { amountPaise: true, tdsCredit: { select: { clientId: true } } },
        },
      },
    });

    // Enrich with partner GST reg type / entity type (one findMany, no N+1). FIX-E:
    // CreditPayoutEntry.outletId is the outlet CODE (not the PK), so the join is by outletCode
    // scoped by clientId (mirrors credits.service / tds.service) — the old id-based join never
    // matched and left every enriched column blank.
    const outletCodes = [...new Set(entries.map((e) => e.outletId))];
    const outlets = outletCodes.length
      ? await this.prisma.outlet.findMany({
          where: {
            outletCode: { in: outletCodes },
            ...(scope.clientId ? { clientId: scope.clientId } : {}),
          },
          select: {
            clientId: true,
            outletCode: true,
            partner: {
              select: {
                gstRegistrationType: true,
                entityType: true,
                panNumber: true,
                businessName: true,
              },
            },
          },
        })
      : [];
    const outletMap = new Map(outlets.map((o) => [`${o.clientId}|${o.outletCode}`, o]));
    // D3: the "less TDS after a reversal" lines of the downloads these rows went out in (none → no rows read).
    const handBackByEntry = await this.handBackByEntry(
      [...new Set(entries.filter((e) => e.downloadId).map((e) => e.downloadId!))],
    );
    // Audit B5 (LEGACY / Deoleo byte-identity): the WRE call-outs — and the tenant name that goes with them — only on
    // rows that carry one; every other row is shaped exactly as in 7ba69566 (and no extra query when none do).
    const notesByEntry = new Map(entries.map((e) => [e.id, this.rowTdsNotes(e, handBackByEntry.get(e.id) ?? 0n)]));
    const noted = entries.filter((e) => Object.keys(notesByEntry.get(e.id) ?? {}).length > 0);
    const clientNames = noted.length > 0 ? await this.clientNames([...new Set(noted.map((e) => e.clientId))]) : new Map<string, string>();

    const rows = entries.map((e) => {
      const o = outletMap.get(`${e.clientId}|${e.outletId}`);
      const notes = notesByEntry.get(e.id) ?? {};
      return {
        clientId: e.clientId,
        ...(Object.keys(notes).length > 0 ? { clientName: clientNames.get(e.clientId) ?? null } : {}),
        outletCode: e.outletId,
        outletName: e.outletName,
        businessName: o?.partner?.businessName ?? null,
        panNumber: o?.partner?.panNumber ?? null,
        gstRegistrationType: o?.partner?.gstRegistrationType ?? null,
        entityType: o?.partner?.entityType ?? null,
        fieldName: e.fieldName,
        period: e.period,
        amount: this.money(e.amountPaise),
        tdsSection: e.tdsSection,
        tdsMethodology: e.tdsMethodology,
        tdsDeducted: this.money(e.tdsDeductedPaise),
        invoiceNumber: e.autoInvoice?.invoiceNumber ?? null,
        ...notes,
      };
    });

    const totalAmountPaise = entries.reduce((s, e) => s + e.amountPaise, 0n);
    const totalTdsDeductedPaise = entries.reduce((s, e) => s + e.tdsDeductedPaise, 0n);
    const credits = await this.tdsCreditSection(this.prisma, scope, creditPage);

    return {
      scope: { clientId: scope.clientId ?? null, period: scope.period ?? null },
      count: rows.length,
      totals: {
        amount: this.money(totalAmountPaise),
        tdsDeducted: this.money(totalTdsDeductedPaise),
      },
      rows,
      // Policy round B: TDS credits from reversed PAID payouts — created / applied / outstanding (never silent).
      // Audit B5: only when the scope HAS credits (a tenant without V2 reversals gets the 7ba69566 response shape).
      ...(credits.count > 0 ? { tdsCredits: credits } : {}),
    };
  }

  /** Fix round B (#21): just the TDS credits panel page (scope = the report's tenant / period filters). */
  async creditsOnly(scope: ReportScope, creditPage: CreditPage) {
    return { scope: { clientId: scope.clientId ?? null, period: scope.period ?? null }, tdsCredits: await this.tdsCreditSection(this.prisma, scope, creditPage) };
  }

  /** Tenant id → display name (Client.internalName); missing → absent (callers fall back to the id). */
  private async clientNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0 || !this.prisma.client?.findMany) return new Map();
    const rows = await this.prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, internalName: true } });
    return new Map((rows ?? []).map((c) => [c.id, c.internalName]));
  }

  /** D3: entry → TDS the ledger lowered after a reversal, from the downloads' TDS_REVERSAL_ADJUSTMENT audit rows. */
  private async handBackByEntry(downloadIds: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (downloadIds.length === 0 || !this.prisma.auditLog?.findMany) return out;
    const audits = await this.prisma.auditLog.findMany({
      where: { entityType: 'TDS_REVERSAL_ADJUSTMENT', entityId: { in: downloadIds } },
      select: { metadata: true },
    });
    for (const a of audits ?? []) {
      const lines = ((a.metadata as { lines?: Array<{ entryId: string; handBackPaise: number }> } | null)?.lines ?? []);
      for (const l of lines) out.set(l.entryId, (out.get(l.entryId) ?? 0n) + BigInt(l.handBackPaise));
    }
    return out;
  }

  /**
   * L1 / D1 / D3 / D4 — the plain-words TDS call-outs of one payout row. Only present when something happened
   * (a row without a reversal or a credit is shaped exactly as before).
   */
  private rowTdsNotes(
    e: {
      clientId: string;
      amountPaise: bigint;
      tdsBaseReversedAt: Date | null;
      reversalAllocations: Array<{ receivablePaise: bigint; tdsCreditPaise: bigint }>;
      tdsCreditApplications: Array<{ amountPaise: bigint; tdsCredit: { clientId: string } | null }>;
    },
    handBackPaise: bigint,
  ): { reversedNote?: string; tdsCreditAppliedPaise?: number; tdsNote?: string } {
    const out: { reversedNote?: string; tdsCreditAppliedPaise?: number; tdsNote?: string } = {};
    if (e.tdsBaseReversedAt) {
      const alloc = e.reversalAllocations?.[0];
      out.reversedNote =
        `${formatINR(e.amountPaise)} reversed on ${istDate(e.tdsBaseReversedAt)} — off the PAN's TDS base` +
        (alloc
          ? alloc.receivablePaise > 0n
            ? `; ${formatINR(alloc.receivablePaise)} owed back (receivable)`
            : '; nothing owed back (the whole amount was withheld as TDS)'
          : '') +
        (alloc && alloc.tdsCreditPaise > 0n ? `; ${formatINR(alloc.tdsCreditPaise)} TDS credit` : '');
    }
    const apps = e.tdsCreditApplications ?? [];
    const credit = apps.reduce((s, a) => s + a.amountPaise, 0n);
    const other = apps.filter((a) => a.tdsCredit && a.tdsCredit.clientId !== e.clientId).reduce((s, a) => s + a.amountPaise, 0n);
    const parts: string[] = [];
    if (credit - other > 0n) parts.push(`${formatINR(credit - other)} adjusted from earlier TDS credit`);
    if (other > 0n) parts.push(`${formatINR(other)} adjusted from earlier TDS credit (another programme)`);
    if (handBackPaise > 0n) parts.push(`${formatINR(handBackPaise)} less TDS: adjusted after a reversal brought PAN below the limit`);
    if (credit > 0n) out.tdsCreditAppliedPaise = Number(credit);
    if (parts.length > 0) out.tdsNote = `TDS lowered: ${parts.join(' · ')}`;
    return out;
  }

  /**
   * TDS credits (WALLET-REVERSAL-ENGINE-DESIGN.md §8.1) in scope: tenant (if any) + the FY of `period` (if any).
   * One row per credit (source = the reversed PAID payout) and one per use against a later payout's TDS (released
   * uses — that payout failed / was cancelled — are listed too, marked released). Shared with the 'tds-payouts'
   * export kind (its "TDS Credits" sheet). Money in BigInt paise.
   */
  async tdsCreditSection(db: CreditDb, scope: ReportScope, pageReq?: CreditPage) {
    const where: Prisma.TdsCreditWhereInput = {};
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.period) where.fyLabel = fyOfPeriod(scope.period);
    const credits = (await db.tdsCredit.findMany({
      where,
      orderBy: [{ fyLabel: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        clientId: true,
        panNumber: true,
        section: true,
        fyLabel: true,
        amountPaise: true,
        appliedPaise: true,
        createdAt: true,
        creditReversalId: true,
        sourcePayoutEntry: { select: { id: true, outletId: true, outletName: true, period: true, amountPaise: true, payeePartnerId: true } },
        applications: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            amountPaise: true,
            createdAt: true,
            releasedAt: true,
            releaseReason: true,
            downloadId: true,
            clientId: true,
            payoutEntry: { select: { id: true, outletId: true, outletName: true, period: true } },
          },
        },
      },
    })) ?? [];
    let created = 0n;
    let applied = 0n;
    for (const c of credits) {
      created += c.amountPaise;
      applied += c.appliedPaise;
    }
    // #21: a server-side page (the export asks for every credit — no page).
    const total = credits.length;
    const limit = pageReq ? Math.min(Math.max(pageReq.limit, 1), 100) : total || 1;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = pageReq ? Math.min(Math.max(pageReq.page, 1), pages) : 1;
    const pageRows = pageReq ? credits.slice((page - 1) * limit, page * limit) : credits;

    // L6: the PAN the source outlet's retailer holds TODAY — a credit on an older PAN is not applied automatically.
    const curPan = new Map<string, string | null>();
    if (pageRows.length > 0 && db.outlet?.findMany) {
      const outlets = await db.outlet.findMany({
        where: {
          OR: pageRows
            .filter((c) => c.sourcePayoutEntry?.outletId)
            .map((c) => ({ clientId: c.clientId, outletCode: c.sourcePayoutEntry!.outletId })),
        },
        select: { clientId: true, outletCode: true, partner: { select: { panNumber: true } } },
      });
      for (const o of outlets ?? []) {
        curPan.set(`${o.clientId}|${o.outletCode}`, o.partner?.panNumber?.trim().toUpperCase() ?? null);
      }
    }
    const names = new Map<string, string>();
    if (pageRows.length > 0 && db.client?.findMany) {
      const cs = await db.client.findMany({
        where: { id: { in: [...new Set(pageRows.map((c) => c.clientId))] } },
        select: { id: true, internalName: true },
      });
      for (const c of cs ?? []) names.set(c.id, c.internalName);
    }
    const now = new Date();
    // Final item 6: the ONE shared usability rule (creditUnusableReason — the same as credit creation and the 194R
    // report): FY closed / method gross-up / the RETAILER's current key differs. Method per client (fail-soft: an
    // unreadable policy skips only the method test); retailer key from the payout's payee snapshot.
    const r194 = pageRows.filter((c) => c.section === 'SEC_194R');
    const methodOf = new Map<string, string | null>();
    for (const cid of [...new Set(r194.map((c) => c.clientId))]) {
      try {
        methodOf.set(cid, this.tenantSettings ? (await this.tenantSettings.resolveTdsPolicy(cid)).methodology : null);
      } catch {
        methodOf.set(cid, null);
      }
    }
    const reasonOf = new Map<string, CreditUnusableReason | null>();
    for (const cid of methodOf.keys()) {
      const mine = r194.filter((c) => c.clientId === cid);
      const nowKeys = await currentRetailerKeys(
        this.prisma,
        cid,
        mine.map((c) => ({ key: c.panNumber, payeePartnerId: c.sourcePayoutEntry?.payeePartnerId ?? null })),
      );
      mine.forEach((c, i) =>
        reasonOf.set(
          c.id,
          creditUnusableReason(
            { fyLabel: c.fyLabel, key: c.panNumber },
            { currentFy: financialYear(now).fyLabel, methodology: methodOf.get(cid), currentKey: nowKeys[i] },
          ),
        ),
      );
    }
    let unusedCount = 0;
    let previousPanCount = 0;
    let methodCount = 0;
    const rows = pageRows.map((c) => {
      const left = c.amountPaise - c.appliedPaise;
      const fyClosed = now >= fyEndExclusive(c.fyLabel);
      // D2: a credit unused when its FY closed stays in that FY (TDS deposits belong to their FY).
      const unusedNote =
        fyClosed && left > 0n
          ? `${formatINR(left)} unused credit for FY ${c.fyLabel}, not carried forward — the retailer can claim it in their return for that year`
          : null;
      if (unusedNote) unusedCount++;
      const shared = reasonOf.get(c.id) ?? null;
      const nowPan = c.sourcePayoutEntry?.outletId ? curPan.get(`${c.clientId}|${c.sourcePayoutEntry.outletId}`) : undefined;
      const panChanged = reasonOf.has(c.id)
        ? shared === 'PAN_CHANGED'
        : !!nowPan && nowPan !== c.panNumber.trim().toUpperCase();
      const previousPanNote =
        left > 0n && panChanged
          ? `Credit on previous PAN ${maskPan(c.panNumber)} — not applied automatically (the retailer's key is now ` +
            `${nowPan ? maskPan(nowPan) : 'different'}); counted as excess on the 194R report — settle it off-platform`
          : null;
      if (previousPanNote) previousPanCount++;
      const methodNote =
        left > 0n && shared === 'GROSS_UP'
          ? `${formatINR(left)} credit can no longer be used — this programme's 194R method is gross-up now (no 194R is withheld); counted as excess on the 194R report`
          : null;
      if (methodNote) methodCount++;
      return {
        creditId: c.id,
        clientId: c.clientId,
        clientName: names.get(c.clientId) ?? null,
        panNumber: c.panNumber,
        panMasked: maskPan(c.panNumber),
        scopeNote: creditScopeNote(c.section, c.fyLabel),
        unusedNote,
        previousPanNote,
        ...(methodNote ? { methodNote } : {}),
        section: c.section,
        fyLabel: c.fyLabel,
        createdAt: c.createdAt.toISOString(),
        creditReversalId: c.creditReversalId,
        sourceEntryId: c.sourcePayoutEntry?.id ?? null,
        sourceOutletCode: c.sourcePayoutEntry?.outletId ?? null,
        sourceOutletName: c.sourcePayoutEntry?.outletName ?? null,
        sourcePeriod: c.sourcePayoutEntry?.period ?? null,
        sourceAmount: this.money(c.sourcePayoutEntry?.amountPaise ?? 0n),
        credit: this.money(c.amountPaise),
        applied: this.money(c.appliedPaise),
        outstanding: this.money(c.amountPaise - c.appliedPaise),
        applications: c.applications.map((a) => {
          // D4: a 194C credit may be used by another programme's payout on the same PAN — in a single-tenant view
          // that payout's details are not shown (another client's data), only that it happened.
          const otherProgramme = !!a.clientId && a.clientId !== c.clientId;
          const hide = otherProgramme && !!scope.clientId;
          return {
            applicationId: a.id,
            appliedAt: a.createdAt.toISOString(),
            amount: this.money(a.amountPaise),
            entryId: hide ? null : (a.payoutEntry?.id ?? null),
            outletCode: hide ? null : (a.payoutEntry?.outletId ?? null),
            outletName: hide ? null : (a.payoutEntry?.outletName ?? null),
            period: a.payoutEntry?.period ?? null,
            downloadId: hide ? null : a.downloadId,
            released: a.releasedAt !== null,
            releasedAt: a.releasedAt ? a.releasedAt.toISOString() : null,
            releaseReason: a.releaseReason,
            otherProgramme,
            note: a.releasedAt
              ? `${formatINR(a.amountPaise)} returned to the credit — that payout did not go through (${a.releaseReason ?? 'released'})`
              : otherProgramme
                ? `${formatINR(a.amountPaise)} adjusted against the TDS of another programme's payout on this PAN (194C)`
                : `${formatINR(a.amountPaise)} adjusted from earlier TDS credit against the TDS of payout ${a.payoutEntry?.id ?? ''}`,
          };
        }),
      };
    });
    const notes: string[] = [];
    if (unusedCount > 0) {
      notes.push(`${unusedCount} credit${unusedCount === 1 ? '' : 's'} on this page unused when the FY closed — not carried forward to the next FY.`);
    }
    if (previousPanCount > 0) {
      notes.push(`${previousPanCount} credit${previousPanCount === 1 ? ' is' : 's are'} on a retailer's previous PAN — not applied automatically.`);
    }
    if (methodCount > 0) {
      notes.push(`${methodCount} credit${methodCount === 1 ? '' : 's'} can no longer be used — the programme is on gross-up now (counted as excess).`);
    }
    return {
      count: total,
      totals: {
        created: this.money(created),
        applied: this.money(applied),
        outstanding: this.money(created - applied),
      },
      rows,
      ...(pageReq ? { pagination: { page, limit, total, pages } } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  // The .xlsx twin (GET …/payouts/export) is the 'tds-payouts' export kind (exports/kinds/batch2/tds-payouts.kind.ts):
  // the same columns, streamed in pages or prepared on the Downloads page.

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. UNREGISTERED-RETAILER / RCM REPORT — invoice numbers (GIFSY-only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Invoices raised to UNREGISTERED retailers, WITH invoice numbers, so TGSL computes the RCM
   * liability off-portal (D6). No GST is charged on these invoices; the report is the RCM source.
   * Filtered in-app by the partner's gstRegistrationType (AutoInvoice has no partner relation).
   */
  async unregisteredReport(scope: ReportScope) {
    const where: Prisma.AutoInvoiceWhereInput = {};
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.period) where.period = scope.period;

    const invoices = await this.prisma.autoInvoice.findMany({
      where,
      orderBy: [{ period: 'desc' }, { invoiceDate: 'desc' }],
      select: {
        id: true,
        clientId: true,
        invoiceNumber: true,
        partnerId: true,
        outletCode: true,
        period: true,
        invoiceDate: true,
        invoiceKind: true,
        subtotalPaise: true,
        gstPaise: true,
        totalPaise: true,
      },
    });

    // Resolve each invoice's partner GST registration type, then keep only UNREGISTERED.
    const partnerIds = [...new Set(invoices.map((inv) => inv.partnerId))];
    const partners = partnerIds.length
      ? await this.prisma.channelPartner.findMany({
          where: { id: { in: partnerIds } },
          select: {
            id: true,
            gstRegistrationType: true,
            businessName: true,
            ownerName: true,
            panNumber: true,
          },
        })
      : [];
    const partnerMap = new Map(partners.map((p) => [p.id, p]));

    const unregistered = invoices.filter(
      (inv) => partnerMap.get(inv.partnerId)?.gstRegistrationType === 'UNREGISTERED',
    );

    const rows = unregistered.map((inv) => {
      const p = partnerMap.get(inv.partnerId);
      return {
        clientId: inv.clientId,
        invoiceNumber: inv.invoiceNumber,
        invoiceKind: inv.invoiceKind,
        partnerId: inv.partnerId,
        businessName: p?.businessName ?? null,
        ownerName: p?.ownerName ?? null,
        panNumber: p?.panNumber ?? null,
        outletCode: inv.outletCode,
        period: inv.period,
        invoiceDate: inv.invoiceDate.toISOString(),
        subtotal: this.money(inv.subtotalPaise),
        gst: this.money(inv.gstPaise),
        total: this.money(inv.totalPaise),
      };
    });

    const totalSubtotalPaise = unregistered.reduce((s, inv) => s + inv.subtotalPaise, 0n);

    return {
      scope: { clientId: scope.clientId ?? null, period: scope.period ?? null },
      note: 'RCM is computed off-portal by TGSL from this list (D6).',
      count: rows.length,
      totals: { subtotal: this.money(totalSubtotalPaise) },
      rows,
    };
  }

  async unregisteredReportXlsx(scope: ReportScope): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.unregisteredReport(scope);
    const sheetRows = report.rows.map((r, i) => ({
      'S.No': i + 1,
      'Client': r.clientId,
      'Invoice No.': r.invoiceNumber,
      'Invoice Kind': r.invoiceKind,
      'Business Name': r.businessName ?? '',
      'Owner Name': r.ownerName ?? '',
      'PAN': r.panNumber ?? '',
      'Outlet Code': r.outletCode,
      'Period': r.period,
      'Invoice Date': r.invoiceDate,
      'Taxable Value (₹)': r.subtotal.inr,
    }));
    const buffer = buildXlsx([{ name: 'Unregistered-RCM', rows: sheetRows }]);
    const suffix = scope.clientId ? scope.clientId : 'all';
    return { buffer, filename: `unregistered-rcm-report-${suffix}.xlsx` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. TDS LIABILITY + TENANT-WISE RECOVERY / ATTRIBUTION REPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * TdsRecoveryEntry rows ("in lieu of TDS deduction") — the GROSS_UP pro-rata tenant recovery
   * ledger. Dashboard/report only (never on the invoice face — D11). Scoped by clientId (a tenant
   * sees only its own recovery liability; GIFSY sees all or one tenant) + optional FY.
   */
  async recoveryReport(scope: ReportScope) {
    const where: Prisma.TdsRecoveryEntryWhereInput = {};
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.fy) where.fyLabel = scope.fy;

    const entries = await this.prisma.tdsRecoveryEntry.findMany({
      where,
      orderBy: [{ fyLabel: 'desc' }, { createdAt: 'desc' }],
    });

    // FIX-9/FIX-B: no-PAN visibility recovery is written with panNumber='__NO_PAN__:<outletCode>'
    // (no AutoInvoice, no PAN aggregation). The outlet is encoded into panNumber (TdsRecoveryEntry
    // has no outletCode column) so the recovery telescopes per (clientId, outlet, FY). Flag those
    // rows (startsWith prefix) + subtotal them so the CA sees the tenant's no-PAN obligation, now
    // with per-outlet visibility in the panNumber cell.
    const NO_PAN = '__NO_PAN__';
    // B-L6: since D7 (owner 2026-11-18) only 194C is recovered from tenants. Any legacy 194R row (raised
    // before D7; prod had none) is kept OUT of the 194C rows/totals and listed in its own section.
    const legacy194R = entries.filter((e) => e.section === 'SEC_194R');
    const toRow = (e: (typeof entries)[number]) => ({
      clientId: e.clientId,
      panNumber: e.panNumber,
      isNoPan: e.panNumber.startsWith(NO_PAN),
      section: e.section,
      fyLabel: e.fyLabel,
      tdsInvoiceId: e.tdsInvoiceId,
      panTdsTotal: this.money(e.panTdsTotalPaise),
      tenantBase: this.money(e.tenantBasePaise),
      panBase: this.money(e.panBasePaise),
      tenantShare: this.money(e.tenantSharePaise),
      createdAt: e.createdAt.toISOString(),
    });
    const current = entries.filter((e) => e.section !== 'SEC_194R');
    const rows = current.map(toRow);

    const totalTenantSharePaise = current.reduce((s, e) => s + e.tenantSharePaise, 0n);
    const noPanTenantSharePaise = current
      .filter((e) => e.panNumber.startsWith(NO_PAN))
      .reduce((s, e) => s + e.tenantSharePaise, 0n);

    return {
      label: 'in lieu of TDS deduction',
      scope: { clientId: scope.clientId ?? null, fy: scope.fy ?? null },
      count: rows.length,
      totals: {
        tenantShare: this.money(totalTenantSharePaise),
        noPanTenantShare: this.money(noPanTenantSharePaise),
      },
      rows,
      earlier194R: {
        label: 'Earlier 194R recoveries (no longer raised)',
        count: legacy194R.length,
        totalTenantShare: this.money(legacy194R.reduce((s, e) => s + e.tenantSharePaise, 0n)),
        rows: legacy194R.map(toRow),
      },
    };
  }

  async recoveryReportXlsx(scope: ReportScope): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.recoveryReport(scope);
    const sheetRows = report.rows.map((r, i) => ({
      'S.No': i + 1,
      'Client': r.clientId,
      'PAN': r.panNumber,
      'No PAN?': r.isNoPan ? 'Y' : 'N',
      'Section': r.section,
      'FY': r.fyLabel,
      'PAN TDS Total (₹)': r.panTdsTotal.inr,
      'Tenant Base (₹)': r.tenantBase.inr,
      'PAN Base (₹)': r.panBase.inr,
      'Tenant Share — in lieu of TDS (₹)': r.tenantShare.inr,
      'TDS Invoice ID': r.tdsInvoiceId ?? '',
      'Recorded At': r.createdAt,
    }));
    const summaryRows = [
      { Metric: 'Rows', Value: report.count },
      { Metric: 'Total Tenant Share — in lieu of TDS (₹)', Value: report.totals.tenantShare.inr },
      { Metric: 'No-PAN Tenant Share — in lieu of TDS (₹)', Value: report.totals.noPanTenantShare.inr },
    ];
    const sheets = [
      { name: 'Recovery', rows: sheetRows },
      { name: 'Summary', rows: summaryRows },
    ];
    // B-L6: legacy 194R rows (no longer raised) on their own sheet — never mixed into the 194C figures.
    if (report.earlier194R.count > 0) {
      sheets.push({
        name: 'Earlier 194R (not raised)',
        rows: report.earlier194R.rows.map((r, i) => ({
          'S.No': i + 1,
          Client: r.clientId,
          PAN: r.panNumber,
          FY: r.fyLabel,
          'Tenant Share (₹)': r.tenantShare.inr,
          'TDS Invoice ID': r.tdsInvoiceId ?? '',
          'Recorded At': r.createdAt,
        })) as unknown as typeof sheetRows,
      });
    }
    const buffer = buildXlsx(sheets);
    const suffix = scope.clientId ? scope.clientId : 'all';
    return { buffer, filename: `tds-recovery-report-${suffix}.xlsx` };
  }
}
