import type { Prisma } from '@prisma/client';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

/**
 * The requester's scoping snapshot stored on ExportRequest.actor. Only what scoping / permission decisions read
 * (role, tenant, assumed flag, staff role, vendor) — never session ids, phone or anything secret.
 */
export interface ExportActor {
  role: string;
  clientId: string;
  assumed: boolean;
  gifsyRoleId: string | null;
  vendorId: string | null;
  name: string;
}

export function actorOf(user: JwtPayload): ExportActor {
  return {
    role: user.role,
    clientId: user.clientId,
    assumed: user.assumed === true,
    gifsyRoleId: user.gifsyRoleId ?? null,
    vendorId: user.vendorId ?? null,
    name: user.name ?? '',
  };
}

/** Rebuild the JwtPayload a report sees inside the worker (the requester as they were when they asked). */
export function userFromActor(requestedById: string, raw: Prisma.JsonValue): JwtPayload {
  const a = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<ExportActor>;
  const user: JwtPayload = {
    sub: requestedById,
    role: String(a.role ?? ''),
    clientId: String(a.clientId ?? ''),
    phone: '',
    name: String(a.name ?? ''),
  };
  if (a.assumed) user.assumed = true;
  if (a.gifsyRoleId) user.gifsyRoleId = a.gifsyRoleId;
  if (a.vendorId) user.vendorId = a.vendorId;
  return user;
}
