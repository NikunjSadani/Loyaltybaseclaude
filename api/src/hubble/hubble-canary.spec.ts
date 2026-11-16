import { checkHubbleCanaryOrder } from './hubble-canary';
import { hubbleVoucherCredentials } from './hubble-voucher';

describe('checkHubbleCanaryOrder (shared canary rule)', () => {
  const hubble = (impl: () => Promise<unknown>) => ({ getOrderByReference: jest.fn(impl) }) as never;
  const c = { referenceId: 'ref-1', hubbleOrderRef: 'H-1' };

  it('verified only for that very order with SUCCESS', async () => {
    expect(await checkHubbleCanaryOrder(hubble(async () => ({ id: 'H-1', referenceId: 'ref-1', status: 'SUCCESS' })), c)).toBeNull();
  });
  it.each([
    ['not found', async () => null, /also returned "not found"/],
    ['lookup error', async () => { throw new Error('boom'); }, /canary lookup failed/],
    ['not SUCCESS', async () => ({ status: 'PROCESSING' }), /not SUCCESS/],
    ['other reference', async () => ({ status: 'SUCCESS', referenceId: 'x' }), /different reference/],
    ['other Hubble id', async () => ({ status: 'SUCCESS', id: 'H-9' }), /different Hubble order id/],
  ])('fails closed: %s', async (_l, impl, re) => {
    expect(await checkHubbleCanaryOrder(hubble(impl as () => Promise<unknown>), c)).toMatch(re);
  });
  it('honours the time budget', async () => {
    const why = await checkHubbleCanaryOrder(hubble(() => new Promise(() => undefined)), c, 10);
    expect(why).toMatch(/time budget/);
  });
});

describe('hubbleVoucherCredentials (shared)', () => {
  it('card + PIN; number only; PIN only', () => {
    expect(hubbleVoucherCredentials({ cardNumber: ' 6001 ', cardPin: ' 42 ' })).toEqual({ code: '6001', pin: '42' });
    expect(hubbleVoucherCredentials({ cardNumber: 'AMZ-1', cardPin: null })).toEqual({ code: 'AMZ-1', pin: null });
    expect(hubbleVoucherCredentials({ cardNumber: '', cardPin: 'P-9' })).toEqual({ code: 'P-9', pin: null });
  });

  const AMAZON = '01HDRPKWFE2SMVM54TWD8S1927';
  const FLIPKART = '01GMMNJECTDZAG2YS61K58HVG8';
  it('Amazon Pay (claim-code product): the PIN IS the code; the serial number is never returned', () => {
    expect(hubbleVoucherCredentials({ cardNumber: ' 6014000000000000 ', cardPin: ' ABCD-EFGHIJ-KLMN ' }, AMAZON)).toEqual({
      code: 'ABCD-EFGHIJ-KLMN',
      pin: null,
    });
    // Claim-code product with only a card number → still deliver what exists (never empty).
    expect(hubbleVoucherCredentials({ cardNumber: 'AMZ-1', cardPin: '  ' }, AMAZON)).toEqual({ code: 'AMZ-1', pin: null });
    expect(hubbleVoucherCredentials({ cardNumber: '', cardPin: '' }, AMAZON)).toEqual({ code: null, pin: null });
  });
  it('other products keep card number + PIN (Flipkart, unknown, no productId)', () => {
    const v = { cardNumber: '6001', cardPin: '42' };
    expect(hubbleVoucherCredentials(v, FLIPKART)).toEqual({ code: '6001', pin: '42' });
    expect(hubbleVoucherCredentials(v, 'SOMETHING_ELSE')).toEqual({ code: '6001', pin: '42' });
    expect(hubbleVoucherCredentials(v, null)).toEqual({ code: '6001', pin: '42' });
    expect(hubbleVoucherCredentials(v, '  ')).toEqual({ code: '6001', pin: '42' });
  });
  it('HUBBLE_CLAIM_CODE_PRODUCT_IDS extends the claim-code list per environment', () => {
    const env = { HUBBLE_CLAIM_CODE_PRODUCT_IDS: ' X1 , ,X2' } as NodeJS.ProcessEnv;
    expect(hubbleVoucherCredentials({ cardNumber: 'S', cardPin: 'C' }, 'X2', env)).toEqual({ code: 'C', pin: null });
    expect(hubbleVoucherCredentials({ cardNumber: 'S', cardPin: 'C' }, AMAZON, env)).toEqual({ code: 'C', pin: null });
    expect(hubbleVoucherCredentials({ cardNumber: 'S', cardPin: 'C' }, FLIPKART, env)).toEqual({ code: 'S', pin: 'C' });
  });
});
