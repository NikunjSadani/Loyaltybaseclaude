import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { LimitedFileInterceptor, SPREADSHEET_UPLOAD_MAX_BYTES } from '../common/upload-limits';
import type { Response } from 'express';
import { streamObjectResponse } from '../common/stream-object';
import { CreditsService } from './credits.service';
import { CreditEvidenceService } from './credit-evidence.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateBatchDto,
  CreateFieldDto,
  CreatePayoutDownloadDto,
  CreateReversalDto,
  ListBatchesQueryDto,
  ListFieldsQueryDto,
  ListPayoutDownloadsQueryDto,
  ListReversalsQueryDto,
  PatchFieldDto,
  PayoutDownloadSummaryQueryDto,
  PatchReversalDto,
  PayoutReversalEntriesQueryDto,
  UtrUploadQueryDto,
} from './dto/credits.dto';
import { HeavyOp } from '../common/heavy-op-limiter';
import { WalletService } from '../wallet/wallet.service';
import { ReversalAttentionQueryDto, ReversalPauseDto, WalletsInDebtQueryDto } from './dto/reversal-engine.dto';

/**
 * Awards & Credits (§12a) — re-homed from
 * platform/src/app/api/admin/credits/* onto /v1/admin/credits.
 * Thin HTTP adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated) and @Roles. Responses are enveloped globally by
 * TransformInterceptor — except the payout-download xlsx, which streams as a
 * StreamableFile (passed through unwrapped).
 *
 * Role gates mirror the source: CLIENT_ADMIN + GIFSY_ADMIN for batch/field/outlet
 * management; GIFSY_ADMIN-only for payout downloads, UTR marking, and reversal
 * approval.
 */
@Controller('admin/credits')
export class CreditsController {
  constructor(
    private readonly credits: CreditsService,
    private readonly evidence: CreditEvidenceService,
    private readonly wallet: WalletService,
  ) {}

  // ─── Batches ───────────────────────────────────────────────────────────────

  @Get('batches')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listBatches(@CurrentUser() user: JwtPayload, @Query() query: ListBatchesQueryDto) {
    return this.credits.listBatches(user, query);
  }

  @Post('batches')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:upload')
  createBatch(@CurrentUser() user: JwtPayload, @Body() dto: CreateBatchDto) {
    return this.credits.createBatch(user, dto);
  }

  @Get('batches/:id')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  getBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.credits.getBatch(user, id);
  }

  @Post('batches/:id/confirm')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:confirm_payout')
  confirmBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.credits.confirmBatch(user, id);
  }

  @Get('batches/:id/reversals')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  async listBatchReversals(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    // Re-audit B4: same response shape as 7ba69566 when no remarks were typed.
    return (await this.credits.listBatchReversals(user, id)).map((r) => omitNullRequestRemarks(r));
  }

  @Post('batches/:id/reversals')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:request_reversal')
  async createReversal(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateReversalDto,
  ) {
    return omitNullRequestRemarks(await this.credits.createReversal(user, id, dto));
  }

  // WP5: entries a PAYOUT reversal may select (+ the tenant's reversal engine mode, which picks the form).
  @Get('batches/:id/payout-reversal-entries')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:request_reversal')
  listPayoutReversalEntries(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: PayoutReversalEntriesQueryDto,
  ) {
    return this.credits.listPayoutReversalEntries(user, id, query);
  }

  // ─── Batch audit-evidence attachments (B1) ─────────────────────────────────
  // Bulk-upload the client's offline visibility-audit photos/PDFs against a batch, so the
  // evidence behind a 194C visibility payout lives in-portal. CLIENT_ADMIN + GIFSY_ADMIN
  // (GIFSY works a tenant by assuming it). View streams auth-gated + inline-safe; delete is
  // blocked once the batch is confirmed (add-only audit trail).

  @Post('batches/:id/attachments')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:upload')
  @UseInterceptors(
    // Bulk path: cap files/request low so multer's in-RAM buffering is bounded (5 × 10 MB).
    // The FE (BatchEvidencePanel) sends ONE file per request — 5 × 10 MB in one body could exceed
    // the Next proxy's body cap and be silently truncated. The service re-checks size + sniffs each file.
    FilesInterceptor('files', 5, {
      limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    }),
  )
  uploadBatchAttachments(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.evidence.uploadEvidence(user, id, files);
  }

  @Get('batches/:id/attachments')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listBatchAttachments(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.evidence.listEvidence(user, id);
  }

  @Get('attachments/:id/media')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  async viewAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, size, contentType, fileName, inline } = await this.evidence.viewEvidence(user, id);
    // Private audit-proof media (may contain PII) — never cache in the browser or a shared proxy.
    // Mirrors the sibling KYC / scheme / visibility doc-view endpoints.
    res.setHeader('Cache-Control', 'no-store');
    // Sanitise the filename for the header (strip anything that could break/inject it).
    const safeName = (fileName || 'evidence').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    return streamObjectResponse(res, { stream, size }, {
      type: contentType,
      disposition: `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    });
  }

  @Delete('batches/:id/attachments/:attId')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:upload')
  deleteBatchAttachment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('attId') attId: string,
  ) {
    return this.evidence.deleteEvidence(user, id, attId);
  }

  // ─── Eligible outlets ──────────────────────────────────────────────────────

  @Get('eligible-outlets')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  eligibleOutlets(@CurrentUser() user: JwtPayload) {
    return this.credits.eligibleOutlets(user);
  }

  // ─── Outlet types (for the field award editor) ─────────────────────────────

  @Get('outlet-types')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listOutletTypes(@CurrentUser() user: JwtPayload) {
    return this.credits.listOutletTypes(user);
  }

  // ─── Fields ────────────────────────────────────────────────────────────────

  @Get('fields')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listFields(@CurrentUser() user: JwtPayload, @Query() query: ListFieldsQueryDto) {
    return this.credits.listFields(user, query);
  }

  @Post('fields')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:manage_fields')
  createField(@CurrentUser() user: JwtPayload, @Body() dto: CreateFieldDto) {
    return this.credits.createField(user, dto);
  }

  @Patch('fields/:id')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:manage_fields')
  patchField(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PatchFieldDto,
  ) {
    return this.credits.patchField(user, id, dto);
  }

  // ─── Payout downloads (GIFSY_ADMIN only) ───────────────────────────────────

  @Get('payout-downloads')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:download_bank_file')
  listPayoutDownloads(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListPayoutDownloadsQueryDto,
  ) {
    return this.credits.listPayoutDownloads(user, query);
  }

  @Post('payout-downloads')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:download_bank_file')
  @HeavyOp()
  async createPayoutDownload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePayoutDownloadDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | Record<string, unknown>> {
    const {
      buffer, noBankFileMessage, downloadCode, downloadId, fullyWithheld, fullyWithheldNote, heldEntries, heldNote,
      reversalHeld, tdsCreditApplied, tdsAdjustments,
    } = await this.credits.createPayoutDownload(
      user,
      dto,
    );
    // Policy round B: entries whose TDS an earlier TDS credit covered → the screen says so (never silent). Only sent
    // when there are any (a tenant without TDS credits — every LEGACY tenant — gets the response unchanged).
    if (tdsCreditApplied && tdsCreditApplied.length > 0) {
      res.setHeader('X-Tds-Credit-Applied-Count', String(tdsCreditApplied.length));
      res.setHeader('X-Tds-Credit-Applied-Paise', String(tdsCreditApplied.reduce((n, a) => n + a.creditPaise, 0)));
    }
    // Fix round B (D3): entries whose TDS the ledger lowered after a reversal took the PAN's base down. Headers are a
    // secondary path only — the screen reads GET …/payout-downloads/:id/summary (or latest-summary) as JSON.
    if (tdsAdjustments && tdsAdjustments.length > 0) {
      res.setHeader('X-Tds-Adjustment-Count', String(tdsAdjustments.length));
      res.setHeader('X-Tds-Adjustment-Paise', String(tdsAdjustments.reduce((n, a) => n + a.handBackPaise, 0)));
    }
    res.setHeader('X-Download-Code', downloadCode);
    res.setHeader('X-Download-Id', downloadId);
    // WP5: entries left out because a pending reversal holds them → the screen tells the admin (never silent).
    // Only sent when there are any (never on a LEGACY-engine tenant → response unchanged there).
    if (reversalHeld.length > 0) {
      res.setHeader('X-Reversal-Held-Count', String(reversalHeld.length));
      res.setHeader('X-Reversal-Held-Paise', String(reversalHeld.reduce((n, h) => n + h.amountPaise, 0)));
    }
    // A-H2: payouts fully withheld as TDS are NOT in the file — tell the operator (never silent).
    res.setHeader('X-Fully-Withheld-Count', String(fullyWithheld.length));
    if (fullyWithheldNote) res.setHeader('X-Fully-Withheld-Note', encodeURIComponent(fullyWithheldNote));
    // KYC-held payouts are NOT in the file either — never silent.
    res.setHeader('X-Held-Count', String(new Set(heldEntries.map((h) => h.outletId)).size));
    if (heldNote) res.setHeader('X-Held-Note', encodeURIComponent(heldNote));
    // A-L3: nothing for the bank → a JSON answer with the reason + the FULL lists, never an empty file.
    if (buffer === null) {
      return {
        noBankFile: true, message: noBankFileMessage, downloadCode, downloadId, fullyWithheld, heldEntries,
        // WRE call-outs travel with the JSON answer too (empty on a tenant without engine reversals / TDS credits).
        reversalHeld, tdsCreditApplied, tdsAdjustments,
      };
    }
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="payout-${downloadCode}.xlsx"`,
    });
  }

  // Fix round B (screens #1): the download's call-outs as JSON (held entries, TDS credit applied, D3 adjustments).
  @Get('payout-downloads/latest-summary')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:download_bank_file')
  latestPayoutDownloadSummary(@CurrentUser() user: JwtPayload, @Query() query: PayoutDownloadSummaryQueryDto) {
    return this.credits.payoutDownloadSummary(user, query);
  }

  @Get('payout-downloads/:id/summary')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:download_bank_file')
  payoutDownloadSummary(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.credits.payoutDownloadSummary(user, { id });
  }

  @Post('payout-downloads/:id/utr')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:mark_paid')
  @UseInterceptors(LimitedFileInterceptor('file', SPREADSHEET_UPLOAD_MAX_BYTES))
  uploadUtr(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Query() query: UtrUploadQueryDto,
    // Accept apply from EITHER the query string OR the multipart body: a FormData
    // POST naturally carries fields in the body, and reading only @Query silently
    // ran every "Apply" as a preview. Robust to both call shapes.
    @Body() body: { apply?: string } = {},
  ) {
    const apply = query.apply === 'true' || body?.apply === 'true';
    return this.credits.uploadUtr(user, id, file, apply);
  }

  // ─── Reversals (GIFSY_ADMIN only) ──────────────────────────────────────────

  @Get('reversals')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:read')
  async listReversals(@CurrentUser() user: JwtPayload, @Query() query: ListReversalsQueryDto) {
    const res = await this.credits.listReversals(user, query);
    return { ...res, reversals: res.reversals.map((r) => omitNullRequestRemarks(r)) };
  }

  @Patch('reversals/:id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:approve_reversal')
  async patchReversal(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PatchReversalDto,
  ) {
    return omitNullRequestRemarks(await this.credits.patchReversal(user, id, dto));
  }

  // ─── Wallet reversal engine call-outs (policy round A — "no silent pass-throughs") ─────────────────────
  // What blocks POINTS reversals for this tenant and why: approvals paused, wallets needing Gifsy attention,
  // unmapped credits, historical clawbacks "recovered X, owed Y". Read by the credits reversal screen banner.
  @Get('reversal-engine/attention')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  reversalAttention(@CurrentUser() user: JwtPayload, @Query() query: ReversalAttentionQueryDto) {
    return this.wallet.reversalAttention(user.clientId, { limit: query.limit });
  }

  // Audit item 9 (2026-11-19): every wallet of the tenant in debt (negative / recorded debt) with the reversal(s)
  // behind it — the "Wallets in debt" section of the credits reversal screen (no silent pass-throughs).
  @Get('reversal-engine/wallets-in-debt')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  walletsInDebt(@CurrentUser() user: JwtPayload, @Query() query: WalletsInDebtQueryDto) {
    return this.wallet.walletsInDebt(user.clientId, { limit: query.limit, programName: query.programName });
  }

  // GIFSY lifts (or sets) the POINTS reversal maintenance pause by hand — e.g. after a crashed backfill run.
  @Post('reversal-engine/pause')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:approve_reversal')
  setReversalPause(@CurrentUser() user: JwtPayload, @Body() dto: ReversalPauseDto) {
    // L6: the program worked in, or an explicit clientId — never silently Gifsy's own home tenant.
    return this.wallet.setPointsReversalPause(user, { paused: dto.paused, reason: dto.reason ?? null, clientId: dto.clientId ?? null });
  }

  // (POST reversal-engine/mode was removed 2026-11-21: the per-tenant engine mode is retired — one engine for all.)
}

/**
 * Audit B5 (LEGACY / Deoleo byte-identity): `CreditReversal.requestRemarks` (owner D5, 2026-11-16) is only in a
 * response when the requester actually typed remarks — a reversal without them is shaped exactly as in 7ba69566.
 */
function omitNullRequestRemarks<T>(r: T): T {
  if (r && typeof r === 'object' && 'requestRemarks' in r && (r as { requestRemarks?: unknown }).requestRemarks == null) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requestRemarks, ...rest } = r as T & { requestRemarks?: unknown };
    return rest as T;
  }
  return r;
}
