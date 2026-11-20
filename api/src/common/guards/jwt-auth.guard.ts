import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

/**
 * H1 (2026-11-20): the response header that marks a 401 as SESSION authentication failure (missing /
 * expired / revoked access token). SessionExpiryGuard (platform) only treats a 401 as session expiry when it
 * carries this marker — a business 401 must never trigger a refresh, a resent request or a logout.
 */
export const AUTH_FAILURE_HEADER = 'x-auth-failure';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    // Allow routes marked @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, _info?: unknown, context?: ExecutionContext) {
    if (err || !user) {
      try {
        const res = context?.switchToHttp().getResponse<{ setHeader?: (k: string, v: string) => void }>();
        res?.setHeader?.(AUTH_FAILURE_HEADER, 'session');
      } catch {
        /* never let the marker mask the 401 */
      }
      throw err || new UnauthorizedException('Authentication required — please log in.');
    }
    return user;
  }
}
