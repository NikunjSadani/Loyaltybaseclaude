/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * resolveOutletWalletActivity — the ONE source of "which wallet cards does this outlet get",
 * shared by GET /v1/partner/me and GET /v1/kyc/:id/ledger (owner-approved, platform-wide, 2026-11-19).
 *
 * Uses an in-memory Prisma fake that HONOURS the where-clauses the helper issues, so these specs
 * prove the filters themselves (status exclusions, outlet-CODE keying, tenant scope), not just the
 * call shape.
 *
 *   A — helper unit tests (points presence, FAILED/REVERSED exclusion, outlet-code keying, loyalty)
 *   B — endpoint parity: /partner/me and /kyc/:id/ledger return EQUAL activity flags for one partner
 */

// getMe resolves the login's operable set + active selector via the group helper — out of scope
// here; pin both to "own partner p1" so the parity spec exercises only the activity signals.
jest.mock('./partner-group.helper', () => ({
  ...jest.requireActual('./partner-group.helper'),
  resolveOperableContexts: jest.fn(async () => ({
    ownPartnerId: 'p1',
    operable: [],
    groupParent: null,
  })),
  resolveActivePartnerId: jest.fn(async () => ({
    partnerId: 'p1',
    forbidden: false,
  })),
}));

import { resolveOutletWalletActivity } from './outlet-wallet-activity.helper';
import { PartnerService } from '../partner/partner.service';
import { KycService } from '../kyc/kyc.service';
import type { JwtPayload } from './decorators/current-user.decorator';

/* ── In-memory fake ──────────────────────────────────────────────────────────── */

interface Fixture {
  outlets: Array<{
    clientId: string;
    partnerId: string;
    outletCode: string;
    name: string;
    outletTypeId: string | null;
    outletType: { code: string } | null;
    deletedAt?: Date | null;
  }>; // PRIMARY first
  configs: Array<{
    clientId: string;
    outletTypeId: string;
    loyaltyEnabled: boolean;
  }>;
  wallets: Array<{
    id: string;
    partnerId: string;
    earnedPoints: number;
    lockedPoints: number;
    redeemablePoints: number;
    redeemedPoints: number;
    expiredPoints: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
  }>;
  ledger: Array<{ id: string; walletId: string }>;
  creditPayoutEntries: Array<{
    id: string;
    clientId: string;
    outletId: string;
    status: string;
  }>;
  payoutTransactions: Array<{ id: string; partnerId: string; status: string }>;
}

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  outlets: [
    {
      clientId: 'bajaj',
      partnerId: 'p1',
      outletCode: 'OUT-1',
      name: 'Shop One',
      outletTypeId: 'ot-sss',
      outletType: { code: 'SSS' },
    },
  ],
  configs: [],
  wallets: [],
  ledger: [],
  creditPayoutEntries: [],
  payoutTransactions: [],
  ...over,
});

const wallet = (
  over: Partial<Fixture['wallets'][number]> = {},
): Fixture['wallets'][number] => ({
  id: 'w1',
  partnerId: 'p1',
  earnedPoints: 0,
  lockedPoints: 0,
  redeemablePoints: 0,
  redeemedPoints: 0,
  expiredPoints: 0,
  lifetimeEarned: 0,
  lifetimeRedeemed: 0,
  ...over,
});

function fakeDb(fx: Fixture) {
  const outletsFor = (where: any) =>
    fx.outlets.filter(
      (o) =>
        o.clientId === where.clientId &&
        o.partnerId === where.partnerId &&
        !o.deletedAt,
    );
  return {
    outlet: {
      findMany: jest.fn(async ({ where }: any) => outletsFor(where)),
      findFirst: jest.fn(
        async ({ where }: any) => outletsFor(where)[0] ?? null,
      ),
    },
    outletTypeClientConfig: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.clientId_outletTypeId;
        return (
          fx.configs.find(
            (c) =>
              c.clientId === k.clientId && c.outletTypeId === k.outletTypeId,
          ) ?? null
        );
      }),
    },
    wallet: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          fx.wallets.find((w) => w.partnerId === where.partnerId) ?? null,
      ),
    },
    pointsLedger: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          fx.ledger.find((l) => l.walletId === where.walletId) ?? null,
      ),
    },
    creditPayoutEntry: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          fx.creditPayoutEntries.find(
            (e) =>
              e.clientId === where.clientId &&
              where.outletId.in.includes(e.outletId) &&
              where.status.in.includes(e.status),
          ) ?? null,
      ),
      findMany: jest.fn(async () => []),
    },
    payoutTransaction: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          fx.payoutTransactions.find(
            (t) =>
              t.partnerId === where.partnerId &&
              !where.status.notIn.includes(t.status),
          ) ?? null,
      ),
      findMany: jest.fn(async () => []),
    },
    // ── only the endpoint-parity block reads these ──
    channelPartner: {
      findFirst: jest.fn(async () => ({
        id: 'p1',
        partnerCode: 'PC1',
        businessName: 'Biz',
        ownerName: 'O',
        phone: '98',
        email: null,
        entityType: null,
      })),
    },
    kycSubmission: {
      findFirst: jest.fn(async () => ({
        id: 's1',
        userId: 'sss1',
        partnerId: 'p1',
        outletId: null,
        submitterManagerChain: [],
        partner: {
          clientId: 'bajaj',
          businessName: 'Biz',
          phone: '98',
          outlets: fx.outlets
            .slice(0, 1)
            .map((o) => ({ outletCode: o.outletCode, name: o.name })),
          wallets: fx.wallets.filter((w) => w.partnerId === 'p1'),
        },
      })),
    },
    walletTransaction: { findMany: jest.fn(async () => []) },
    creditBatch: { findMany: jest.fn(async () => []) },
  };
}

/* ── A: helper unit tests ────────────────────────────────────────────────────── */

describe('resolveOutletWalletActivity', () => {
  const run = (fx: Fixture) =>
    resolveOutletWalletActivity(fakeDb(fx) as any, 'bajaj', 'p1');

  it('no wallet, no payouts → no activity; outletType from the PRIMARY outlet', async () => {
    const res = await run(fixture());
    expect(res).toMatchObject({
      outletType: 'SSS',
      hasPointsActivity: false,
      hasPayoutActivity: false,
      loyaltyEnabled: true,
    });
  });

  it('points presence: a balance, a lifetime figure, or (with zero balances) any PointsLedger row', async () => {
    expect(
      (await run(fixture({ wallets: [wallet({ redeemablePoints: 5 })] })))
        .hasPointsActivity,
    ).toBe(true);
    expect(
      (await run(fixture({ wallets: [wallet({ lifetimeEarned: 5 })] })))
        .hasPointsActivity,
    ).toBe(true);
    expect(
      (await run(fixture({ wallets: [wallet()] }))).hasPointsActivity,
    ).toBe(false);
    expect(
      (
        await run(
          fixture({
            wallets: [wallet()],
            ledger: [{ id: 'l1', walletId: 'w1' }],
          }),
        )
      ).hasPointsActivity,
    ).toBe(true);
  });

  it('fix round 3 (B-risk): a NEGATIVE balance shows the points card even with lifetime 0 and no ledger row', async () => {
    expect(
      (await run(fixture({ wallets: [wallet({ redeemablePoints: -841 })] }))).hasPointsActivity,
    ).toBe(true);
  });

  it('payout transactions: FAILED and REVERSED do NOT count; any other status does', async () => {
    const pt = (status: string) =>
      fixture({ payoutTransactions: [{ id: 't', partnerId: 'p1', status }] });
    expect((await run(pt('FAILED'))).hasPayoutActivity).toBe(false);
    expect((await run(pt('REVERSED'))).hasPayoutActivity).toBe(false);
    expect((await run(pt('PENDING'))).hasPayoutActivity).toBe(true);
    expect((await run(pt('PAID'))).hasPayoutActivity).toBe(true);
    // Another partner's transaction never counts.
    expect(
      (
        await run(
          fixture({
            payoutTransactions: [{ id: 't', partnerId: 'p2', status: 'PAID' }],
          }),
        )
      ).hasPayoutActivity,
    ).toBe(false);
  });

  it('credit payout entries: only PENDING/PROCESSING/PAID count (FAILED/REVERSED excluded)', async () => {
    const cpe = (status: string) =>
      fixture({
        creditPayoutEntries: [
          { id: 'e', clientId: 'bajaj', outletId: 'OUT-1', status },
        ],
      });
    expect((await run(cpe('FAILED'))).hasPayoutActivity).toBe(false);
    expect((await run(cpe('REVERSED'))).hasPayoutActivity).toBe(false);
    for (const s of ['PENDING', 'PROCESSING', 'PAID'])
      expect((await run(cpe(s))).hasPayoutActivity).toBe(true);
  });

  it("credit payout entries are keyed on the outlet CODE of ANY of the partner's outlets, in the SAME tenant", async () => {
    const two = fixture({
      outlets: [
        {
          clientId: 'bajaj',
          partnerId: 'p1',
          outletCode: 'OUT-1',
          name: 'A',
          outletTypeId: 'ot-sss',
          outletType: { code: 'SSS' },
        },
        {
          clientId: 'bajaj',
          partnerId: 'p1',
          outletCode: 'OUT-2',
          name: 'B',
          outletTypeId: 'ot-sss',
          outletType: { code: 'SSS' },
        },
      ],
    });
    // Entry on the partner's SECOND outlet (by code) → counts.
    expect(
      (
        await run({
          ...two,
          creditPayoutEntries: [
            { id: 'e', clientId: 'bajaj', outletId: 'OUT-2', status: 'PAID' },
          ],
        })
      ).hasPayoutActivity,
    ).toBe(true);
    // An entry stored against an outlet PK / unrelated id → does not count.
    expect(
      (
        await run({
          ...two,
          creditPayoutEntries: [
            {
              id: 'e',
              clientId: 'bajaj',
              outletId: 'outlet-pk-1',
              status: 'PAID',
            },
          ],
        })
      ).hasPayoutActivity,
    ).toBe(false);
    // Same code in ANOTHER tenant → does not count.
    expect(
      (
        await run({
          ...two,
          creditPayoutEntries: [
            { id: 'e', clientId: 'deoleo', outletId: 'OUT-1', status: 'PAID' },
          ],
        })
      ).hasPayoutActivity,
    ).toBe(false);
    // A deleted outlet's code is not in scope.
    const deleted = fixture({
      outlets: [
        {
          clientId: 'bajaj',
          partnerId: 'p1',
          outletCode: 'OUT-9',
          name: 'X',
          outletTypeId: null,
          outletType: null,
          deletedAt: new Date(),
        },
      ],
      creditPayoutEntries: [
        { id: 'e', clientId: 'bajaj', outletId: 'OUT-9', status: 'PAID' },
      ],
    });
    expect((await run(deleted)).hasPayoutActivity).toBe(false);
  });

  it('a partner with no outlets skips the credit-payout query entirely', async () => {
    const db = fakeDb(fixture({ outlets: [] }));
    const res = await resolveOutletWalletActivity(db as any, 'bajaj', 'p1');
    expect(res.outletType).toBeNull();
    expect(db.creditPayoutEntry.findFirst).not.toHaveBeenCalled();
  });

  it('loyalty switch: OFF only on an explicit loyaltyEnabled=false row for the PRIMARY outlet type', async () => {
    expect(
      (
        await run(
          fixture({
            configs: [
              {
                clientId: 'bajaj',
                outletTypeId: 'ot-sss',
                loyaltyEnabled: false,
              },
            ],
          }),
        )
      ).loyaltyEnabled,
    ).toBe(false);
    expect(
      (
        await run(
          fixture({
            configs: [
              {
                clientId: 'bajaj',
                outletTypeId: 'ot-sss',
                loyaltyEnabled: true,
              },
            ],
          }),
        )
      ).loyaltyEnabled,
    ).toBe(true);
    // No config row → default ON (never hide on missing config).
    expect((await run(fixture())).loyaltyEnabled).toBe(true);
    // Another tenant's OFF row does not apply.
    expect(
      (
        await run(
          fixture({
            configs: [
              {
                clientId: 'deoleo',
                outletTypeId: 'ot-sss',
                loyaltyEnabled: false,
              },
            ],
          }),
        )
      ).loyaltyEnabled,
    ).toBe(true);
  });
});

/* ── B: endpoint parity — /partner/me vs /kyc/:id/ledger ─────────────────────── */

describe('activity parity: GET /v1/partner/me ≡ GET /v1/kyc/:id/ledger meta', () => {
  const partnerUser: JwtPayload = {
    sub: 'sss1',
    role: 'SSS',
    clientId: 'bajaj',
    phone: '98',
    name: '',
  };
  const tenant = {
    resolveClient: jest.fn(async () => ({
      features: { wholesalerPayoutInclActivation: true },
    })),
  };

  async function both(fx: Fixture) {
    const db = fakeDb(fx);
    const partner = new PartnerService(
      db as any,
      tenant as any,
      {} as any,
      {} as any,
    );
    const kyc = new KycService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      tenant as any,
      {} as any,
      {} as any,
      {} as any,
    );
    // Sales hierarchy scoping is covered in kyc.service.spec; here the caller may view the submission.
    jest
      .spyOn(kyc as any, 'assertCanViewSubmission')
      .mockResolvedValue(undefined);
    const me = await partner.getMe(partnerUser);
    const ledger = await kyc.ledger(partnerUser, 's1');
    const pick = (o: any) => ({
      outletType: o.outletType,
      hasPointsActivity: o.hasPointsActivity,
      hasPayoutActivity: o.hasPayoutActivity,
      loyaltyEnabled: o.loyaltyEnabled,
    });
    return { me: pick(me), meta: pick(ledger.meta), ledger, rawMe: me };
  }

  const cases: Array<[string, Fixture]> = [
    ['no activity', fixture()],
    [
      'payout-only retailer, loyalty off',
      fixture({
        configs: [
          { clientId: 'bajaj', outletTypeId: 'ot-sss', loyaltyEnabled: false },
        ],
        creditPayoutEntries: [
          { id: 'e', clientId: 'bajaj', outletId: 'OUT-1', status: 'PAID' },
        ],
      }),
    ],
    [
      'wholesaler with points + payout',
      fixture({
        outlets: [
          {
            clientId: 'bajaj',
            partnerId: 'p1',
            outletCode: 'W-1',
            name: 'Whole',
            outletTypeId: 'ot-w',
            outletType: { code: 'WHOLESALER' },
          },
        ],
        wallets: [
          wallet({
            earnedPoints: 900,
            redeemablePoints: 400,
            lifetimeEarned: 900,
          }),
        ],
        payoutTransactions: [{ id: 't', partnerId: 'p1', status: 'PAID' }],
      }),
    ],
    [
      'only FAILED/REVERSED payouts + ledger-only points',
      fixture({
        wallets: [wallet()],
        ledger: [{ id: 'l', walletId: 'w1' }],
        payoutTransactions: [
          { id: 't1', partnerId: 'p1', status: 'FAILED' },
          { id: 't2', partnerId: 'p1', status: 'REVERSED' },
        ],
      }),
    ],
  ];

  it.each(cases)('%s → equal flags', async (_name, fx) => {
    const { me, meta } = await both(fx);
    expect(meta).toEqual(me);
  });

  it('the ledger also carries the same tenant feature flag + wallet balance the partner card reads', async () => {
    const { ledger, rawMe } = await both(cases[2][1]);
    expect(ledger.meta.wholesalerPayoutInclActivation).toBe(true);
    expect(!!(rawMe.features as any).wholesalerPayoutInclActivation).toBe(true);
    expect(ledger.meta.walletBalance).toMatchObject({
      earnedPoints: 900,
      redeemablePoints: 400,
    });
  });
});
