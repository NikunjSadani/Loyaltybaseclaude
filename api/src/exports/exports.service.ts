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
import { HEAVY_OP_RETRY_AFTER_SECONDS, heavyOpBusyException, instantExportLimiter } from '../common/heavy-op-limiter';
import { createXlsxStreamWriter } from '../common/xlsx-stream';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ExportAccessChecker } from './export-access';
import type { AnyExportKind } from './export-kinds';
import { actorOf, userFromActor } from './exports-actor';
import {
  EXPORT_ALREADY_QUEUED_MESSAGE,
  EXPORT_COULD_NOT_START_MESSAGE,
  EXPORT_INSTANT_IDLE_MS,
  EXPORT_LIST_PAGE_SIZE,
  EXPORT_NOT_CONFIGURED_MESSAGE,
  EXPORT_QUEUED_MESSAGE,
  EXPORT_SELF_HEAL_AFTER_MS,
  EXPORT_SELF_HEAL_MIN_INTERVAL_MS,
  EXPORT_STALE_HEARTBEAT_MINUTES,
  EXPORT_STUCK_QUEUED_MS,
  EXPORT_SWEEP_MIN_INTERVAL_MS,
  EXPORT_TOO_MANY_ACTIVE_MESSAGE,
  EXPORT_UNKNOWN_KIND_MESSAGE,
  XLSX_CONTENT_TYPE,
} from './exports-engine.constants';
import {
  EXPORT_KIND_REGISTRY,
  ExportsProcessorService,
  abortableWriter,
  type ExportKindRegistry,
} from './exports-processor.service';
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
 * caller reached it, for reports that embed links back to the API (Outlet Master's signed document links). A
 * client-supplied value under this key is always overwritten.
 */
export const EXPORT_REQUEST_ORIGIN_PARAM = 'requestOrigin';

/** The platform's own domain (env PLATFORM_DOMAIN — "gifsy.in" on staging and prod). */
function platformDomain(): string {
  return (process.env.PLATFORM_DOMAIN ?? '').replace(/^\uFEFF/, '').trim().toLowerCase() || 'gifsy.in';
}

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/;

/** A forwarded host we may put into links: the platform domain or one of its sub-domains, or a local dev host. */
function trustedForwardedHost(host: string): boolean {
  if (!HOST_RE.test(host)) return false;
  const name = host.replace(/:\d+$/, '');
  const domain = platformDomain();
  return name === domain || name.endsWith(`.${domain}`) || name === 'localhost' || name === '127.0.0.1';
}

/**
 * External origin for links. `x-forwarded-host` is caller-settable, so it is used ONLY when it is the platform's own
 * domain (PLATFORM_DOMAIN, e.g. *.gifsy.in — what the edge proxy sets); otherwise the request's own `host` (the host
 * that actually routed the request to this API) is used, else localhost. Proto is http/https only.
 */
export function externalOrigin(req?: Pick<Request, 'headers'> | null): string {
  const header = (name: string): string | undefined => {
    const v = req?.headers?.[name];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  };
  const first = (v?: string) => (v ?? '').split(',')[0].trim().toLowerCase();
  const protoRaw = first(header('x-forwarded-proto'));
  const proto = protoRaw === 'http' || protoRaw === 'https' ? protoRaw : 'https';
  const fwd = first(header('x-forwarded-host'));
  const own = first(header('host'));
  const host = fwd && trustedForwardedHost(fwd) ? fwd : own && HOST_RE.test(own) ? own : 'localhost';
  return `${proto}://${host}`;
}

function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * The params exactly as STORED on ExportRequest.params: the caller's RAW query/body plus the server-set
 * requestOrigin, JSON round-tripped so the API parses precisely what the worker will later read back from Postgres.
 *
 * Why raw (not parsed): a kind's parseParams validates its OWN input shape — strict DTOs refuse unknown fields, and a
 * kind's output (e.g. `platformWide`, `months[]`, `monthsRaw`) is not valid input. Storing the input means every path
 * (API validation / isHeavy, the worker, the Downloads summary) runs parseParams on the SAME input exactly once —
 * no kind has to be idempotent on its own output. Pinned for every registered kind by kinds/round-trip.spec.ts.
 */
export function storedParams(raw: unknown, req?: Pick<Request, 'headers'> | null): Record<string, unknown> {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  base[EXPORT_REQUEST_ORIGIN_PARAM] = externalOrigin(req);
  return JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
}

/** Stable JSON (sorted keys) of PARSED params without the server-set origin — "the same file" for de-duplication. */
export function exportDedupeKey(parsed: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .filter((k) => k !== EXPORT_REQUEST_ORIGIN_PARAM && o[k] !== undefined)
          .sort()
          .map((k) => [k, norm(o[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(parsed) ?? null);
}

/**
 * ExportsService — the API side of the Downloads page (platform/docs/plans/DOWNLOADS-PAGE.md).
 *
 *  respond(res, user, kind, rawParams)  — what an existing report endpoint returns: parses params, checks access, then
 *      light → streams the workbook instantly (200 xlsx, inside an instant-export slot), heavy → queues it (202
 *      ExportQueuedResponse). The endpoint must inject `@Res({ passthrough: true }) res`.
 *  request(user, kind, rawParams)       — queue one (validates, checks access, de-dupes, 3-active cap, kicks the worker).
 *  list / get / download                — the Downloads page (the requester's own requests only).
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);
  private lastSelfHealAt = 0;
  private lastSweepAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly moduleRef: ModuleRef,
    private readonly access: ExportAccessChecker,
    private readonly runner: ExportsRunnerService,
    @Inject(EXPORT_KIND_REGISTRY) private readonly kinds: ExportKindRegistry,
    private readonly processor: ExportsProcessorService,
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
   * Throws 400 (params), 403 (access), 409 (3 active), 503 (busy instance / downloads not set up / couldn't start).
   */
  async respond(
    res: Response,
    user: JwtPayload,
    kindId: string,
    rawParams: unknown,
  ): Promise<StreamableFile | ExportQueuedResponse> {
    const def = this.kindOrThrow(kindId);
    await this.access.assert(user, def.access);
    const raw = storedParams(rawParams, res.req);
    const params = def.parseParams(raw, user);
    if (def.isHeavy(params)) {
      const queued = await this.enqueue(user, def, raw, params);
      res.status(HttpStatus.ACCEPTED);
      return queued;
    }
    return this.streamNow(res, user, def, params);
  }

  /** Queue a heavy export for `user` (generic POST admin/exports, or a report endpoint that always queues). */
  async request(user: JwtPayload, kindId: string, rawParams: unknown, req?: Pick<Request, 'headers'> | null): Promise<ExportQueuedResponse> {
    const def = this.kindOrThrow(kindId);
    await this.access.assert(user, def.access);
    const raw = storedParams(rawParams, req);
    const params = def.parseParams(raw, user);
    return this.enqueue(user, def, raw, params);
  }

  /** Parse a stored request's raw params as its requester (Downloads summary / de-dupe). null when no longer valid. */
  private parseStored(def: AnyExportKind, r: Pick<ExportRequest, 'params' | 'requestedById' | 'actor'>): unknown {
    try {
      return def.parseParams(r.params as unknown, userFromActor(r.requestedById, r.actor));
    } catch {
      return null;
    }
  }

  private async enqueue(user: JwtPayload, def: AnyExportKind, raw: Record<string, unknown>, params: unknown): Promise<ExportQueuedResponse> {
    // Never build a heavy file inside the API as a fallback: that is the crash this page exists to prevent.
    if (!this.runner.isConfigured()) {
      throw new HttpException(EXPORT_NOT_CONFIGURED_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const key = exportDedupeKey(params);
    const outcome = await this.prisma.$transaction(async (tx) => {
      // Serialise this user's requests so two parallel clicks can't both pass the cap / both miss the de-dupe.
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`exports:${user.sub}`}))) AS l`);
      // Active = RUNNING, or QUEUED and not stuck (a request the worker never picked up must not block new ones).
      const stuckBefore = new Date(Date.now() - EXPORT_STUCK_QUEUED_MS);
      const active = await tx.exportRequest.findMany({
        where: {
          requestedById: user.sub,
          clientId: user.clientId,
          OR: [{ status: 'RUNNING' }, { status: 'QUEUED', createdAt: { gte: stuckBefore } }],
        },
        select: { id: true, kind: true, params: true, requestedById: true, actor: true },
        orderBy: { createdAt: 'asc' },
      });
      // Same user + tenant + report + filters already being prepared → hand back that one (no duplicate work).
      const same = active.find((r) => {
        if (r.kind !== def.kind) return false;
        const parsed = this.parseStored(def, r);
        return parsed !== null && exportDedupeKey(parsed) === key;
      });
      if (same) return { id: same.id, existing: true };
      if (active.length >= EXPORT_MAX_ACTIVE_PER_USER) throw new ConflictException(EXPORT_TOO_MANY_ACTIVE_MESSAGE);
      const row = await tx.exportRequest.create({
        data: {
          clientId: user.clientId,
          requestedById: user.sub,
          kind: def.kind,
          params: raw as Prisma.InputJsonValue,
          actor: actorOf(user) as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
        },
        select: { id: true },
      });
      return { id: row.id, existing: false };
    });
    if (outcome.existing) return { exportRequestId: outcome.id, message: EXPORT_ALREADY_QUEUED_MESSAGE };

    // After commit; kick never throws. 'none' = the worker could NOT be started (missing IAM grant 403, job missing
    // 404, network): fail THIS request now with a plain message instead of leaving it "Waiting to start" for a day.
    const kicked = await this.runner.kick();
    if (kicked === 'none') {
      this.logger.error(`export ${outcome.id} (${def.kind}): the Downloads worker could not be started — request FAILED`);
      await this.failQueued([outcome.id]);
      throw new HttpException(EXPORT_COULD_NOT_START_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { exportRequestId: outcome.id, message: EXPORT_QUEUED_MESSAGE };
  }

  /** QUEUED → FAILED ("couldn't start") for these ids; a row a worker already claimed is left alone. Never throws. */
  private async failQueued(ids: string[]): Promise<void> {
    if (!ids.length) return;
    try {
      await this.prisma.exportRequest.updateMany({
        where: { id: { in: ids }, status: 'QUEUED' },
        data: { status: 'FAILED', error: EXPORT_COULD_NOT_START_MESSAGE, finishedAt: new Date() },
      });
    } catch (e) {
      this.logger.error(`could not mark exports ${ids.join(',')} FAILED: ${(e as Error).message}`);
    }
  }

  /**
   * Light path: run the kind straight into the HTTP response inside an instant-export slot (its own small limit —
   * never the heavy-operation limiter, so slow clients can't block heavy routes). The stream is torn down when the
   * client goes away, and aborted when it makes no progress for EXPORT_INSTANT_IDLE_MS.
   */
  private streamNow(res: Response, user: JwtPayload, def: AnyExportKind, params: unknown): StreamableFile {
    const release = instantExportLimiter.tryAcquire(`export:${def.kind}`);
    if (!release) {
      res.setHeader('Retry-After', String(HEAVY_OP_RETRY_AFTER_SECONDS));
      throw heavyOpBusyException();
    }
    const now = new Date();
    const fileName = def.fileName(params, now);
    const pass = new PassThrough();
    const state: { aborted: Error | null; lastProgress: number } = { aborted: null, lastProgress: Date.now() };
    const abort = (why: string) => {
      if (state.aborted) return;
      state.aborted = new Error(why);
      // Destroy the data stream so a writer waiting on backpressure wakes up (it rejects) instead of hanging.
      pass.destroy();
      release();
    };
    // Client went away (or the response errored) before the file finished → stop at once.
    const onResClose = () => {
      if (!res.writableFinished) abort('client closed the download');
      release();
    };
    res.once('close', onResClose);
    // Idle safety: no row written / no drain for this long (stalled client) → abort and free the slot.
    const idle = setInterval(() => {
      if (Date.now() - state.lastProgress > EXPORT_INSTANT_IDLE_MS) {
        this.logger.warn(`instant export ${def.kind}: no progress for ${EXPORT_INSTANT_IDLE_MS} ms — aborting`);
        abort('instant export idle');
        (res as unknown as { destroy?: (e?: Error) => void }).destroy?.();
      }
    }, Math.min(30_000, Math.max(1_000, Math.floor(EXPORT_INSTANT_IDLE_MS / 4))));
    (idle as { unref?: () => void }).unref?.();

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
        const out = abortableWriter(createXlsxStreamWriter(pass), () => {
          state.lastProgress = Date.now();
          return state.aborted;
        });
        await def.run({ prisma: this.prisma, moduleRef: this.moduleRef, clientId: user.clientId, user, now }, params, out);
        await out.finish();
      } catch (e) {
        if (!state.aborted) this.logger.error(`instant export ${def.kind} failed: ${(e as Error).stack ?? (e as Error).message}`);
        pass.destroy(state.aborted ? undefined : (e as Error));
      } finally {
        clearInterval(idle);
        // Normal end: the slot is released by res 'close' once the last byte is flushed; on failure release now.
        if (state.aborted || pass.destroyed) release();
      }
    })();
    return file;
  }

  // ─── Downloads page ────────────────────────────────────────────────────────────────────────────

  /** The caller's own requests in their (assumed) tenant, newest first. Also runs the retention sweep + self-heal. */
  async list(user: JwtPayload, cursor?: string): Promise<ExportList> {
    void this.sweepIfDue();
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

  /** Stream a READY file from storage (never buffered). Requester only, same tenant, the report's access re-checked now. */
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
        // Mid-file: cut the connection (never end() normally — the browser would save a truncated file as complete).
        (response as unknown as { destroy?: (e?: Error) => void }).destroy?.(err);
        return;
      }
      response.statusCode = 404;
      response.send('This file is no longer available. Please request it again.');
    });
    return file;
  }

  /**
   * A request the caller may see: ONLY the requester, in the tenant it was requested in (anything else → 404, never
   * revealing it exists — an un-assumed owner's all-tenant file is invisible to other 'gifsy' users), and the report's
   * access re-checked now (a revoked permission also revokes the requester's old files → 403).
   */
  private async loadVisible(user: JwtPayload, id: string): Promise<ExportRequest> {
    const row = typeof id === 'string' && id.length <= 64 ? await this.prisma.exportRequest.findUnique({ where: { id } }) : null;
    if (!row || row.clientId !== user.clientId || row.requestedById !== user.sub) {
      throw new NotFoundException('Download not found.');
    }
    const def = this.kinds.get(row.kind);
    if (!def) return row;
    if (await this.access.allowed(user, def.access)) return row;
    throw new ForbiddenException('You no longer have access to this report.');
  }

  private toDto(r: ExportRequest): ExportRequestDto {
    const def = this.kinds.get(r.kind);
    let paramsSummary = '';
    if (def) {
      try {
        const parsed = this.parseStored(def, r);
        paramsSummary = parsed === null ? '' : def.describeParams(parsed);
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
   * Retention sweep from the API (QUEUED > 24 h → FAILED, expired READY → file deleted + EXPIRED, old rows purged) —
   * so it runs even when the worker job can never start (missing IAM grant). Bounded; at most once per
   * EXPORT_SWEEP_MIN_INTERVAL_MS per instance; never throws.
   */
  private async sweepIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < EXPORT_SWEEP_MIN_INTERVAL_MS) return;
    this.lastSweepAt = now;
    try {
      await this.processor.sweep();
    } catch (e) {
      this.logger.warn(`Downloads sweep failed: ${(e as Error).message}`);
    }
  }

  /**
   * Self-heal (scheduler drain optional): when the page shows a request that has waited too long (QUEUED for
   * > 2 min, or RUNNING with a stale heartbeat), start the worker again — at most once a minute per instance. If the
   * worker can't be started, the caller's waiting requests are FAILED with a plain message. Never throws.
   */
  private async selfHeal(rows: ExportRequest[]): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.lastSelfHealAt < EXPORT_SELF_HEAL_MIN_INTERVAL_MS) return;
      const staleBeat = now - EXPORT_STALE_HEARTBEAT_MINUTES * 60_000;
      const waiting = rows.filter((r) => r.status === 'QUEUED' && now - r.createdAt.getTime() > EXPORT_SELF_HEAL_AFTER_MS);
      const stuck =
        waiting.length > 0 || rows.some((r) => r.status === 'RUNNING' && (!r.heartbeatAt || r.heartbeatAt.getTime() < staleBeat));
      if (!stuck || !this.runner.isConfigured()) return;
      this.lastSelfHealAt = now;
      this.logger.warn('Downloads self-heal: a request is waiting too long; starting the worker');
      if ((await this.runner.kick()) === 'none') {
        this.logger.error('Downloads self-heal: the worker could not be started — failing the waiting requests');
        await this.failQueued(waiting.map((r) => r.id));
      }
    } catch (e) {
      this.logger.warn(`Downloads self-heal failed: ${(e as Error).message}`);
    }
  }
}
