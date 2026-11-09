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

// Returns the constraint keys that failed for the upiId property (empty when valid).
async function upiErrors(upiId: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateKycDto, { ...baseDto, upiId });
  const errors = await validate(dto);
  const upi = errors.find((e) => e.property === 'upiId');
  return upi ? Object.keys(upi.constraints ?? {}) : [];
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

// Fix A — backend UPI format guard. upiId stays OPTIONAL but, when a non-empty value
// is provided, it must match the VPA shape mirrored from platform/src/lib/upi-utils.ts
// isValidUpiId. Validation runs BEFORE the service lowercase-normalizes, so MIXED-case
// VPAs must pass.
describe('CreateKycDto — upiId VPA validation', () => {
  it('accepts a valid VPA', async () => {
    expect(await upiErrors('name@okicici')).toEqual([]);
  });

  it('accepts a MIXED-CASE VPA (validation runs before lowercase-normalize)', async () => {
    expect(await upiErrors('Name@OKICICI')).toEqual([]);
  });

  it('accepts a whitespace-padded VPA and trims it (mobile autofill/paste)', async () => {
    expect(await upiErrors('  name@okicici  ')).toEqual([]);
    // @Transform runs during plainToInstance, so the instance already holds the trimmed value.
    const dto = plainToInstance(CreateKycDto, { ...baseDto, upiId: '  name@okicici  ' });
    expect(dto.upiId).toBe('name@okicici');
  });

  it('rejects a malformed value (no @) with the upiId message', async () => {
    expect(await upiErrors('garbage')).toContain('matches');
  });

  it('stays optional — undefined upiId passes', async () => {
    expect(await upiErrors(undefined)).toEqual([]);
  });

  it('stays optional — empty-string upiId passes', async () => {
    expect(await upiErrors('')).toEqual([]);
  });

  it('stays optional — whitespace-only upiId passes', async () => {
    expect(await upiErrors('   ')).toEqual([]);
  });
});

// VPA safeguards — how the UPI was captured ('QR' | 'MANUAL'; optional).
describe('CreateKycDto — upiCaptureMethod', () => {
  const methodErrors = async (upiCaptureMethod: unknown): Promise<string[]> => {
    const errors = await validate(plainToInstance(CreateKycDto, { ...baseDto, upiCaptureMethod }));
    const e = errors.find((x) => x.property === 'upiCaptureMethod');
    return e ? Object.keys(e.constraints ?? {}) : [];
  };

  it('accepts QR, MANUAL and omitted', async () => {
    expect(await methodErrors('QR')).toEqual([]);
    expect(await methodErrors('MANUAL')).toEqual([]);
    expect(await methodErrors(undefined)).toEqual([]);
  });

  it("rejects 'FOO'", async () => {
    expect(await methodErrors('FOO')).toContain('isIn');
  });
});
