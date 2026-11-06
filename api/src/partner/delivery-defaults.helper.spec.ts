// Unit tests for the pure delivery-address pre-fill selector (outlet address only — owner D3 = C).
// Run: npx jest src/partner/delivery-defaults.helper.spec.ts
import { pickDeliveryDefaults } from './delivery-defaults.helper';

const fullOutlet = {
  addressLine1: '12 MG Road',
  addressLine2: null,
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

describe('pickDeliveryDefaults', () => {
  it('returns the full outlet address when everything is on file', () => {
    expect(pickDeliveryDefaults(fullOutlet)).toEqual({
      line1: '12 MG Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
    });
  });

  it('joins addressLine1 and addressLine2 with ", " into the street line', () => {
    const res = pickDeliveryDefaults({ ...fullOutlet, addressLine1: 'Shop 4', addressLine2: 'Near Bus Stand' });
    expect(res?.line1).toBe('Shop 4, Near Bus Stand');
  });

  it('uses addressLine2 alone when addressLine1 is blank', () => {
    const res = pickDeliveryDefaults({ ...fullOutlet, addressLine1: '  ', addressLine2: 'Near Bus Stand' });
    expect(res?.line1).toBe('Near Bus Stand');
  });

  it('keeps the other fields when the pincode is missing (partial address)', () => {
    expect(pickDeliveryDefaults({ ...fullOutlet, pincode: null })).toEqual({
      line1: '12 MG Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: null,
    });
  });

  it.each(['011001', '41100', '4110011', '41100a', '0'])('drops an invalid pincode %p', (pincode) => {
    expect(pickDeliveryDefaults({ ...fullOutlet, pincode })?.pincode).toBeNull();
  });

  it('trims a valid pincode with surrounding whitespace', () => {
    expect(pickDeliveryDefaults({ ...fullOutlet, pincode: ' 411001 ' })?.pincode).toBe('411001');
  });

  it('keeps city and state for a Bajaj outlet with no street or pincode on file', () => {
    expect(
      pickDeliveryDefaults({ addressLine1: null, addressLine2: null, city: 'Pune', state: 'Maharashtra', pincode: null }),
    ).toEqual({ line1: null, city: 'Pune', state: 'Maharashtra', pincode: null });
  });

  it('turns a whitespace-only street into null and trims the rest', () => {
    const res = pickDeliveryDefaults({ ...fullOutlet, addressLine1: '   ', city: ' Pune ', state: ' Maharashtra ' });
    expect(res).toEqual({ line1: null, city: 'Pune', state: 'Maharashtra', pincode: '411001' });
  });

  it('returns null when every outlet field is null or blank', () => {
    expect(
      pickDeliveryDefaults({ addressLine1: ' ', addressLine2: null, city: '', state: null, pincode: 'bad' }),
    ).toBeNull();
  });

  it('returns null when there is no outlet', () => {
    expect(pickDeliveryDefaults(null)).toBeNull();
  });
});
