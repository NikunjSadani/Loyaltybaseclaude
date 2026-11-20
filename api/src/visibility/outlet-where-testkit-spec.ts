/**
 * Test-only: an in-memory evaluator for the Outlet `where` shapes the visibility code builds (visibilityUniverseWhere,
 * visibilityWindowUniverseWhere, keyset paging, id lists). Lets a fake Prisma answer outlet queries by the REAL rule,
 * so the report screen and the Excel export can be checked against the same fixture. Not compiled into the build
 * (`**\/*spec.ts` is excluded) — mirrors exports/kinds/batch1/parity-testkit-spec.ts.
 *
 * Unknown keys throw, so a new rule shape can never be silently ignored by a test.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeOutletRow {
  id: string;
  clientId: string;
  outletCode: string;
  deletedAt?: Date | null;
  deactivatedAt?: Date | null;
  isActive?: boolean;
  kycIntent?: string | null;
  createdAt?: Date;
  typeCode: string;
  partnerId?: string | null;
  parentId?: string | null;
  programName?: string | null;
  programCategory?: string | null;
  /** approvedAt of each of the partner's KYC submissions (null = a submission without an approval date). */
  partnerKycApprovedAt?: Array<Date | null>;
}

function cmpScalar(val: any, cond: any): boolean {
  if (cond === null) return val === null || val === undefined;
  if (cond instanceof Date) return val instanceof Date && val.getTime() === cond.getTime();
  if (typeof cond !== 'object') return val === cond;
  for (const [op, arg] of Object.entries<any>(cond)) {
    const v = val instanceof Date ? val.getTime() : val;
    const a = arg instanceof Date ? arg.getTime() : arg;
    switch (op) {
      case 'in': if (!(arg as any[]).includes(val)) return false; break;
      case 'notIn': if (val === null || val === undefined || (arg as any[]).includes(val)) return false; break;
      case 'lt': if (v === null || v === undefined || !(v < a)) return false; break;
      case 'gt': if (v === null || v === undefined || !(v > a)) return false; break;
      case 'not': if (arg === null ? val === null || val === undefined : val === arg) return false; break;
      default: throw new Error(`outlet-where-testkit: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matchOutlet(o: FakeOutletRow, w: any): boolean {
  if (!w) return true;
  for (const [k, cond] of Object.entries<any>(w)) {
    switch (k) {
      case 'AND': if (!(cond as any[]).every((x) => matchOutlet(o, x))) return false; break;
      case 'OR': if (!(cond as any[]).some((x) => matchOutlet(o, x))) return false; break;
      case 'NOT': if (matchOutlet(o, cond)) return false; break;
      case 'outletType': if (!cmpScalar(o.typeCode, cond.code)) return false; break;
      case 'partner': {
        if (!o.partnerId) return false;
        const subs = o.partnerKycApprovedAt ?? [];
        const ks = cond.kycSubmissions;
        if (!ks || Object.keys(cond).length !== 1) throw new Error('outlet-where-testkit: unsupported partner filter');
        if (ks.some && !subs.some((d) => cmpScalar(d, ks.some.approvedAt))) return false;
        if (ks.none && subs.some((d) => cmpScalar(d, ks.none.approvedAt))) return false;
        break;
      }
      case 'clientId': case 'outletCode': case 'id': case 'deletedAt': case 'deactivatedAt': case 'isActive':
      case 'kycIntent': case 'createdAt': case 'partnerId': case 'parentId': case 'programName': case 'programCategory': {
        const defaults: Record<string, unknown> = { deletedAt: null, deactivatedAt: null, isActive: true, kycIntent: null, partnerId: null, parentId: null };
        const val = (o as any)[k] !== undefined ? (o as any)[k] : defaults[k];
        if (!cmpScalar(val, cond)) return false;
        break;
      }
      default:
        throw new Error(`outlet-where-testkit: unsupported key ${k}`);
    }
  }
  return true;
}
