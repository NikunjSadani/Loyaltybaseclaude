import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private config:  ConfigService,
    private prisma:  PrismaService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is not set. Refusing to start.');
    }
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      secret,
    });
  }

  async validate(payload: JwtPayload) {
    // Bind the bearer token to its OWN session row. Tokens minted after the
    // auth-hardening change carry `sid` (the UserSession PK) → match on it, so
    // revoking/rotating that exact session invalidates this access token on its
    // NEXT request (instead of letting it live out its 7-day TTL).
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

    return payload; // Becomes req.user
  }
}
