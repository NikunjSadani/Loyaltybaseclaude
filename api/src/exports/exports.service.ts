import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, type ExportRequest } from '@prisma/client';
import type { Request, Response } from 'express';
import { PassThrough } from 'node:stream';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { HEAVY_OP_RETRY_AFTER_SECONDS, heavyOpBusyException, heavyOpLimiter } from '../common/heavy-op-limiter';
import { createXlsxStreamWriter } from '../common/xlsx-stream';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ExportAccessChecker } from './export-access';
import type { AnyExportKind } from './export-kinds';
import { actorOf } from './exports-actor';
import {
  EXPORT_LIST_PAGE_SIZE,
  EXPORT_NOT_CONFIGURED_MESSAGE,
  EXPORT_QUEUED_MESSAGE,
  EXPORT_SELF_HEAL_AFTER_MS,
  EXPORT_SELF_HEAL_MIN_INTERVAL_MS,
  EXPORT_STALE_HEARTBEAT_MINUTES,
  EXPORT_TOO_MANY_ACTIVE_MESSAGE,
  EXPORT_UNKNOWN_KIND_MESSAGE,
  XLSX_CONTENT_TYPE,
} from './exports-engine.constants';
import { EXPORT_KIND_REGISTRY, abortableWriter, type ExportKindRegistry } from './exports-processor.service';
import { ExportsRunnerService } from './exports-runner.service';
import {
  EXPORT_MAX_ACTIVE_PER_USER,
  type ExportList,
  type ExportQueuedResponse,
  type ExportRequestDto,
  type ExportStatus,
} from './exports.contract';

/**
 * Server-set param merged into EVERY request's params (instant and queued): the external origin of the API as the
 * caller reached it (x-forwarded-proto/host → host), for reports that embed links back to the API (Outlet Master's
 * signed document links). A client-supplied value under this key is always overwritten.
 */
export const EXPORT_REQUEST_ORIGIN_PARAM = 'requestOrigin';

/** External origin for links: x-forwarded-proto/host → host → localhost (same rule as ReportsService.externalBase). */
export function externalOrigin(req?: Pick<Request, 'headers'> | null): string {
  const header = (name: string): string | undefined => {
    const v = req?.headers?.[name];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const proto = (header('x-forwarded-proto') || 'https').split(',')[0].trim();
  const host = (header('x-forwarded-host') || header('host') || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function withServerParams(raw: unknown, req?: Pick<Request, 'headers'> | null): Record<string, unknown> {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  base[EXPORT_REQUEST_ORIGIN_PARAM] = externalOrigin(req);
  return base;
}

/**
 * ExportsService — the API side of the Downloads page (platform/docs/plans/DOWNLOADS-PAGE.md).
 *
 *  respond(res, user, kind, rawParams)  — what an existing report endpoint returns: parses params, checks access, then
 *      light → streams the workbook instantly (200 xlsx, inside a heavy-operation slot), heavy → queues it (202
 *      ExportQueuedResponse). The endpoint must inject `@Res({ passthrough: true }) res`.
 *  request(user, kind, rawParams)       — queue one (validates, checks access, 3-active cap, kicks the worker).
 *  list / get / download                — the Downloads page.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);
  private lastSelfHealAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly moduleRef: ModuleRef,
    private readonly access: ExportAccessChecker,
    private readonly runner: ExportsRunnerService,
    @Inject(EXPORT_KIND_REGISTRY) private readonly kinds: ExportKindRegistry,
  ) {}

  private kindOrThrow(kindId: string): AnyExportKind {
    const def = this.kinds.get(kindId);
    if (!def) throw new BadRequestException(EXPORT_UNKNOWN_KIND_MESSAGE);
    return def;
  }

  // ─── Report endpoints ──────────────────────────────────────────────────────────────────────────

  /**
   * The one call an existing report endpoint makes:
   *   @Get('outlet-master') @Roles(...) @RequirePermission(...)
   *   outletMaster(@CurrentUser() user, @Query() q, @Res({ passthrough: true }) res: Response) {
   *     return this.exports.respond(res, user, 'outlet-master', q);
   *   }
   * Returns a StreamableFile (light: 200, streamed — the global interceptor passes it through unwrapped) or an
   * ExportQueuedResponse with status 202 (heavy — wrapped in the normal { success, data } envelope).
   * Throws 400 (params), 403 (access), 409 (3 active), 503 (busy instance / downloads not set up).
   */
  async respond(
    res: Response,
    user: JwtPayload,
    kindId: string,
    rawParams: unknown,
  ): Promise<StreamableFile | ExportQueuedResponse> {
    const def = this.kindOrThrow(kindId);
    await this.access.assert(user, def.access);
    const params = def.parseParams(withServerParams(rawParams, res.req), user);
    if (def.isHeavy(params)) {
      const queued = await this.enqueue(user, def, params);
      res.status(HttpStatus.ACCEPTED);
      return queued;
    }
    return this.streamNow(res, user, def, params);
  }

  /** Queue a heavy export for `user` (generic POST admin/exports, or a report endpoint that always queues). */
  async request(user: JwtPayload, kindId: string, rawParams: unknown, req?: Pick<Request, 'headers'> | null): Promise<ExportQueuedResponse> {
    const def = this.kindOrThrow(kindId);
    await this.access.assert(user, def.access);
    const params = def.parseParams(withServerParams(rawParams, req), user);
    return this.enqueue(user, def, params);
  }

  private async enqueue(user: JwtPayload, def: AnyExportKind, params: unknown): Promise<ExportQueuedResponse> {
    // Never build a heavy file inside the API as a fallback: that is the crash this page exists to prevent.
    if (!this.runner.isConfigured()) {
      throw new HttpException(EXPORT_NOT_CONFIGURED_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const id = await this.prisma.$transaction(async (tx) => {
      // Serialise this user's requests so two parallel clicks can't both pass the cap.
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`exports:${user.sub}`}))) AS l`);
      const active = await tx.exportRequest.count({
        where: { requestedById: user.sub, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (active >= EXPORT_MAX_ACTIVE_PER_USER) throw new ConflictException(EXPORT_TOO_MANY_ACTIVE_MESSAGE);
      const row = await tx.exportRequest.create({
        data: {
          clientId: user.clientId,
          requestedById: user.sub,
          kind: def.kind,
          params: params as Prisma.InputJsonValue,
          actor: actorOf(user) as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
        },
        select: { id: true },
      });
      return row.id;
    });
    // After commit; never throws. 'none' leaves it QUEUED for the self-heal kick / scheduler drain.
    const kicked = await this.runner.kick();
    if (kicked === 'none') this.logger.warn(`export ${id} (${def.kind}) queued but the worker could not be started now`);
    return { exportRequestId: id, message: EXPORT_QUEUED_MESSAGE };
  }

  /** Light path: run the kind straight into the HTTP response inside a heavy-operation slot. */
  private streamNow(res: Response, user: JwtPayload, def: AnyExportKind, params: unknown): StreamableFile {
    const release = heavyOpLimiter.tryAcquire(`export:${def.kind}`);
    if (!release) {
      res.setHeader('Retry-After', String(HEAVY_OP_RETRY_AFTER_SECONDS));
      throw heavyOpBusyException();
    }
    const now = new Date();
    const fileName = def.fileName(params, now);
    const pass = new PassThrough();
    const state: { aborted: Error | null } = { aborted: null };
    // Client went away (or the response errored) before the file finished → stop reading the DB at the next row.
    const onResClose = () => {
      if (!res.writableFinished && !state.aborted) state.aborted = new Error('client closed the download');
      release();
    };
    res.once('close', onResClose);

    const file = new StreamableFile(pass, { type: XLSX_CONTENT_TYPE, disposition: attachment(fileName) });
    file.setErrorHandler((err, response) => {
      this.logger.error(`instant export ${def.kind} failed mid-stream: ${err.message}`);
      if (response.destroyed) return;
      // Headers already out → cut the connection so the browser reports a failed download, never a corrupt file.
      if (response.headersSent) {
        (res as unknown as { destroy?: (e?: Error) => void }).destroy?.(err);
        return;
      }
      response.statusCode = 500;
      response.send("We couldn't prepare this file. Please try again.");
    });

    void (async () => {
      try {
        const out = abortableWriter(createXlsxStreamWriter(pass), () => state.aborted);
        await def.run({ prisma: this.prisma, moduleRef: this.moduleRef, clientId: user.clientId, user, now }, params, out);
        await out.finish();
      } catch (e) {
        if (!state.aborted) this.logger.error(`instant export ${def.kind} failed: ${(e as Error).stack ?? (e as Error).message}`);
        pass.destroy(e as Error);
      } finally {
        // Normal end: the slot is released by res 'close' once the last byte is flushed; on failure release now.
        if (state.aborted || pass.destroyed) release();
      }
    })();
    return file;
  }

  // ─── Downloads page ────────────────────────────────────────────────────────────────────────────

  /** The caller's own requests in their (assumed) tenant, newest first. Also self-heals a stuck queue. */
  async list(user: JwtPayload, cursor?: string): Promise<ExportList> {
    const rows = await this.prisma.exportRequest.findMany({
      where: { requestedById: user.sub, clientId: user.clientId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_LIST_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, EXPORT_LIST_PAGE_SIZE);
    void this.selfHeal(page);
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor: rows.length > EXPORT_LIST_PAGE_SIZE ? page[page.length - 1].id : null,
    };
  }

  async get(user: JwtPayload, id: string): Promise<ExportRequestDto> {
    return this.toDto(await this.loadVisible(user, id));
  }

  /** Stream a READY file from storage (never buffered). Same tenant + the report's access; owner or same-tenant admin. */
  async download(user: JwtPayload, id: string): Promise<StreamableFile> {
    const row = await this.loadVisible(user, id);
    if (row.status === 'EXPIRED') throw new GoneException('This file has expired. Please request it again.');
    if (row.status !== 'READY' || !row.storagePath) {
      throw new ConflictException(row.status === 'FAILED' ? row.error ?? "This file couldn't be prepared." : "This file isn't ready yet.");
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw new GoneException('This file has expired. Please request it again.');
    }
    const stream = this.storage.openReadStream(row.storagePath);
    const file = new StreamableFile(stream, {
      type: XLSX_CONTENT_TYPE,
      disposition: attachment(row.fileName ?? 'export.xlsx'),
      ...(row.sizeBytes != null ? { length: Number(row.sizeBytes) } : {}),
    });
    file.setErrorHandler((err, response) => {
      this.logger.error(`export ${row.id} download failed: ${err.message}`);
      if (response.destroyed) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      response.statusCode = 404;
      response.send('This file is no longer available. Please request it again.');
    });
    return file;
  }

  /**
   * A request the caller may see: same tenant (cross-tenant → 404, never revealing it exists) and the report's access
   * (re-checked now, so a revoked permission also revokes old files). A non-owner without access gets 404; the owner
   * gets 403 (they know it exists).
   */
  private async loadVisible(user: JwtPayload, id: string): Promise<ExportRequest> {
    const row = typeof id === 'string' && id.length <= 64 ? await this.prisma.exportRequest.findUnique({ where: { id } }) : null;
    if (!row || row.clientId !== user.clientId) throw new NotFoundException('Download not found.');
    const isOwner = row.requestedById === user.sub;
    const def = this.kinds.get(row.kind);
    if (!def) {
      if (isOwner) return row;
      throw new NotFoundException('Download not found.');
    }
    if (await this.access.allowed(user, def.access)) return row;
    if (isOwner) throw new ForbiddenException("You no longer have access to this report.");
    throw new NotFoundException('Download not found.');
  }

  private toDto(r: ExportRequest): ExportRequestDto {
    const def = this.kinds.get(r.kind);
    let paramsSummary = '';
    if (def) {
      try {
        paramsSummary = def.describeParams(r.params as unknown);
      } catch {
        paramsSummary = '';
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      label: def?.label ?? r.kind,
      paramsSummary,
      status: r.status as ExportStatus,
      fileName: r.fileName,
      sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes),
      rowCount: r.rowCount,
      error: r.status === 'FAILED' ? r.error : null,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Self-heal (scheduler drain optional): when the page shows a request that has waited too long (QUEUED for
   * > 2 min, or RUNNING with a stale heartbeat), start the worker again — at most once a minute per instance. Never throws.
   */
  private async selfHeal(rows: ExportRequest[]): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.lastSelfHealAt < EXPORT_SELF_HEAL_MIN_INTERVAL_MS) return;
      const staleBeat = now - EXPORT_STALE_HEARTBEAT_MINUTES * 60_000;
      const stuck = rows.some(
        (r) =>
          (r.status === 'QUEUED' && now - r.createdAt.getTime() > EXPORT_SELF_HEAL_AFTER_MS) ||
          (r.status === 'RUNNING' && (!r.heartbeatAt || r.heartbeatAt.getTime() < staleBeat)),
      );
      if (!stuck || !this.runner.isConfigured()) return;
      this.lastSelfHealAt = now;
      this.logger.warn('Downloads self-heal: a request is waiting too long; starting the worker');
      await this.runner.kick();
    } catch (e) {
      this.logger.warn(`Downloads self-heal failed: ${(e as Error).message}`);
    }
  }
}
