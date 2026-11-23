import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * B3: the guarded tenant wipe (api/prisma/wipe-tenant-data.ts) must remove EVERY fund table of the tenant — receipts,
 * the (deprecated) ledger, the settings row and the rate history — or a re-onboarded tenant would inherit an old
 * opening balance / rates. The script runs on import, so this checks its step list statically.
 */
describe('wipe-tenant-data — fund tables', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'prisma', 'wipe-tenant-data.ts'), 'utf8');
  it.each(['FundReceipt', 'FundLedger', 'FundSettings', 'FundRate'])('wipes %s by clientId', (model) => {
    expect(src).toContain(`model: '${model}'`);
    const delegate = model.charAt(0).toLowerCase() + model.slice(1);
    expect(src).toMatch(new RegExp(`tx\.${delegate}\s*\.deleteMany\(\{ where: \{ clientId: In \} \}\)`));
  });
});
