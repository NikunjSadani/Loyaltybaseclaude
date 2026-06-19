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
    // Verify the session for THIS token's context is still active (not revoked).
    // Match on clientId too (not just userId): a GIFSY operator can hold multiple
    // concurrent sessions for the same user with different clientIds (their home
    // `gifsy` session + an assumed tenant session, A2/#51) — each token must
    // validate against its OWN context's session, so revoking one doesn't keep
    // authorising the other.
    const session = await this.prisma.userSession.findFirst({
      where: {
        userId:    payload.sub,
        clientId:  payload.clientId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      throw new UnauthorizedException('Session expired or revoked — please log in again.');
    }

    return payload; // Becomes req.user
  }
}
