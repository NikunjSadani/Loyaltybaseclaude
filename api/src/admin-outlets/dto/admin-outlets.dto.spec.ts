// Unit tests for ListOutletsQueryDto — the admin-outlets list pagination/filter
// query. Mirrors the channel-partners query shape (page/limit/search) + adds the
// derived KYC-status filter, and caps limit at 100 (@Max).
// Run: npx jest src/admin-outlets/dto/admin-outlets.dto.spec.ts

import 'reflect-metadata'; // polyfill Reflect.* for the class-transformer @Type decorator
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListOutletsQueryDto, UpdateOutletDto } from './admin-outlets.dto';

// Returns the constraint keys that failed for a given property (empty when valid).
async function errorsFor(input: Record<string, unknown>, property: string): Promise<string[]> {
  const dto = plainToInstance(ListOutletsQueryDto, input);
  const errors = await validate(dto);
  const e = errors.find((x) => x.property === property);
  return e ? Object.keys(e.constraints ?? {}) : [];
}

describe('ListOutletsQueryDto', () => {
  it('defaults page=1 and limit=50 when omitted', () => {
    const dto = plainToInstance(ListOutletsQueryDto, {});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(50);
  });

  it('coerces string query params to numbers (page/limit)', () => {
    const dto = plainToInstance(ListOutletsQueryDto, { page: '3', limit: '25' });
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(25);
  });

  it('rejects limit above the @Max(100) cap', async () => {
    expect(await errorsFor({ limit: '101' }, 'limit')).toContain('max');
    expect(await errorsFor({ limit: '100' }, 'limit')).toEqual([]); // 100 is allowed
  });

  it('rejects page < 1 (@Min(1))', async () => {
    expect(await errorsFor({ page: '0' }, 'page')).toContain('min');
  });

  it('accepts a valid derived kycStatus bucket and rejects an unknown one', async () => {
    expect(await errorsFor({ kycStatus: 'APPROVED' }, 'kycStatus')).toEqual([]);
    expect(await errorsFor({ kycStatus: 'RE_KYC_REQUIRED' }, 'kycStatus')).toEqual([]);
    // A RAW KycStatus enum value (not a derived bucket) is NOT a valid filter.
    expect(await errorsFor({ kycStatus: 'PENDING_GIFSY' }, 'kycStatus')).toContain('isIn');
    expect(await errorsFor({ kycStatus: 'nonsense' }, 'kycStatus')).toContain('isIn');
  });

  it('accepts an optional search string', async () => {
    expect(await errorsFor({ search: 'Verma' }, 'search')).toEqual([]);
  });
});

describe('UpdateOutletDto — single-record master edit', () => {
  // Reproduce the GLOBAL pipe config (main.ts): whitelist + forbidNonWhitelisted + transform,
  // so this test proves the endpoint actually 400s the EXCLUDED (identity/KYC/state) fields.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta: ArgumentMetadata = { type: 'body', metatype: UpdateOutletDto, data: '' };

  it('accepts a body of only the editable fields', async () => {
    const out = await pipe.transform(
      { name: 'Verma', city: 'Mumbai', outletTypeId: 'RETAILER', requiredPaymentType: 'UPI' },
      meta,
    );
    expect(out).toMatchObject({ name: 'Verma', city: 'Mumbai', outletTypeId: 'RETAILER' });
  });

  it('accepts an empty body (all fields optional → a no-op PATCH)', async () => {
    await expect(pipe.transform({}, meta)).resolves.toEqual({});
  });

  it.each([
    ['phone', { phone: '9999999999' }],
    ['outletCode', { outletCode: 'OUT-9' }],
    ['parentId', { parentId: 'parentX' }],
    ['isActive', { isActive: false }],
    ['panNumber', { panNumber: 'ABCDE1234F' }],
    ['reKycFlags', { reKycFlags: {} }],
  ])('REJECTS an excluded field (%s) via forbidNonWhitelisted', async (_label, body) => {
    await expect(pipe.transform(body, meta)).rejects.toThrow();
  });

  it('rejects a non-string editable field (name as a number)', async () => {
    await expect(pipe.transform({ name: 123 }, meta)).rejects.toThrow();
  });
});
