import { TenantSettingsService } from './tenant-settings.service';

/**
 * Minimal Prisma mock. findMany serves getEffectiveSettings; findUnique serves the
 * uncached getVisibilityEnabledUncached read (resolves the single matching row by key).
 */
function makePrisma(rows: { settingKey: string; settingValue: unknown }[]) {
  return {
    programSetting: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn(({ where }: { where: { clientId_settingKey: { settingKey: string } } }) =>
        Promise.resolve(rows.find((r) => r.settingKey === where.clientId_settingKey.settingKey) ?? null),
      ),
    },
  } as any;
}

describe('TenantSettingsService', () => {
  const ORIGINAL_ENV = process.env.POINTS_CONVERSION_RATE;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.POINTS_CONVERSION_RATE;
    else process.env.POINTS_CONVERSION_RATE = ORIGINAL_ENV;
  });

  it('returns typed defaults when there are no rows', async () => {
    const svc = new TenantSettingsService(makePrisma([]));
    const s = await svc.getEffectiveSettings('deoleo');
    expect(s.minBankTransferAmount).toBe(250);
    expect(s.minVoucherFreeAmount).toBe(250);
    expect(s.paceAmberThreshold).toBe(10);
    expect(s.redemptionChannels).toEqual({ physicalGifts: true, vouchers: true, bankTransfer: true });
    expect(s.salesApp).toEqual({ ledgerLabel: 'Wallet', redeemGiftWholesalerOnly: true, upiEnabled: false });
    expect(s.creditsPayouts.notifyEmails).toEqual([]);
    // Master visibility switch defaults OFF (opt-in per tenant).
    expect(s.visibilityEnabled).toBe(false);
  });

  describe('getVisibilityEnabledUncached', () => {
    it('returns false when there is no row (default OFF / fail-closed)', async () => {
      expect(await new TenantSettingsService(makePrisma([])).getVisibilityEnabledUncached('deoleo')).toBe(false);
    });

    it('returns true only for a strictly-boolean true row', async () => {
      const on = makePrisma([{ settingKey: 'visibilityEnabled', settingValue: true }]);
      expect(await new TenantSettingsService(on).getVisibilityEnabledUncached('deoleo')).toBe(true);

      // Non-boolean truthy values do NOT enable (no coercion → fail-closed).
      const strung = makePrisma([{ settingKey: 'visibilityEnabled', settingValue: 'true' }]);
      expect(await new TenantSettingsService(strung).getVisibilityEnabledUncached('deoleo')).toBe(false);
    });

    it('fails CLOSED (false) when the read throws', async () => {
      const prisma = { programSetting: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) } } as any;
      expect(await new TenantSettingsService(prisma).getVisibilityEnabledUncached('deoleo')).toBe(false);
    });
  });

  it('overlays visibilityEnabled=true and ignores a non-boolean value', async () => {
    const on = await new TenantSettingsService(
      makePrisma([{ settingKey: 'visibilityEnabled', settingValue: true }]),
    ).getEffectiveSettings('deoleo');
    expect(on.visibilityEnabled).toBe(true);

    // A malformed (non-boolean) row is rejected → default OFF is kept.
    const bad = await new TenantSettingsService(
      makePrisma([{ settingKey: 'visibilityEnabled', settingValue: 'yes' }]),
    ).getEffectiveSettings('deoleo');
    expect(bad.visibilityEnabled).toBe(false);
  });

  it('derives the default conversionRate from POINTS_CONVERSION_RATE env', async () => {
    process.env.POINTS_CONVERSION_RATE = '2';
    const svc = new TenantSettingsService(makePrisma([]));
    expect(await svc.getConversionRate('deoleo')).toBe(2);
  });

  it('falls back to 1 when the env rate is unset or invalid', async () => {
    delete process.env.POINTS_CONVERSION_RATE;
    expect(await new TenantSettingsService(makePrisma([])).getConversionRate('x')).toBe(1);
    process.env.POINTS_CONVERSION_RATE = '0';
    expect(await new TenantSettingsService(makePrisma([])).getConversionRate('x')).toBe(1);
    process.env.POINTS_CONVERSION_RATE = 'abc';
    expect(await new TenantSettingsService(makePrisma([])).getConversionRate('x')).toBe(1);
  });

  it('overlays a scalar override and rejects an invalid one', async () => {
    const svc = new TenantSettingsService(makePrisma([
      { settingKey: 'conversionRate', settingValue: 5 },
      { settingKey: 'minBankTransferAmount', settingValue: 500 },
      { settingKey: 'paceAmberThreshold', settingValue: -3 }, // invalid (<0) -> ignored
    ]));
    const s = await svc.getEffectiveSettings('deoleo');
    expect(s.conversionRate).toBe(5);
    expect(s.minBankTransferAmount).toBe(500);
    expect(s.paceAmberThreshold).toBe(10); // default kept
  });

  it('rejects a non-positive conversionRate override (keeps env default)', async () => {
    process.env.POINTS_CONVERSION_RATE = '1';
    const svc = new TenantSettingsService(makePrisma([
      { settingKey: 'conversionRate', settingValue: 0 },
    ]));
    expect(await svc.getConversionRate('deoleo')).toBe(1);
  });

  it('rejects a conversionRate too small for the centi snapshot (< 0.005), keeps default', async () => {
    process.env.POINTS_CONVERSION_RATE = '1';
    // 0.001 would round to conversionRateCenti=0 and defeat the rate-freeze → rejected.
    const tooSmall = new TenantSettingsService(makePrisma([
      { settingKey: 'conversionRate', settingValue: 0.001 },
    ]));
    expect(await tooSmall.getConversionRate('deoleo')).toBe(1);
    // 0.005 is the smallest representable rate (centi=1) and IS accepted.
    const ok = new TenantSettingsService(makePrisma([
      { settingKey: 'conversionRate', settingValue: 0.005 },
    ]));
    expect(await ok.getConversionRate('deoleo')).toBe(0.005);
  });

  it('DEEP-MERGES a partial nested override, keeping sibling defaults', async () => {
    const svc = new TenantSettingsService(makePrisma([
      { settingKey: 'redemptionChannels', settingValue: { bankTransfer: false } },
      { settingKey: 'creditsPayouts', settingValue: { monthCutoffDay: 5 } },
    ]));
    const s = await svc.getEffectiveSettings('deoleo');
    // only bankTransfer flipped; the other two stay default true
    expect(s.redemptionChannels).toEqual({ physicalGifts: true, vouchers: true, bankTransfer: false });
    // only monthCutoffDay overridden; caps + notifyEmails stay default
    expect(s.creditsPayouts.monthCutoffDay).toBe(5);
    expect(s.creditsPayouts.safetyCapPoints).toBe(50000);
    expect(s.creditsPayouts.notifyEmails).toEqual([]);
  });

  it('floors the safety caps at 1 so a stored 0 cannot freeze all credit uploads', async () => {
    const svc = new TenantSettingsService(makePrisma([
      { settingKey: 'creditsPayouts', settingValue: { safetyCapPoints: 0, safetyCapInr: 0 } },
    ]));
    const s = await svc.getEffectiveSettings('deoleo');
    expect(s.creditsPayouts.safetyCapPoints).toBe(1);
    expect(s.creditsPayouts.safetyCapInr).toBe(1);
  });

  it('coerces a numeric string and filters non-string notifyEmails', async () => {
    const svc = new TenantSettingsService(makePrisma([
      { settingKey: 'minVoucherFreeAmount', settingValue: '300' },
      { settingKey: 'creditsPayouts', settingValue: { notifyEmails: ['a@b.com', 5, null, '', '   ', 'c@d.com'] } },
    ]));
    const s = await svc.getEffectiveSettings('deoleo');
    expect(s.minVoucherFreeAmount).toBe(300);
    // non-strings AND empty/whitespace strings are dropped (so a `[""]` can't swallow notifications)
    expect(s.creditsPayouts.notifyEmails).toEqual(['a@b.com', 'c@d.com']);
  });

  it('caches per clientId and busts on invalidate', async () => {
    const prisma = makePrisma([]);
    const svc = new TenantSettingsService(prisma);
    await svc.getEffectiveSettings('deoleo');
    await svc.getEffectiveSettings('deoleo');
    expect(prisma.programSetting.findMany).toHaveBeenCalledTimes(1); // 2nd read cached
    svc.invalidate('deoleo');
    await svc.getEffectiveSettings('deoleo');
    expect(prisma.programSetting.findMany).toHaveBeenCalledTimes(2); // re-read after bust
  });

  describe('outletPrograms / outletCategories allow-lists', () => {
    it('defaults include the prior hardcoded program + category lists', async () => {
      const svc = new TenantSettingsService(makePrisma([]));
      const s = await svc.getEffectiveSettings('deoleo');
      expect(s.outletPrograms).toEqual(['Trade Loyalty', 'Gold Programme']);
      expect(s.outletCategories).toEqual(['Premium', 'Standard', 'Economy']);
    });

    it('a custom array overlays (replaces) the defaults wholesale', async () => {
      const svc = new TenantSettingsService(makePrisma([
        { settingKey: 'outletPrograms',   settingValue: ['Alpha', 'Beta'] },
        { settingKey: 'outletCategories', settingValue: ['Gold', 'Silver', 'Bronze'] },
      ]));
      const s = await svc.getEffectiveSettings('deoleo');
      expect(s.outletPrograms).toEqual(['Alpha', 'Beta']);
      expect(s.outletCategories).toEqual(['Gold', 'Silver', 'Bronze']);
    });

    it('keeps the default when the value is a non-array or an empty list', async () => {
      const notArray = await new TenantSettingsService(makePrisma([
        { settingKey: 'outletPrograms', settingValue: 'Trade Loyalty' },
      ])).getEffectiveSettings('deoleo');
      expect(notArray.outletPrograms).toEqual(['Trade Loyalty', 'Gold Programme']);

      const empty = await new TenantSettingsService(makePrisma([
        { settingKey: 'outletCategories', settingValue: [] },
      ])).getEffectiveSettings('deoleo');
      expect(empty.outletCategories).toEqual(['Premium', 'Standard', 'Economy']);

      // A list that reduces to empty after cleaning (blanks + non-strings only) also keeps default.
      const reducesToEmpty = await new TenantSettingsService(makePrisma([
        { settingKey: 'outletPrograms', settingValue: ['', '   ', 5, null] },
      ])).getEffectiveSettings('deoleo');
      expect(reducesToEmpty.outletPrograms).toEqual(['Trade Loyalty', 'Gold Programme']);
    });

    it('trims entries, drops blanks/non-strings, and dedupes (order-preserving)', async () => {
      const svc = new TenantSettingsService(makePrisma([
        { settingKey: 'outletPrograms', settingValue: ['  Trade Loyalty  ', 'Gold', '', 'Gold', 7, 'Platinum'] },
      ]));
      const s = await svc.getEffectiveSettings('deoleo');
      expect(s.outletPrograms).toEqual(['Trade Loyalty', 'Gold', 'Platinum']);
    });
  });

  it('falls back to defaults if the settings read throws (never crashes a money path)', async () => {
    const prisma = { programSetting: { findMany: jest.fn().mockRejectedValue(new Error('db down')) } } as any;
    const svc = new TenantSettingsService(prisma);
    const s = await svc.getEffectiveSettings('deoleo');
    expect(s.minBankTransferAmount).toBe(250);
  });
});
