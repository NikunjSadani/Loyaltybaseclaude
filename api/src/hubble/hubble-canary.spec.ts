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
});
