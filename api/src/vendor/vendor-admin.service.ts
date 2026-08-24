import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isActivePhoneConflict, ACTIVE_PHONE_IN_USE_MSG } from '../common/phone-conflict';
import {
  CreateVendorDto,
  CreateVendorGrantDto,
  CreateVendorUserDto,
  UpdateVendorDto,
  UpdateVendorGrantDto,
} from './dto/vendor.dto';

/**
 * Gifsy VENDOR MANAGEMENT (Gift Catalogue & Dispatch, Wave 2) — /v1/admin/vendors.
 *
 * Gifsy-operator only at the DATA BOUNDARY: every method re-checks isGifsyOperator
 * (defence-in-depth behind the controller @Roles('GIFSY_ADMIN')). Vendors are platform
 * entities (no KYC/financial fields — decisions 8+9); a vendor operates in a tenant only
 * via an ACTIVE VendorTenantGrant (deny-by-default, mirrors GifsyStaffTenantGrant).
 *
 * SUSPEND / REVOKE CASCADE (review CRITICAL #2): suspending a vendor or revoking a grant
 * (a) DYNAMICALLY hides its items + blocks their redemption via the member-side
 * vendorVisibilityFilter (no sweep needed), and (b) stops the vendor LOGIN — auth
 * re-checks vendor+grant on login/refresh, and here we STAMP sessionsInvalidBefore +
 * sweep the affected vendor users' live sessions (stamp-before-sweep, same authority the
 * staff-role + logout-all paths use) so an open portal session is cut promptly.
 */
@Injectable()
export class VendorAdminService {
  private readonly logger = new Logger(VendorAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * OWNER-ONLY data boundary (Wave-2 audit MED#3). Vendor administration exposes the full
   * cross-tenant vendor→tenant grant map + tenant list — owner-level data. `isGifsyOperator`
   * admits GIFSY_STAFF (and the route's @RequirePermission lets a scoped staffer past
   * @Roles), so the enumeration endpoints assert GIFSY_ADMIN here — not the broader operator
   * floor — to stop a scoped/assumed staffer enumerating every tenant (mirrors the Wave-1
   * owner-only gift-catalogue admin).
   */
  private assertOwner(user: JwtPayload) {
    if (user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('Vendor administration is owner-only');
    }
  }

  /**
   * Stamp-before-sweep the sessions of a vendor's users. `clientId` narrows to the
   * users pinned to that tenant (grant revoke); omit it to sweep ALL the vendor's
   * users (vendor suspend). The stamp is its OWN committed statement BEFORE the sweep
   * so a concurrent refresh's post-mint re-read observes it (see gifsy-staff.service).
   */
  private async cascadeVendorLogout(vendorId: string, clientId?: string): Promise<void> {
    const now = new Date();
    const users = await this.prisma.user.findMany({
      where: { vendorId, ...(clientId ? { clientId } : {}) },
      select: { id: true },
    });
    if (users.length === 0) return;
    const ids = users.map((u) => u.id);
    // (1) committed stamp
    await this.prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { sessionsInvalidBefore: now },
    });
    // (2) separately-committed sweep
    await this.prisma.userSession.updateMany({
      where: { userId: { in: ids }, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  // ── Vendors ──────────────────────────────────────────────────────────────────

  async listVendors(user: JwtPayload) {
    this.assertOwner(user);
    const vendors = await this.prisma.vendor.findMany({
      include: {
        grants: {
          select: { id: true, clientId: true, approvalPolicy: true, status: true },
        },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Resolve tenant display names for the grants (clientId is a bare slug, no FK).
    const clientIds = [...new Set(vendors.flatMap((v) => v.grants.map((g) => g.clientId)))];
    const clients = clientIds.length
      ? await this.prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, internalName: true },
        })
      : [];
    const clientName = new Map(clients.map((c) => [c.id, c.internalName]));

    const items = vendors.map((v) => ({
      id: v.id,
      name: v.name,
      status: v.status,
      grants: v.grants.map((g) => ({
        id: g.id,
        clientId: g.clientId,
        clientName: clientName.get(g.clientId) ?? g.clientId,
        approvalPolicy: g.approvalPolicy,
        status: g.status,
      })),
      userCount: v._count.users,
    }));
    return { items };
  }

  /**
   * GET /v1/admin/vendors/:id — FLAT vendor detail (Gifsy-operator only). The list
   * fields (id/name/status/grants/userCount) PLUS the full `users` login list (decision
   * #12 — one tenant per login). clientName is resolved for both grants and logins from
   * the Client table (clientId is a bare slug, no FK).
   */
  async getVendor(user: JwtPayload, id: string) {
    this.assertOwner(user);
    const vendor = await this.prisma.vendor.findFirst({
      where: { id },
      include: {
        grants: {
          select: { id: true, clientId: true, approvalPolicy: true, status: true },
        },
        users: {
          select: { id: true, name: true, phone: true, clientId: true, status: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const clientIds = [
      ...new Set([
        ...vendor.grants.map((g) => g.clientId),
        ...vendor.users.map((u) => u.clientId).filter((c): c is string => !!c),
      ]),
    ];
    const clients = clientIds.length
      ? await this.prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, internalName: true },
        })
      : [];
    const clientName = new Map(clients.map((c) => [c.id, c.internalName]));

    return {
      id: vendor.id,
      name: vendor.name,
      status: vendor.status,
      createdAt: vendor.createdAt,
      grants: vendor.grants.map((g) => ({
        id: g.id,
        clientId: g.clientId,
        clientName: clientName.get(g.clientId) ?? g.clientId,
        approvalPolicy: g.approvalPolicy,
        status: g.status,
      })),
      users: vendor.users.map((u) => ({
        id: u.id,
        name: u.name,
        phone: u.phone,
        clientId: u.clientId,
        clientName: u.clientId ? clientName.get(u.clientId) ?? u.clientId : null,
        status: u.status,
      })),
      userCount: vendor.users.length,
    };
  }

  /**
   * GET /v1/admin/tenants — the grant-picker tenant list (Gifsy-operator only). ACTIVE
   * REAL tenants only, EXCLUDING the 'gifsy' operator tenant (which owns no loyalty data
   * and is never a vendor-grant target). Shape { items: [{ id, name }] } — the exact
   * shape the add-grant picker consumes.
   */
  async listTenants(user: JwtPayload) {
    this.assertOwner(user);
    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE', id: { not: 'gifsy' } },
      select: { id: true, internalName: true },
      orderBy: { internalName: 'asc' },
    });
    return { items: clients.map((c) => ({ id: c.id, name: c.internalName })) };
  }

  async createVendor(user: JwtPayload, dto: CreateVendorDto) {
    this.assertOwner(user);
    const vendor = await this.prisma.vendor.create({
      data: { name: dto.name, createdByUserId: user.sub },
    });
    return vendor;
  }

  async updateVendor(user: JwtPayload, id: string, dto: UpdateVendorDto) {
    this.assertOwner(user);
    const existing = await this.prisma.vendor.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Vendor not found');

    const vendor = await this.prisma.vendor.update({
      where: { id },
      data: { name: dto.name, status: dto.status },
    });

    // SUSPEND cascade: cut every vendor user's session. (Member-side hiding is
    // automatic via vendorVisibilityFilter; nothing to sweep there.)
    if (dto.status === 'SUSPENDED' && existing.status !== 'SUSPENDED') {
      await this.cascadeVendorLogout(id);
      this.logger.log(`Vendor ${id} SUSPENDED by ${user.sub} — sessions swept`);
    }
    return vendor;
  }

  // ── Grants ─────────────────────────────────────────────────────────────────────

  /** Create OR reactivate a vendor↔tenant grant (unique on [vendorId, clientId]). */
  async createGrant(user: JwtPayload, vendorId: string, dto: CreateVendorGrantDto) {
    this.assertOwner(user);
    const vendor = await this.prisma.vendor.findFirst({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const client = await this.prisma.client.findFirst({ where: { id: dto.clientId } });
    if (!client) throw new BadRequestException('Tenant (clientId) not found');

    const existing = await this.prisma.vendorTenantGrant.findUnique({
      where: { vendorId_clientId: { vendorId, clientId: dto.clientId } },
    });
    if (existing) {
      // Reactivate / re-policy an existing (possibly REVOKED) grant.
      const grant = await this.prisma.vendorTenantGrant.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', approvalPolicy: dto.approvalPolicy },
      });
      return grant;
    }
    const grant = await this.prisma.vendorTenantGrant.create({
      data: {
        vendorId,
        clientId: dto.clientId,
        approvalPolicy: dto.approvalPolicy,
        createdByUserId: user.sub,
      },
    });
    return grant;
  }

  async updateGrant(
    user: JwtPayload,
    vendorId: string,
    grantId: string,
    dto: UpdateVendorGrantDto,
  ) {
    this.assertOwner(user);
    const existing = await this.prisma.vendorTenantGrant.findFirst({
      where: { id: grantId, vendorId },
    });
    if (!existing) throw new NotFoundException('Vendor grant not found');

    const grant = await this.prisma.vendorTenantGrant.update({
      where: { id: grantId },
      data: { approvalPolicy: dto.approvalPolicy, status: dto.status },
    });

    // REVOKE cascade: cut the sessions of the vendor's users pinned to THIS tenant.
    // (Member-side hiding for this tenant is automatic via vendorVisibilityFilter.)
    if (dto.status === 'REVOKED' && existing.status !== 'REVOKED') {
      await this.cascadeVendorLogout(vendorId, existing.clientId);
      this.logger.log(
        `Vendor ${vendorId} grant for ${existing.clientId} REVOKED by ${user.sub} — sessions swept`,
      );
    }
    return grant;
  }

  // ── Vendor logins ────────────────────────────────────────────────────────────

  /**
   * Create a VENDOR login (a User role=VENDOR, vendorId set, clientId = the granted
   * tenant — decision #12 ONE tenant per vendor login). Requires the vendor to hold an
   * ACTIVE grant for that tenant. Reuses the ACTIVE-phone-uniqueness rule (partial
   * unique index) — only an ACTIVE user reserves a (clientId, phone).
   */
  async createVendorUser(user: JwtPayload, vendorId: string, dto: CreateVendorUserDto) {
    this.assertOwner(user);
    const vendor = await this.prisma.vendor.findFirst({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (vendor.status !== 'ACTIVE') {
      throw new BadRequestException('Cannot add a login to a suspended vendor');
    }

    const grant = await this.prisma.vendorTenantGrant.findFirst({
      where: { vendorId, clientId: dto.clientId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!grant) {
      throw new BadRequestException(
        'This vendor has no active grant for that tenant — grant the tenant before adding a login',
      );
    }

    // Only an ACTIVE user reserves a phone (partial unique index).
    const existing = await this.prisma.user.findFirst({
      where: { phone: dto.phone, clientId: dto.clientId, status: 'ACTIVE' },
    });
    if (existing) throw new BadRequestException('A user with this phone already exists in this tenant');

    let created;
    try {
      created = await this.prisma.user.create({
        data: {
          phone: dto.phone,
          name: dto.name,
          role: 'VENDOR',
          status: 'ACTIVE',
          clientId: dto.clientId,
          vendorId,
        },
      });
    } catch (e) {
      if (isActivePhoneConflict(e)) throw new BadRequestException(ACTIVE_PHONE_IN_USE_MSG);
      throw e;
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'USER',
        entityId: created.id,
        actorId: user.sub,
        metadata: { role: 'VENDOR', vendorId, clientId: dto.clientId, phone: dto.phone },
      },
    });

    return {
      id: created.id,
      name: created.name,
      phone: created.phone,
      role: created.role,
      clientId: created.clientId,
      vendorId: created.vendorId,
      status: created.status,
    };
  }
}
