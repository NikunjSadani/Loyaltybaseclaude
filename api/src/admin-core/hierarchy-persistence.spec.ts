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

/**
 * Minimal Prisma.TransactionClient mock that records the user.upsert phones.
 *
 * `existingSalesUsersByCode` maps an employeeCode → its existing SalesUser row (the userId the
 * persist loop resolves via salesUser.findUnique). Codes absent from the map are treated as
 * brand-new employees (findUnique → null → the create-branch phone-keyed upsert runs).
 */
function makeTx(
  existingUsers: ExistingUser[] = [],
  existingSalesUsersByCode: Record<string, { userId: string }> = {},
) {
  const upsertedUserPhones: string[] = [];
  let userSeq = 0;
  let salesSeq = 0;
  const tx = {
    user: {
      findMany: jest.fn().mockResolvedValue(existingUsers),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation((args: any) => {
        upsertedUserPhones.push(args.where.clientId_phone.phone);
        return Promise.resolve({ id: `user-${userSeq++}` });
      }),
      update: jest
        .fn()
        .mockImplementation((args: any) => Promise.resolve({ id: args.where.id })),
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
      findUnique: jest.fn().mockImplementation((args: any) => {
        const code = args.where.clientId_employeeCode.employeeCode;
        return Promise.resolve(existingSalesUsersByCode[code] ?? null);
      }),
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

  it('updates the SAME User row in place when an existing employee’s phone is corrected (no orphan)', async () => {
    // XSR-1 already exists: SalesUser(employeeCode=XSR-1) → User(id=user-existing) at phone P1.
    // Re-upload the SAME code with a NEW phone P2. The fix must UPDATE user-existing to P2
    // (freeing P1 on the same row), NOT create a second User and orphan the old one.
    const employees = [emp({ id: 'XSR-1', mobile: '9900000002' })]; // P2
    const { tx, upsertedUserPhones } = makeTx(
      // §0b guard: P2 is not yet owned by anyone → no conflict.
      [],
      // §2: XSR-1 already has a canonical User.
      { 'XSR-1': { userId: 'user-existing' } },
    );

    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);

    // (a) the existing User row was updated in place to the new phone P2…
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-existing' },
      data: expect.objectContaining({ phone: '9900000002' }),
    });
    // (b) …and NO new User was created for this existing employee (no orphan left behind).
    expect(tx.user.upsert).not.toHaveBeenCalled();
    expect(upsertedUserPhones).toEqual([]);
    // the SalesUser is re-pointed at the SAME resolved user id, not a fresh one.
    expect(tx.salesUser.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ userId: 'user-existing' }),
      }),
    );
  });

  it('creates a fresh User via the phone-keyed upsert for a BRAND-NEW employee', async () => {
    // No existing SalesUser for XSR-NEW → findUnique returns null → the create branch runs.
    const employees = [emp({ id: 'XSR-NEW', mobile: '9900000009' })];
    const { tx, upsertedUserPhones } = makeTx([], {}); // no existing salesUser
    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(upsertedUserPhones).toEqual(['9900000009']);
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
