import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtPayload {
  sub:      string;   // user ID
  role:     string;
  clientId: string;
  phone:    string;
  name:     string;
  /**
   * True when this is an OPERATOR-CONTEXT (assume-tenant) token: a GIFSY_ADMIN
   * working inside a tenant's context (A2/#51). `sub` stays the real operator
   * (audit attribution); `clientId` is the assumed tenant. The FE shows a
   * "Working in <Brand>" banner when this is set. A normal session omits it.
   */
  assumed?: boolean;
  iat?:     number;
  exp?:     number;
}

/** Injects the decoded JWT payload into a controller parameter */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

/** Injects the clientId from the JWT — shorthand for the common case */
export const ClientId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.clientId;
  },
);
