// M1 (2026-11-20): only a TRUSTED call (valid internal secret) is fingerprinted, from the browser's x-client-*.
import { Logger } from '@nestjs/common';
import { AuthController } from './auth.controller';

const SECRET = 'controller-test-internal-secret-0123';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

describe('AuthController.refresh — device fingerprint trust (M1)', () => {
  let refreshToken: jest.Mock;
  let controller: AuthController;
  let warn: jest.SpyInstance;
  const prev = process.env.INTERNAL_PROXY_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_PROXY_SECRET = SECRET;
    refreshToken = jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    controller = new AuthController({ refreshToken } as any);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (prev === undefined) delete process.env.INTERNAL_PROXY_SECRET;
    else process.env.INTERNAL_PROXY_SECRET = prev;
  });

  const fpPassed = () => refreshToken.mock.calls[0][1].fingerprint;

  it('trusted (valid secret) + browser x-client-user-agent → a v3 fingerprint', async () => {
    await controller.refresh({ refreshToken: 'rt' } as any, '4000', undefined, SECRET, PHONE_UA, '"Android"', '?1');
    expect(fpPassed()).toMatch(/^v3:/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('UNTRUSTED (no / wrong secret) → fingerprint UNKNOWN (null), and a WARN when x-client-* was sent anyway', async () => {
    await controller.refresh({ refreshToken: 'rt' } as any, '4000', undefined, 'wrong-secret-value-000000000', PHONE_UA, '"Android"', '?1');
    expect(fpPassed()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WITHOUT a valid x-internal-proxy-secret/));
  });

  it('secret NOT configured on the API → nothing trusted → UNKNOWN', async () => {
    delete process.env.INTERNAL_PROXY_SECRET;
    await controller.refresh({ refreshToken: 'rt' } as any, '4000', undefined, SECRET, PHONE_UA);
    expect(fpPassed()).toBeNull();
  });

  it('trusted but WITHOUT x-client-user-agent (older frontend) → UNKNOWN, no WARN', async () => {
    await controller.refresh({ refreshToken: 'rt' } as any, '4000', undefined, SECRET);
    expect(fpPassed()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('trusted, but the forwarded UA is not a browser (e.g. Node) → UNKNOWN', async () => {
    await controller.refresh({ refreshToken: 'rt' } as any, '4000', undefined, SECRET, 'node');
    expect(fpPassed()).toBeNull();
  });
});
