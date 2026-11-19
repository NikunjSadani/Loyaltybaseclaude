import { Prisma } from '@prisma/client';

/**
 * "Who raised this ticket, and for which outlet?" — derived from what the ticket model really
 * stores (2026-11-19, SUPPORT-TICKETS.md §Raised by / outlet):
 *
 *  - The submitter is `Ticket.createdById` → User. A PARTNER login (SSS / WHOLESALER /
 *    SUB_STOCKIST) is the outlet owner (User.channelPartner); a SALES_* login is a sales person
 *    (User.salesUser → hierarchyLevel.name = the tenant's own designation label, e.g. ISR / SO /
 *    ASM — the same label the sales app shows); anything else is staff (an admin raising a ticket).
 *  - The outlet is stored on the ticket ONLY as `referenceType = 'OUTLET'` + `referenceId =
 *    Outlet.id`, set at creation when the raiser named one (sales "For an Outlet", from
 *    2026-11-19). Older sales tickets never stored it (only the name inside the subject text), and
 *    a sales "own issue" ticket has none → shown honestly as "—" (outlet: null).
 *  - A partner-raised ticket without a stored outlet falls back to the owner's PRIMARY outlet
 *    (isPrimary desc, then oldest — the codebase convention); when the owner has more than one
 *    outlet that inference is flagged (`ownerOutletCount`) so the UI can say so.
 */

export const PARTNER_ROLES = new Set(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
export const OUTLET_REFERENCE_TYPE = 'OUTLET';

/** createdBy projection for support-admin reads (adds the submitter's partner / sales identity). */
export const TICKET_CREATOR_SELECT = {
  id: true,
  name: true,
  phone: true,
  role: true,
  channelPartner: {
    select: {
      id: true,
      ownerName: true,
      outlets: {
        where: { deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, outletCode: true, name: true },
        take: 1,
      },
      _count: { select: { outlets: { where: { deletedAt: null } } } },
    },
  },
  salesUser: {
    select: { employeeCode: true, hierarchyLevel: { select: { name: true, code: true } } },
  },
} as const satisfies Prisma.UserSelect;

export type TicketCreator = Prisma.UserGetPayload<{ select: typeof TICKET_CREATOR_SELECT }>;

/** Message sender projection for SUPPORT-ADMIN reads — enough to label every thread message. */
export const TICKET_SENDER_SELECT = {
  id: true,
  name: true,
  role: true,
  channelPartner: { select: { ownerName: true } },
  salesUser: { select: { hierarchyLevel: { select: { name: true, code: true } } } },
} as const satisfies Prisma.UserSelect;

export interface RaisedBy {
  kind: 'OUTLET_OWNER' | 'SALES' | 'STAFF';
  name: string;
  /** Sales designation (tenant hierarchy label) for SALES; the role label for STAFF; null for an owner. */
  designation: string | null;
  /** The one-line, unambiguous label shown in the list / detail / Excel. */
  label: string;
}

export interface TicketOutlet {
  id: string;
  outletCode: string;
  name: string;
  /** TICKET = stored on the ticket; OWNER_PRIMARY = inferred from the raising owner's primary outlet. */
  source: 'TICKET' | 'OWNER_PRIMARY';
  /** For OWNER_PRIMARY: how many (live) outlets the owner has — > 1 means the pick is an inference. */
  ownerOutletCount?: number;
}

const STAFF_ROLE_LABEL: Record<string, string> = {
  GIFSY_ADMIN: 'Gifsy support',
  GIFSY_STAFF: 'Gifsy support',
  CLIENT_ADMIN: 'Client admin',
  MIS_USER: 'MIS',
  VENDOR: 'Vendor',
};

/** Structural shape describeRaisedBy needs (a ticket creator OR a message sender). */
export type PersonLike =
  | {
      name?: string | null;
      role?: unknown;
      channelPartner?: { ownerName?: string | null } | null;
      salesUser?: { hierarchyLevel?: { name?: string | null; code?: string | null } | null } | null;
    }
  | null
  | undefined;

export function describeRaisedBy(creator: PersonLike): RaisedBy {
  const role = String(creator?.role ?? '');
  const userName = creator?.name?.trim() || 'Unknown';
  if (PARTNER_ROLES.has(role)) {
    const name = creator?.channelPartner?.ownerName?.trim() || userName;
    return { kind: 'OUTLET_OWNER', name, designation: null, label: `Outlet owner — ${name}` };
  }
  if (role.startsWith('SALES_')) {
    const lvl = creator?.salesUser?.hierarchyLevel;
    const designation = lvl?.name?.trim() || lvl?.code?.trim() || role.replace(/^SALES_/, '');
    return { kind: 'SALES', name: userName, designation, label: `${userName} · ${designation}` };
  }
  const designation = STAFF_ROLE_LABEL[role] ?? (role || null);
  return { kind: 'STAFF', name: userName, designation, label: designation ? `${userName} · ${designation}` : userName };
}

export function resolveTicketOutlet(
  ticket: { referenceType?: string | null; referenceId?: string | null },
  creator: Partial<TicketCreator> | null | undefined,
  referenced: Map<string, { id: string; outletCode: string; name: string }>,
): TicketOutlet | null {
  if (ticket.referenceType === OUTLET_REFERENCE_TYPE && ticket.referenceId) {
    const o = referenced.get(ticket.referenceId);
    if (o) return { ...o, source: 'TICKET' };
  }
  if (PARTNER_ROLES.has(String(creator?.role ?? ''))) {
    const o = creator?.channelPartner?.outlets?.[0];
    if (o) {
      return { ...o, source: 'OWNER_PRIMARY', ownerOutletCount: creator?.channelPartner?._count?.outlets ?? 1 };
    }
  }
  return null;
}
