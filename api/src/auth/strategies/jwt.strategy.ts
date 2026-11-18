import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityTrackingService } from '../../activity/activity-tracking.service';
import { activityContextFromRequest, isBackgroundRequest } from '../../activity/client-medium';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SESSION_TTL_DAYS } from '../auth.constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
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

    const session = await this.prisma.userSession.findFirst({ where });

    if (!session) {
      throw new UnauthorizedException('Session expired or revoked — please log in again.');
    }

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
}
