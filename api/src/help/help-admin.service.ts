import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type HelpTopic } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { sniffFileType } from '../common/file-signature';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import { HelpMediaService } from './help-media.service';
import {
  cleanSteps,
  HELP_DESCRIPTION_MAX,
  HELP_POSTER_MAX_BYTES,
  HELP_POSTER_MIME,
  HELP_ROLES_MAX,
  HELP_STEP_MAX,
  HELP_STEPS_MAX,
  HELP_STEPS_MIN_TO_PUBLISH,
  HELP_TITLE_MAX,
  HELP_TOPICS_MAX_PER_TENANT,
  HELP_UPLOAD_PREFIX,
  HELP_VIDEO_MAX_BYTES,
  HELP_VIDEO_MAX_PARTS,
  HELP_VIDEO_PART_BYTES,
  mp4Problem,
  PARTNER_USER_ROLES,
  SALES_USER_ROLES,
  type HelpAudience,
} from './help.constants';
import type { CreateHelpTopicDto, ReorderHelpTopicsDto, UpdateHelpTopicDto } from './help.dto';

/** Console projection of a topic. Media URLs are short-lived PREVIEW tokens (work while unpublished). */
export interface HelpTopicAdminView {
  id: string;
  audience: HelpAudience;
  roles: string[];
  title: string;
  description: string | null;
  sortOrder: number;
  isPublished: boolean;
  steps: string[];
  hasVideo: boolean;
  videoBytes: number | null;
  videoUrl: string | null;
  posterUrl: string | null;
  updatedAt: Date;
}

export interface HelpRoleOption {
  code: string;
  label: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_RE = /^[A-Z0-9_-]{1,40}$/;

/**
 * Help & videos — Gifsy console authoring (GIFSY_ADMIN; tenancy:read / tenancy:write on the controller).
 * Operates on the PATH tenant (:slug), like every other per-client console route. Every change writes an
 * AuditLog row (entityType 'HelpTopic') IN THE SAME TRANSACTION as the change, so a change can never land
 * un-audited. Authoring works while the tenant flag is OFF (content can be prepared before go-live); the list
 * reports `flagOn` so the console says loudly that members do not see it yet.
 */
@Injectable()
export class HelpAdminService {
  private readonly logger = new Logger(HelpAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenant: TenantService,
    private readonly media: HelpMediaService,
  ) {}

  // ─── helpers ────────────────────────────────────────────────────────────────

  private assertGifsy(user: JwtPayload): void {
    // @Roles('GIFSY_ADMIN') already guards the controller; defence-in-depth for direct service use.
    if (user?.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Gifsy operators only.');
  }

  private async requireClient(slug: string): Promise<string> {
    const client = await this.prisma.client.findFirst({ where: { id: slug }, select: { id: true } });
    if (!client) throw new NotFoundException('Client not found');
    return client.id;
  }

  private async requireTopic(clientId: string, id: string): Promise<HelpTopic> {
    const topic = await this.prisma.helpTopic.findFirst({ where: { id, clientId, deletedAt: null } });
    if (!topic) throw new NotFoundException('Help topic not found');
    return topic;
  }

  private view(t: HelpTopic): HelpTopicAdminView {
    return {
      id: t.id,
      audience: t.audience as HelpAudience,
      roles: t.roles,
      title: t.title,
      description: t.description,
      sortOrder: t.sortOrder,
      isPublished: t.isPublished,
      steps: t.steps,
      hasVideo: !!t.videoKey,
      videoBytes: t.videoBytes,
      videoUrl: t.videoKey ? this.media.mintUrl(t.id, t.clientId, 'video', t.videoKey, true) : null,
      posterUrl: t.posterKey ? this.media.mintUrl(t.id, t.clientId, 'poster', t.posterKey, true) : null,
      updatedAt: t.updatedAt,
    };
  }

  private audit(
    tx: Prisma.TransactionClient,
    user: JwtPayload,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    topicId: string,
    slug: string,
    op: string,
    oldValues?: Record<string, unknown>,
    newValues?: Record<string, unknown>,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: user.sub,
        action,
        entityType: 'HelpTopic',
        entityId: topicId,
        ...(oldValues ? { oldValues: oldValues as Prisma.InputJsonValue } : {}),
        ...(newValues ? { newValues: newValues as Prisma.InputJsonValue } : {}),
        metadata: { slug, op, actorRole: user.role } as Prisma.InputJsonValue,
      },
    });
  }

  /** Validate + normalise the editable fields of a (merged) topic. Throws a human-worded 400. */
  private validate(input: {
    title: string;
    description: string | null;
    roles: string[];
    steps: string[];
    isPublished: boolean;
  }): { title: string; description: string | null; roles: string[]; steps: string[] } {
    const title = (input.title ?? '').trim();
    if (!title) throw new BadRequestException('Title is required.');
    if (title.length > HELP_TITLE_MAX) throw new BadRequestException(`Title must be at most ${HELP_TITLE_MAX} characters.`);

    const description = input.description == null ? null : input.description.trim() || null;
    if (description && description.length > HELP_DESCRIPTION_MAX) {
      throw new BadRequestException(`Short description must be at most ${HELP_DESCRIPTION_MAX} characters.`);
    }

    const roles: string[] = [];
    for (const raw of input.roles ?? []) {
      const r = String(raw).trim().toUpperCase();
      if (!r) continue;
      if (!ROLE_RE.test(r)) throw new BadRequestException(`"${raw}" is not a valid role code.`);
      if (!roles.includes(r)) roles.push(r);
    }
    if (roles.length > HELP_ROLES_MAX) throw new BadRequestException(`At most ${HELP_ROLES_MAX} roles.`);

    const steps = cleanSteps(input.steps);
    if (steps.length > HELP_STEPS_MAX) throw new BadRequestException(`A guide can have at most ${HELP_STEPS_MAX} steps.`);
    const longStep = steps.findIndex((s) => s.length > HELP_STEP_MAX);
    if (longStep >= 0) throw new BadRequestException(`Step ${longStep + 1} is too long (max ${HELP_STEP_MAX} characters).`);
    if (input.isPublished && steps.length < HELP_STEPS_MIN_TO_PUBLISH) {
      throw new BadRequestException(
        `Add at least ${HELP_STEPS_MIN_TO_PUBLISH} steps before publishing (this guide has ${steps.length}).`,
      );
    }
    return { title, description, roles, steps };
  }

  // ─── reads ──────────────────────────────────────────────────────────────────

  async list(user: JwtPayload, slug: string): Promise<{ flagOn: boolean; topics: HelpTopicAdminView[] }> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    const [rows, features] = await Promise.all([
      this.prisma.helpTopic.findMany({
        where: { clientId, deletedAt: null },
        orderBy: [{ audience: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      resolveTenantFeatures(this.tenant, clientId),
    ]);
    return { flagOn: features.helpVideos === true, topics: rows.map((r) => this.view(r)) };
  }

  /** Role-filter choices per audience: login roles + this tenant's hierarchy levels / outlet types. */
  async roleOptions(user: JwtPayload, slug: string): Promise<Record<HelpAudience, HelpRoleOption[]>> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    return this.optionsFor(clientId);
  }

  private async optionsFor(clientId: string): Promise<Record<HelpAudience, HelpRoleOption[]>> {
    const [levels, outletTypes] = await Promise.all([
      this.prisma.salesHierarchyLevel.findMany({ where: { clientId }, orderBy: { level: 'asc' }, select: { code: true, name: true } }),
      this.prisma.outletTypeClientConfig.findMany({
        where: { clientId },
        select: { outletType: { select: { code: true, name: true } } },
      }),
    ]);
    const merge = (base: HelpRoleOption[], extra: HelpRoleOption[]): HelpRoleOption[] => {
      const out = [...base];
      for (const o of extra) {
        const code = o.code.trim().toUpperCase();
        if (ROLE_RE.test(code) && !out.some((x) => x.code === code)) out.push({ code, label: o.label });
      }
      return out;
    };
    const SALES_LABELS: Record<string, string> = {
      SALES_HO: 'Sales HO (login role)',
      SALES_STATE_HEAD: 'State head (login role)',
      SALES_ASM: 'ASM (login role)',
      SALES_SO: 'SO (login role)',
      SALES_ISR: 'ISR (login role)',
    };
    const PARTNER_LABELS: Record<string, string> = {
      SSS: 'SSS (login role)',
      WHOLESALER: 'Wholesaler',
      SUB_STOCKIST: 'Sub-stockist (login role)',
    };
    return {
      SALES: merge(
        levels.map((l) => ({ code: l.code.toUpperCase(), label: `${l.name} (level)` })),
        SALES_USER_ROLES.map((r) => ({ code: r, label: SALES_LABELS[r] })),
      ),
      PARTNER: merge(
        outletTypes.map((o) => ({ code: o.outletType.code.toUpperCase(), label: `${o.outletType.name} (outlet type)` })),
        PARTNER_USER_ROLES.map((r) => ({ code: r, label: PARTNER_LABELS[r] })),
      ),
    };
  }

  /**
   * Every role in the filter must belong to the guide's audience (its login roles + this tenant's hierarchy levels
   * for SALES / outlet types for PARTNER). Catches an audience change that kept the other app's roles (which would
   * silently hide the guide from everyone) and stale codes — refused with a clear message, never dropped silently.
   */
  private async assertRolesFit(clientId: string, audience: HelpAudience, roles: string[]): Promise<void> {
    if (roles.length === 0) return;
    const allowed = new Set((await this.optionsFor(clientId))[audience].map((o) => o.code));
    const bad = roles.filter((r) => !allowed.has(r));
    if (bad.length > 0) {
      const app = audience === 'SALES' ? 'Sales app' : 'Partner app';
      const one = bad.length === 1;
      throw new BadRequestException(
        `${bad.join(', ')} ${one ? 'is not a' : 'are not'} ${app} role${one ? '' : 's'} for this client — untick ${one ? 'it' : 'them'} (if you changed "Shown in", choose the roles again).`,
      );
    }
  }

  // ─── writes ─────────────────────────────────────────────────────────────────

  async create(user: JwtPayload, slug: string, dto: CreateHelpTopicDto): Promise<HelpTopicAdminView> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    const v = this.validate({
      title: dto.title,
      description: dto.description ?? null,
      roles: dto.roles ?? [],
      steps: dto.steps ?? [],
      isPublished: false,
    });
    await this.assertRolesFit(clientId, dto.audience, v.roles);
    const created = await this.prisma.$transaction(async (tx) => {
      const count = await tx.helpTopic.count({ where: { clientId, deletedAt: null } });
      if (count >= HELP_TOPICS_MAX_PER_TENANT) {
        throw new BadRequestException(`This client already has ${HELP_TOPICS_MAX_PER_TENANT} guides — delete one first.`);
      }
      const last = await tx.helpTopic.findFirst({
        where: { clientId, audience: dto.audience, deletedAt: null },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const row = await tx.helpTopic.create({
        data: {
          clientId,
          audience: dto.audience,
          title: v.title,
          description: v.description,
          roles: v.roles,
          steps: v.steps,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          isPublished: false,
          createdById: user.sub,
        },
      });
      await this.audit(tx, user, 'CREATE', row.id, slug, 'create', undefined, {
        audience: row.audience,
        title: row.title,
        description: row.description,
        roles: row.roles,
        steps: row.steps,
      });
      return row;
    });
    return this.view(created);
  }

  async update(user: JwtPayload, slug: string, id: string, dto: UpdateHelpTopicDto): Promise<HelpTopicAdminView> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.helpTopic.findFirst({ where: { id, clientId, deletedAt: null } });
      if (!before) throw new NotFoundException('Help topic not found');
      const merged = {
        title: dto.title ?? before.title,
        description: dto.description !== undefined ? dto.description : before.description,
        roles: dto.roles ?? before.roles,
        steps: dto.steps ?? before.steps,
        isPublished: dto.isPublished ?? before.isPublished,
      };
      const v = this.validate(merged);
      const audience = dto.audience ?? (before.audience as HelpAudience);
      await this.assertRolesFit(clientId, audience, v.roles);
      const data: Prisma.HelpTopicUpdateInput = {
        title: v.title,
        description: v.description,
        roles: v.roles,
        steps: v.steps,
        isPublished: merged.isPublished,
        audience,
        updatedById: user.sub,
      };
      // Moving audience → append to the end of the new audience's order.
      if (audience !== before.audience) {
        const last = await tx.helpTopic.findFirst({
          where: { clientId, audience, deletedAt: null },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        data.sortOrder = (last?.sortOrder ?? -1) + 1;
      }
      const row = await tx.helpTopic.update({ where: { id: before.id }, data });

      const fields = ['audience', 'title', 'description', 'roles', 'steps', 'isPublished'] as const;
      const oldV: Record<string, unknown> = {};
      const newV: Record<string, unknown> = {};
      for (const f of fields) {
        if (JSON.stringify(before[f]) !== JSON.stringify(row[f])) {
          oldV[f] = before[f];
          newV[f] = row[f];
        }
      }
      if (Object.keys(newV).length > 0) {
        const op = 'isPublished' in newV ? (row.isPublished ? 'publish' : 'unpublish') : 'edit';
        await this.audit(tx, user, 'UPDATE', row.id, slug, op, oldV, newV);
      }
      return row;
    });
    return this.view(updated);
  }

  async reorder(user: JwtPayload, slug: string, dto: ReorderHelpTopicsDto): Promise<HelpTopicAdminView[]> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    const rows = await this.prisma.$transaction(async (tx) => {
      const current = await tx.helpTopic.findMany({
        where: { clientId, audience: dto.audience, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      const have = current.map((r) => r.id);
      const want = dto.ids;
      const sameSet = want.length === have.length && new Set(want).size === want.length && want.every((x) => have.includes(x));
      if (!sameSet) {
        throw new BadRequestException('The guide list changed since you loaded it — reload the page and try again.');
      }
      for (let i = 0; i < want.length; i++) {
        await tx.helpTopic.update({ where: { id: want[i] }, data: { sortOrder: i } });
      }
      await this.audit(tx, user, 'UPDATE', `${clientId}:${dto.audience}`, slug, 'reorder', { order: have }, { order: want });
      return tx.helpTopic.findMany({
        where: { clientId, audience: dto.audience, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    });
    return rows.map((r) => this.view(r));
  }

  /**
   * Soft delete of the ROW (kept for the audit trail), audited; its video + poster OBJECTS are deleted from the
   * bucket after the commit (best-effort — a failed delete is logged; nothing serves a deleted topic's media).
   */
  async remove(user: JwtPayload, slug: string, id: string): Promise<{ id: string; deleted: true }> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    const keys = await this.prisma.$transaction(async (tx) => {
      const before = await tx.helpTopic.findFirst({ where: { id, clientId, deletedAt: null } });
      if (!before) throw new NotFoundException('Help topic not found');
      await tx.helpTopic.update({ where: { id }, data: { deletedAt: new Date(), isPublished: false, updatedById: user.sub } });
      await this.audit(tx, user, 'DELETE', id, slug, 'delete', {
        title: before.title,
        audience: before.audience,
        isPublished: before.isPublished,
        videoKey: before.videoKey,
        posterKey: before.posterKey,
      });
      return [before.videoKey, before.posterKey].filter((k): k is string => !!k);
    });
    for (const k of keys) await this.bestEffortDelete(k);
    return { id, deleted: true };
  }

  // ─── poster ─────────────────────────────────────────────────────────────────

  async uploadPoster(user: JwtPayload, slug: string, id: string, file: Express.Multer.File | undefined): Promise<HelpTopicAdminView> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    await this.requireTopic(clientId, id);
    if (!file || !file.buffer?.length) throw new BadRequestException('No image uploaded.');
    if (file.size > HELP_POSTER_MAX_BYTES) throw new BadRequestException('Image too large (max 5 MB).');
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed || !HELP_POSTER_MIME.has(sniffed.mime)) {
      throw new BadRequestException('Unsupported image. Upload a PNG, JPG or WEBP.');
    }
    const key = this.storage.generateKey(`help-videos/${clientId}/${id}`, `poster.${sniffed.ext}`);
    await this.storage.uploadFile(file.buffer, key, sniffed.mime);
    let result: { row: HelpTopic; oldKey: string | null };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const before = await tx.helpTopic.findFirst({ where: { id, clientId, deletedAt: null } });
        if (!before) throw new NotFoundException('Help topic not found');
        const row = await this.swapKey(tx, before, { posterKey: key, updatedById: user.sub }, 'posterKey', 'poster');
        await this.audit(tx, user, 'UPDATE', id, slug, 'poster-upload', { posterKey: before.posterKey }, { posterKey: key, bytes: file.size });
        return { row, oldKey: before.posterKey };
      });
    } catch (e) {
      await this.bestEffortDelete(key);
      throw e;
    }
    const { row, oldKey } = result;
    if (oldKey && oldKey !== key) await this.bestEffortDelete(oldKey);
    return this.view(row);
  }

  async removePoster(user: JwtPayload, slug: string, id: string): Promise<HelpTopicAdminView> {
    return this.removeMedia(user, slug, id, 'poster');
  }

  async removeVideo(user: JwtPayload, slug: string, id: string): Promise<HelpTopicAdminView> {
    return this.removeMedia(user, slug, id, 'video');
  }

  private async removeMedia(user: JwtPayload, slug: string, id: string, kind: 'video' | 'poster'): Promise<HelpTopicAdminView> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    const { row, oldKey } = await this.prisma.$transaction(async (tx) => {
      const before = await tx.helpTopic.findFirst({ where: { id, clientId, deletedAt: null } });
      if (!before) throw new NotFoundException('Help topic not found');
      const oldKey = kind === 'video' ? before.videoKey : before.posterKey;
      if (!oldKey) return { row: before, oldKey: null };
      const data: Prisma.HelpTopicUpdateInput =
        kind === 'video' ? { videoKey: null, videoBytes: null, updatedById: user.sub } : { posterKey: null, updatedById: user.sub };
      const row = await tx.helpTopic.update({ where: { id }, data });
      await this.audit(tx, user, 'UPDATE', id, slug, `${kind}-remove`, { [`${kind}Key`]: oldKey }, { [`${kind}Key`]: null });
      return { row, oldKey };
    });
    if (oldKey) await this.bestEffortDelete(oldKey);
    return this.view(row);
  }

  // ─── chunked video upload ──────────────────────────────────────────────────

  private partsPrefix(clientId: string, topicId: string, uploadId: string): string {
    if (!UUID_RE.test(uploadId)) throw new BadRequestException('Invalid upload id.');
    // Dedicated prefix: a 1-day GCS lifecycle Delete rule (terraform/gcs-memorystore.tf) sweeps abandoned uploads.
    return `${HELP_UPLOAD_PREFIX}${clientId}/${topicId}/${uploadId}/`;
  }

  /** Start a chunked upload: the console then sends ≤ partBytes parts 0..n-1 and calls complete. */
  async startVideoUpload(user: JwtPayload, slug: string, id: string, declaredBytes?: number) {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    await this.requireTopic(clientId, id);
    if (declaredBytes !== undefined && (!Number.isFinite(declaredBytes) || declaredBytes <= 0)) {
      throw new BadRequestException('The video is empty.');
    }
    if (declaredBytes !== undefined && declaredBytes > HELP_VIDEO_MAX_BYTES) {
      throw new BadRequestException(`The video is too large — the limit is ${HELP_VIDEO_MAX_BYTES / (1024 * 1024)} MB.`);
    }
    return {
      uploadId: randomUUID(),
      partBytes: HELP_VIDEO_PART_BYTES,
      maxBytes: HELP_VIDEO_MAX_BYTES,
      maxParts: HELP_VIDEO_MAX_PARTS,
    };
  }

  async putVideoPart(
    user: JwtPayload,
    slug: string,
    id: string,
    uploadId: string,
    n: string,
    file: Express.Multer.File | undefined,
  ): Promise<{ part: number; bytes: number }> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    await this.requireTopic(clientId, id);
    const prefix = this.partsPrefix(clientId, id, uploadId);
    if (!/^\d{1,2}$/.test(n)) throw new BadRequestException('Invalid part number.');
    const part = Number(n);
    if (part >= HELP_VIDEO_MAX_PARTS) {
      throw new BadRequestException(`The video is too large — the limit is ${HELP_VIDEO_MAX_BYTES / (1024 * 1024)} MB.`);
    }
    if (!file || !file.buffer?.length) throw new BadRequestException('Empty upload part.');
    if (file.size > HELP_VIDEO_PART_BYTES) throw new BadRequestException('Upload part too large.');
    if (part === 0) {
      const problem = mp4Problem(file.buffer);
      if (problem) throw new BadRequestException(problem);
    }
    await this.storage.uploadFile(file.buffer, `${prefix}${String(part).padStart(5, '0')}`, 'application/octet-stream');
    return { part, bytes: file.size };
  }

  async completeVideoUpload(user: JwtPayload, slug: string, id: string, uploadId: string): Promise<HelpTopicAdminView> {
    this.assertGifsy(user);
    const clientId = await this.requireClient(slug);
    await this.requireTopic(clientId, id);
    const prefix = this.partsPrefix(clientId, id, uploadId);
    const parts = (await this.storage.listPrefix(prefix))
      .map((p) => ({ ...p, n: Number(p.name.slice(prefix.length)) }))
      .filter((p) => Number.isInteger(p.n))
      .sort((a, b) => a.n - b.n);

    const fail = async (msg: string): Promise<never> => {
      await this.bestEffortDeletePrefix(prefix);
      throw new BadRequestException(msg);
    };
    if (parts.length === 0) return fail('No video was uploaded. Please choose the file again.');
    if (parts.some((p, i) => p.n !== i)) return fail('Part of the video is missing. Please upload it again.');
    if (parts.slice(0, -1).some((p) => p.size !== HELP_VIDEO_PART_BYTES)) {
      return fail('The upload was corrupted (a part had the wrong size). Please upload it again.');
    }
    const total = parts.reduce((s, p) => s + p.size, 0);
    if (total <= 0) return fail('The video is empty.');
    if (total > HELP_VIDEO_MAX_BYTES) {
      return fail(`The video is too large — the limit is ${HELP_VIDEO_MAX_BYTES / (1024 * 1024)} MB.`);
    }

    const key = this.storage.generateKey(`help-videos/${clientId}/${id}`, 'video.mp4');
    // GCS compose (1–32 sources) — also used for a single part so the stored object gets video/mp4 in one step.
    let result: { row: HelpTopic; oldKey: string | null };
    try {
      await this.storage.combineFiles(parts.map((p) => p.name), key, 'video/mp4');
      result = await this.prisma.$transaction(async (tx) => {
        const before = await tx.helpTopic.findFirst({ where: { id, clientId, deletedAt: null } });
        if (!before) throw new NotFoundException('Help topic not found');
        const row = await this.swapKey(tx, before, { videoKey: key, videoBytes: total, updatedById: user.sub }, 'videoKey', 'video');
        await this.audit(tx, user, 'UPDATE', id, slug, 'video-upload', { videoKey: before.videoKey, videoBytes: before.videoBytes }, { videoKey: key, videoBytes: total });
        return { row, oldKey: before.videoKey };
      });
    } catch (e) {
      await this.bestEffortDelete(key);
      throw e;
    } finally {
      await this.bestEffortDeletePrefix(prefix);
    }
    if (result.oldKey && result.oldKey !== key) await this.bestEffortDelete(result.oldKey);
    return this.view(result.row);
  }

  /**
   * Optimistic swap of a media key: update ONLY if the key is still the one read as `before` (a concurrent
   * upload / complete / remove changed it → 409, and the caller deletes the object it just stored).
   */
  private async swapKey(
    tx: Prisma.TransactionClient,
    before: HelpTopic,
    data: Prisma.HelpTopicUpdateManyMutationInput,
    field: 'videoKey' | 'posterKey',
    label: 'video' | 'poster',
  ): Promise<HelpTopic> {
    const res = await tx.helpTopic.updateMany({
      where: { id: before.id, clientId: before.clientId, deletedAt: null, [field]: before[field] },
      data,
    });
    if (res.count !== 1) {
      throw new ConflictException(`The ${label} was changed by someone else — reload the page and try again.`);
    }
    const row = await tx.helpTopic.findFirst({ where: { id: before.id, clientId: before.clientId } });
    if (!row) throw new NotFoundException('Help topic not found');
    return row;
  }

  private async bestEffortDelete(key: string): Promise<void> {
    try {
      await this.storage.deleteFile(key);
    } catch (err) {
      this.logger.warn(`help media cleanup: could not delete ${key}: ${(err as Error).message}`);
    }
  }

  private async bestEffortDeletePrefix(prefix: string): Promise<void> {
    try {
      await this.storage.deletePrefix(prefix);
    } catch (err) {
      this.logger.warn(`help upload cleanup: could not delete ${prefix}: ${(err as Error).message}`);
    }
  }
}
