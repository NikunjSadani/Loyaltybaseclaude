// Unit tests for the KYC DTO validation — GSTIN format (Task D, backend half).
// gstNumber stays OPTIONAL (many outlets have no GST) but, when a non-empty value
// is provided, it must match the 15-char GSTIN shape used by invoice.helpers.ts
// (2-digit state code + 10-char PAN + entity digit + 'Z' + check char).
// Run: npx jest src/kyc/dto/kyc.dto.spec.ts

import 'reflect-metadata'; // polyfill Reflect.* for the class-transformer @Type decorator
// (this spec imports the DTO standalone, not via a Nest test module that would load it)
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateKycDto } from './kyc.dto';

// The other required fields filled in so isolated gstNumber failures are unambiguous.
const baseDto = {
  outletId: 'outlet-1',
  partnerName: 'Acme Stores',
  mobile: '9900000041',
  address: '12 MG Road, Near Park',
  city: 'Delhi',
  state: 'Delhi',
  pincode: '110001',
};

// Returns the constraint keys that failed for the gstNumber property (empty when valid).
async function gstErrors(gstNumber: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateKycDto, { ...baseDto, gstNumber });
  const errors = await validate(dto);
  const gst = errors.find((e) => e.property === 'gstNumber');
  return gst ? Object.keys(gst.constraints ?? {}) : [];
}

describe('CreateKycDto — gstNumber GSTIN validation', () => {
  it('accepts a valid 15-character GSTIN', async () => {
    expect(await gstErrors('07AAACT9811F1Z9')).toEqual([]);
  });

  it('accepts another valid GSTIN (different state code + check char)', async () => {
    // 19 = West Bengal (matches invoice.helpers TECH_GIFSY.gstin shape).
    expect(await gstErrors('19AAACT9811F1Z9')).toEqual([]);
  });

  it('rejects a 12-character malformed GSTIN', async () => {
    const errs = await gstErrors('07AAACT9811F'); // PAN-ish, too short
    expect(errs).toContain('matches');
  });

  it('rejects a 15-char string in the wrong shape (no mandatory Z in slot 14)', async () => {
    const errs = await gstErrors('07AAACT9811F1A9'); // 'A' where 'Z' is required
    expect(errs).toContain('matches');
  });

  it('rejects lowercase letters (GSTIN is uppercase)', async () => {
    const errs = await gstErrors('07aaact9811f1z9');
    expect(errs).toContain('matches');
  });

  it('stays optional — undefined gstNumber passes', async () => {
    expect(await gstErrors(undefined)).toEqual([]);
  });

  it('stays optional — empty-string gstNumber passes (treated as "no GST")', async () => {
    expect(await gstErrors('')).toEqual([]);
  });

  it('stays optional — whitespace-only gstNumber passes', async () => {
    expect(await gstErrors('   ')).toEqual([]);
  });
});
