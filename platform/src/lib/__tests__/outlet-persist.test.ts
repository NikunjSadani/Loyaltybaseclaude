import { describe, it, expect } from 'vitest';
import {
  mapRowToOutletData,
  buildOutletCreate,
  buildOutletUpdate,
} from '@/lib/outlet-persist';
import type { OutletUploadRow } from '@/types';

const baseRow = (over: Partial<OutletUploadRow> = {}): OutletUploadRow => ({
  rowNum:          2,
  outletId:        'OUT-2026-001',
  outletName:      'Verma Traders',
  programName:     'Trade Loyalty',
  programCategory: 'Standard',
  outletType:      'SSS',
  beat:            'Andheri Beat',
  distributorId:   'DIST-01',
  distributorName: 'ABC Distributors',
  metro:           'Yes',
  city:            'Mumbai',
  state:           'Maharashtra',
  zone:            'West Zone',
  xsrId:           'XSR-M001',
  ...over,
});

describe('mapRowToOutletData', () => {
  it('maps the identity + locality fields from a valid row', () => {
    const data = mapRowToOutletData(baseRow(), 'ot_sss');
    expect(data.outletTypeId).toBe('ot_sss');
    expect(data.name).toBe('Verma Traders');
    expect(data.city).toBe('Mumbai');
    expect(data.state).toBe('Maharashtra');
  });

  it('carries the reference-only master-file columns through', () => {
    const data = mapRowToOutletData(baseRow(), 'ot_sss');
    expect(data.distributorCode).toBe('DIST-01');
    expect(data.distributorName).toBe('ABC Distributors');
    expect(data.beat).toBe('Andheri Beat');
    expect(data.metro).toBe('Yes');
    expect(data.zone).toBe('West Zone');
    expect(data.programName).toBe('Trade Loyalty');
    expect(data.programCategory).toBe('Standard');
  });

  it('coerces blank reference columns to null (does not overwrite with "")', () => {
    const data = mapRowToOutletData(
      baseRow({ distributorId: '', distributorName: '  ', zone: '' }),
      'ot_sss',
    );
    expect(data.distributorCode).toBeNull();
    expect(data.distributorName).toBeNull();
    expect(data.zone).toBeNull();
  });
});

describe('buildOutletCreate', () => {
  it('creates a PENDING (isActive=false) outlet with NO partnerId (owner attached at KYC)', () => {
    const data = mapRowToOutletData(baseRow(), 'ot_sss');
    const create = buildOutletCreate('deoleo', 'OUT-2026-001', data);
    expect(create.clientId).toBe('deoleo');
    expect(create.outletCode).toBe('OUT-2026-001');
    expect(create.isActive).toBe(false);
    expect(create.partnerId).toBeUndefined(); // left NULL
    expect(create.outletTypeId).toBe('ot_sss');
  });

  it('does not set addressLine1 / pincode (KYC-captured, left null)', () => {
    const create = buildOutletCreate('deoleo', 'OUT-2026-001', mapRowToOutletData(baseRow(), 'ot_sss'));
    expect(create.addressLine1).toBeUndefined();
    expect(create.pincode).toBeUndefined();
  });
});

describe('buildOutletUpdate', () => {
  it('writes the mutable columns but not identity or isActive', () => {
    const update = buildOutletUpdate(mapRowToOutletData(baseRow(), 'ot_sss'));
    expect(update.name).toBe('Verma Traders');
    expect(update.beat).toBe('Andheri Beat');
    expect(update.clientId).toBeUndefined();
    expect(update.outletCode).toBeUndefined();
    expect(update.isActive).toBeUndefined();
    expect(update.partnerId).toBeUndefined();
  });
});
