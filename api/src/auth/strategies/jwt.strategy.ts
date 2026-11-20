import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityTrackingService } from '../../activity/activity-tracking.service';
import { activityContextFromRequest, isBackgroundRequest } from '../../activity/client-medium';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SESSION_TTL_DAYS } from '../auth.constants';
import { INTERNAL_SECRET_HEADER, isTrustedInternalCall } from '../../common/internal-call';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private config:   ConfigService,
    private prisma:   PrismaService,
    private activity: ActivityTrackingService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is not set. Refusing to start.');
    }
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      secret,
      // The request is needed ONLY to read how it arrived (X-Client-Medium + User-Agent) for the
      // Usage Report's activity stamp; auth itself still depends solely on the verified payload.
      passReqToCallback: true,
    });
  }

  async validate(req: unknown, payload: JwtPayload) {
    // Bind the bearer token to its OWN session row. Tokens minted after the
    // auth-hardening change carry `sid` (the UserSession PK) → match on it, so
    // revoking/rotating that exact session invalidates this access token on its
    // NEXT request (instead of letting it live out its 30-day TTL).
    //
    // Legacy fallback: tokens issued before `sid` existed match on (userId,
    // clientId) — a GIFSY operator can hold concurrent sessions for the same user
    // under different clientIds (home `gifsy` + an assumed tenant, A2/#51), so the
    // tenant is part of the legacy key. These age out as old tokens expire.
    const where = payload.sid
      ? { id: payload.sid, revokedAt: null, expiresAt: { gt: new Date() } }
      : {
          userId:    payload.sub,
          clientId:  payload.clientId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        };

    // M3 — explicit select: only the columns this guard needs, so it never depends on newer columns
    // (the deploy runs migrations before the API takes traffic; this keeps the hot path independent of it).
    const session = await this.prisma.userSession.findFirst({ where, select: { id: true, expiresAt: true } });

    if (!session) {
      throw new UnauthorizedException('Session expired or revoked — please log in again.');
    }

    await this.markFirstUse(req, payload, session.id);

    // ── Sliding session: roll expiresAt forward on activity (fire-and-forget) ────
    // A valid access re-mints the idle window to now + SESSION_TTL_DAYS, so an
    // actively-used session never lapses while an idle one still expires after 30 days
    // (the refresh path slides it identically on token renewal). THROTTLED to ≈once/day
    // per session — only fires when the stored expiresAt has already decayed by >1 day —
    // to avoid a DB write on every request. Fire-and-forget (never awaited, never
    // rejects the request), mirroring the markActive stamp below. The updateMany is
    // scoped to the live session (revokedAt:null) and only ever touches expiresAt —
    // never clientId/scope; a revoked/expired session already 401'd above, so this
    // can never resurrect one.
    const now = Date.now();
    const target = now + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
    if (session.expiresAt.getTime() < now + (SESSION_TTL_DAYS - 1) * 24 * 60 * 60 * 1000) {
      this.prisma.userSession
        .updateMany({
          where: { id: session.id, revokedAt: null, expiresAt: { lt: new Date(target) } },
          data:  { expiresAt: new Date(target) },
        })
        .catch(() => {});
    }

    // Stamp this user active (IST day) with how they arrived — fire-and-forget, throttled in
    // memory, never blocks or fails the request. Feeds the Session Report's active days and the
    // Usage Report's visits / duration / medium. activityContextFromRequest never throws.
    // An AUTOMATIC request (X-Background: 1 — bell poll, badge counts, job polling, beacons) is NOT activity:
    // no active day, no visit, no duration, no medium (owner rule: only real actions count).
    if (!isBackgroundRequest(req)) {
      this.activity.markActive(payload.sub, payload.clientId, activityContextFromRequest(req));
    }

    return payload; // Becomes req.user
  }

  /**
   * H4/S-H1 — mark the session's FIRST authenticated use. refreshToken hands a replayed old token its
   * successor only while every link is still unused; this mark ends that leniency for this session.
   *  - M2/S-L3: only for tokens bound to their session (`sid`) — a legacy sid-less token matches ANY
   *    live session of the user and could mark the wrong one. (Every token minted since the sid change
   *    carries it; a sid-less token could only still be valid within ACCESS_TTL of that deploy.)
   *  - M1: a server-side call made in the SAME request in which the proxy just rotated the session
   *    (`x-gifsy-no-first-use: 1`, sent by the Next server actions in that case) is not proof the
   *    browser received the new session — it must not count as use. Only trusted with the internal
   *    server-to-server secret (common/internal-call.ts).
   *  - Set-once and cheap: `WHERE firstUsedAt IS NULL` (concurrency-safe) and a per-instance memo, so
   *    each session costs at most one write per API instance — never a write per request. AWAITED, so
   *    the mark lands before the request that used the session proceeds.
   *  - S-L2: a failed mark never fails the request, but it is LOUD (error log + audit row the Daily Ops
   *    Digest counts): until it lands, the lenient handback stays open for this session.
   */
  private async markFirstUse(req: unknown, payload: JwtPayload, sessionId: string): Promise<void> {
    if (!payload.sid || payload.sid !== sessionId) return;
    if (this.firstUseMarked.has(sessionId)) return;
    const headers = ((req as { headers?: Record<string, unknown> } | undefined)?.headers ?? {}) as Record<string, unknown>;
    // Honoured ONLY from our own Next server (shared secret, constant-time): the API is public, and a
    // forged header would let a thief keep a session "unused" and evade reuse detection. Fail-safe: no
    // INTERNAL_PROXY_SECRET configured → never honoured → first use is always marked.
    if (headers['x-gifsy-no-first-use'] === '1' && isTrustedInternalCall(headers[INTERNAL_SECRET_HEADER])) return;
    try {
      await this.prisma.userSession.updateMany({
        where: { id: sessionId, firstUsedAt: null },
        data:  { firstUsedAt: new Date() },
      });
      if (this.firstUseMarked.size >= JwtStrategy.FIRST_USE_MEMO_MAX) this.firstUseMarked.clear();
      this.firstUseMarked.add(sessionId);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.logger.error(`Could not mark first use of session ${sessionId}: ${message}`);
      this.prisma.auditLog
        .create({
          data: {
            action: 'UPDATE',
            entityType: 'AUTH_EVENT',
            entityId: payload.sub,
            actorId: payload.sub,
            targetUserId: payload.sub,
            metadata: { event: 'first_use_mark_failed', sessionId, clientId: payload.clientId, error: message.slice(0, 300) },
          },
        })
        .catch(() => undefined); // the DB may be the thing that is failing — the error log above stands
    }
  }

  /** Sessions already marked as used by THIS instance (bounded; cleared when full). */
  private readonly firstUseMarked = new Set<string>();
  private static readonly FIRST_USE_MEMO_MAX = 50_000;
}
