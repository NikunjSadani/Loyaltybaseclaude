// Unit tests for CapturePayoutDetailsDto upiId validation (Fix A — backend UPI
// format guard). upiId stays OPTIONAL but, when a non-empty value is provided, it
// must match the VPA shape mirrored from platform/src/lib/upi-utils.ts isValidUpiId
// (/^[a-zA-Z0-9._-]{2,}@[a-zA-Z][a-zA-Z0-9]{1,}$/). Validation runs BEFORE the
// service lowercase-normalizes, so MIXED-case VPAs must pass.
// Run: npx jest src/partner/dto/partner.dto.spec.ts

import 'reflect-metadata'; // polyfill Reflect.* for class-transformer decorators
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CapturePayoutDetailsDto } from './partner.dto';

// paymentMode is @IsIn(['bank','upi']) and required; set it so isolated upiId
// failures are unambiguous.
const baseDto = { paymentMode: 'upi' as const };

// Returns the constraint keys that failed for the upiId property (empty when valid).
async function upiErrors(upiId: unknown): Promise<string[]> {
  const dto = plainToInstance(CapturePayoutDetailsDto, { ...baseDto, upiId });
  const errors = await validate(dto);
  const e = errors.find((x) => x.property === 'upiId');
  return e ? Object.keys(e.constraints ?? {}) : [];
}

describe('CapturePayoutDetailsDto — upiId VPA validation', () => {
  it('accepts a valid VPA', async () => {
    expect(await upiErrors('name@okicici')).toEqual([]);
  });

  it('accepts a MIXED-CASE VPA (validation runs before lowercase-normalize)', async () => {
    expect(await upiErrors('Name@OKICICI')).toEqual([]);
  });

  it('accepts a whitespace-padded VPA and trims it (mobile autofill/paste)', async () => {
    expect(await upiErrors('  name@okicici  ')).toEqual([]);
    // @Transform runs during plainToInstance, so the instance already holds the trimmed value.
    const dto = plainToInstance(CapturePayoutDetailsDto, { ...baseDto, upiId: '  name@okicici  ' });
    expect(dto.upiId).toBe('name@okicici');
  });

  it('accepts a VPA with dots/underscores/hyphens and digits in the local part', async () => {
    expect(await upiErrors('9876543210@paytm')).toEqual([]);
    expect(await upiErrors('name.surname_1-2@ybl')).toEqual([]);
  });

  it('rejects a malformed value (no @) with the upiId message', async () => {
    const errs = await upiErrors('garbage');
    expect(errs).toContain('matches');
  });

  it('rejects a VPA whose provider starts with a digit', async () => {
    expect(await upiErrors('name@1bank')).toContain('matches');
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
