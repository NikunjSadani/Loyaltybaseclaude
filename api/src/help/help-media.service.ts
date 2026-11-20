import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TenantService } from '../tenant/tenant.service';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import {
  HELP_MEDIA_ROUTE,
  HELP_MEDIA_TOKEN_TTL_SEC,
  HELP_MEDIA_TOKEN_TYP,
  HELP_POSTER_MAX_BYTES,
  HELP_VIDEO_MAX_BYTES,
  keyFingerprint,
  parseByteRange,
} from './help.constants';

export type HelpMediaKind = 'video' | 'poster';

interface HelpMediaClaims {
  typ: typeof HELP_MEDIA_TOKEN_TYP;
  /** topic id */
  sub: string;
  /** tenant */
  c: string;
  /** which object */
  k: HelpMediaKind;
  /** fingerprint of the object key the token was minted for */
  h: string;
  /** console preview (unpublished topics / flag OFF allowed) */
  p?: 1;
}

export interface HelpMediaTarget {
  key: string;
  contentType: string;
  /** Bytes in THIS response (the range length for a 206). */
  length: number;
  /** Full object size. */
  size: number;
  range: { start: number; end: number } | null;
}

export interface HelpMediaStream extends HelpMediaTarget {
  stream: Readable;
}

/**
 * The "signed URL" for help media: a same-origin `/api/help/media?token=<jwt>` URL whose HS256 token (60 min)
 * names ONE topic + ONE object kind for ONE tenant. We do NOT use GCS V4 signed URLs: blob-signing via IAM is
 * unreliable on Cloud Run here (see StorageService.downloadAsDataUrl / KycService dump links), which is why every
 * private-media surface in this codebase (KYC docs, scheme media) uses this tokenized-stream pattern instead.
 *
 * The object key is NEVER in the token: it is re-read from the tenant-verified topic row on every request, so a
 * replaced / removed video or an unpublished / deleted topic stops serving immediately. Byte ranges are supported
 * (HTML5 <video> seeks with Range; iOS Safari refuses to play without 206 support).
 */
@Injectable()
export class HelpMediaService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * Mint a media URL. `key` = the object the URL is for: its fingerprint rides in the token, so REPLACING the
   * video/poster invalidates every URL minted for the old one (old streams end with 404 instead of switching to
   * the new file's bytes mid-playback). `preview` = console (Gifsy) view: unpublished topics + flag-OFF allowed.
   */
  mintUrl(topicId: string, clientId: string, kind: HelpMediaKind, key: string, preview = false): string {
    const claims: HelpMediaClaims = {
      typ: HELP_MEDIA_TOKEN_TYP,
      sub: topicId,
      c: clientId,
      k: kind,
      h: keyFingerprint(key),
      ...(preview ? { p: 1 as const } : {}),
    };
    const token = this.jwt.sign(claims, { secret: this.config.get('JWT_SECRET'), expiresIn: HELP_MEDIA_TOKEN_TTL_SEC });
    return `${HELP_MEDIA_ROUTE}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Validate a token and size the object WITHOUT opening it (HEAD uses only this). ANY failure → bare 404 (no
   * detail): bad / expired / foreign token, wrong typ, topic missing / deleted / other tenant, unpublished (member
   * token), tenant flag OFF (member token), no object of that kind, object REPLACED since the token was minted,
   * object missing or over the cap.
   */
  async inspect(token: string | undefined, rangeHeader: string | undefined): Promise<HelpMediaTarget | { unsatisfiable: true; size: number }> {
    const deny = () => new NotFoundException();
    if (!token || typeof token !== 'string' || token.length > 4096) throw deny();

    let claims: Partial<HelpMediaClaims>;
    try {
      claims = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET'), algorithms: ['HS256'] });
    } catch {
      throw deny();
    }
    if (claims.typ !== HELP_MEDIA_TOKEN_TYP) throw deny();
    if (typeof claims.sub !== 'string' || typeof claims.c !== 'string' || typeof claims.h !== 'string') throw deny();
    if (claims.k !== 'video' && claims.k !== 'poster') throw deny();

    const topic = await this.prisma.helpTopic.findFirst({
      where: { id: claims.sub, clientId: claims.c, deletedAt: null },
      select: { isPublished: true, videoKey: true, posterKey: true },
    });
    if (!topic) throw deny();
    const preview = claims.p === 1;
    if (!preview) {
      if (!topic.isPublished) throw deny();
      const features = await resolveTenantFeatures(this.tenant, claims.c);
      if (features.helpVideos !== true) throw deny();
    }

    const key = claims.k === 'video' ? topic.videoKey : topic.posterKey;
    if (!key || keyFingerprint(key) !== claims.h) throw deny();
    const cap = claims.k === 'video' ? HELP_VIDEO_MAX_BYTES : HELP_POSTER_MAX_BYTES;
    const meta = await this.storage.statObject(key);
    if (!meta || meta.size <= 0 || meta.size > cap) throw deny();

    const range = claims.k === 'video' ? parseByteRange(rangeHeader, meta.size) : null;
    if (range === 'unsatisfiable') return { unsatisfiable: true, size: meta.size };
    return {
      key,
      contentType: claims.k === 'video' ? 'video/mp4' : meta.contentType,
      size: meta.size,
      length: range ? range.end - range.start + 1 : meta.size,
      range,
    };
  }

  /** Open the (ranged) read stream for a target `inspect` returned. */
  openStream(target: HelpMediaTarget): Readable {
    try {
      return target.range ? this.storage.openReadStream(target.key, target.range) : this.storage.openReadStream(target.key);
    } catch {
      throw new NotFoundException();
    }
  }

  /** inspect + openStream (GET). */
  async open(token: string | undefined, rangeHeader: string | undefined): Promise<HelpMediaStream | { unsatisfiable: true; size: number }> {
    const target = await this.inspect(token, rangeHeader);
    if ('unsatisfiable' in target) return target;
    return { ...target, stream: this.openStream(target) };
  }
}
