/**
 * Unit tests for the phone ↔ employeeCode uniqueness guard added to persistHierarchy.
 *
 * A phone is a person's login: it must map to exactly one employee per tenant. Before
 * this guard, a phone already attached to a different SalesUser (or reused twice within
 * one file) blew up as a raw P2002 on SalesUser.userId — a 500 that also rolled back the
 * snapshot ("0 after refresh"). These tests pin the guard's clean 400 behaviour and the
 * blank-phone resolution (blank ≠ a shared empty-string user).
 */
import { BadRequestException } from '@nestjs/common';
import {
  persistHierarchy,
  DEOLEO_HIERARCHY,
  syntheticPlaceholderPhone,
  type HierarchyEmployee,
} from './hierarchy-persistence';

type ExistingUser = { phone: string; salesUser: { employeeCode: string } | null };

/** Minimal Prisma.TransactionClient mock that records the user.upsert phones. */
function makeTx(existingUsers: ExistingUser[] = []) {
  const upsertedUserPhones: string[] = [];
  let userSeq = 0;
  let salesSeq = 0;
  const tx = {
    user: {
      findMany: jest.fn().mockResolvedValue(existingUsers),
      upsert: jest.fn().mockImplementation((args: any) => {
        upsertedUserPhones.push(args.where.clientId_phone.phone);
        return Promise.resolve({ id: `user-${userSeq++}` });
      }),
    },
    salesHierarchyLevel: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve({ id: `lvl-${args.where.clientId_code.code}` }),
        ),
    },
    salesUser: {
      upsert: jest.fn().mockImplementation(() => Promise.resolve({ id: `su-${salesSeq++}` })),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return { tx: tx as any, upsertedUserPhones };
}

const CLIENT = 'deoleo';

function emp(over: Partial<HierarchyEmployee>): HierarchyEmployee {
  return {
    id: 'XSR-1',
    roleCode: 'XSR',
    reportsToId: null,
    name: 'Anil',
    mobile: '9900000001',
    status: 'ACTIVE',
    ...over,
  };
}

describe('persistHierarchy — phone ↔ employeeCode guard', () => {
  it('rejects two employee codes that share the same phone within one file', async () => {
    const employees = [
      emp({ id: 'XSR-1', mobile: '9900000001' }),
      emp({ id: 'XSR-2', mobile: '9900000001' }), // same phone, different code
    ];
    const { tx } = makeTx([]);
    await expect(persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/more than one employee/i);
  });

  it('rejects a phone already owned by a DIFFERENT existing employee code', async () => {
    const employees = [emp({ id: 'XSR-NEW', mobile: '9875436349' })];
    const { tx } = makeTx([{ phone: '9875436349', salesUser: { employeeCode: 'XSR-OLD' } }]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/already belongs to employee XSR-OLD/i);
  });

  it('rejects a phone already used by a non-sales account (no salesUser)', async () => {
    const employees = [emp({ id: 'XSR-NEW', mobile: '6289864191' })];
    const { tx } = makeTx([{ phone: '6289864191', salesUser: null }]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/already used by another account/i);
  });

  it('allows an idempotent re-upload of the SAME (code, phone)', async () => {
    const employees = [emp({ id: 'XSR-1', mobile: '9900000001' })];
    const { tx } = makeTx([{ phone: '9900000001', salesUser: { employeeCode: 'XSR-1' } }]);
    const result = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(result.salesUsersUpserted).toBe(1);
  });

  it('rejects a blank Employee ID (would otherwise P2002 on employeeCode)', async () => {
    const employees = [emp({ id: '   ', mobile: '9900000001' })];
    const { tx } = makeTx([]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/non-blank Employee ID/i);
  });

  it('rejects a duplicate Employee ID within the upload', async () => {
    const employees = [
      emp({ id: 'XSR-1', mobile: '9900000001' }),
      emp({ id: 'XSR-1', mobile: '9900000002' }), // same code, different phone
    ];
    const { tx } = makeTx([]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/appears more than once/i);
  });

  it('gives each blank-phone employee a UNIQUE synthetic phone (no empty-string collapse)', async () => {
    const employees = [
      emp({ id: 'XSR-A', name: 'A', mobile: '' }),
      emp({ id: 'XSR-B', name: 'B', mobile: '' }),
    ];
    const { tx, upsertedUserPhones } = makeTx([]);
    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(upsertedUserPhones).toEqual([
      syntheticPlaceholderPhone('XSR-A'),
      syntheticPlaceholderPhone('XSR-B'),
    ]);
    // distinct → no two users collapse onto one (clientId, '') row
    expect(new Set(upsertedUserPhones).size).toBe(2);
  });
});
