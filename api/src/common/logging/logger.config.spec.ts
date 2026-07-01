import { buildLoggerParams } from './logger.config';

/**
 * Security-critical: the pino req serializer must never let a secret reach the logs.
 * pino-http's DEFAULT req serializer logs req.url (with query string), req.query and
 * req.params — any of which can carry a token/OTP (e.g. the KYC doc-view JWT in
 * ?token=...). We project the request to method + PATH ONLY and drop query/params/headers.
 */
describe('logger.config redaction', () => {
  const params = () => buildLoggerParams().pinoHttp as any;

  it('req serializer strips the query string and omits query/params/headers', () => {
    const out = params().serializers.req({
      id: 'r1',
      method: 'GET',
      url: '/v1/kyc/documents/view?token=SECRET_JWT&x=1',
      query: { token: 'SECRET_JWT' },
      params: { token: 'SECRET_JWT' },
      headers: { 'user-agent': 'UA', authorization: 'Bearer SECRET_BEARER' },
    });
    expect(out.url).toBe('/v1/kyc/documents/view'); // query stripped
    expect(out.method).toBe('GET');
    expect(out.id).toBe('r1');
    expect(out.userAgent).toBe('UA');
    // No secret-bearing fields survive.
    expect('query' in out).toBe(false);
    expect('params' in out).toBe(false);
    expect('headers' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('SECRET_JWT');
    expect(JSON.stringify(out)).not.toContain('SECRET_BEARER');
  });

  it('req serializer tolerates a non-string url and a missing user-agent', () => {
    const out = params().serializers.req({ id: 'r2', method: 'GET', url: undefined, headers: {} });
    expect(out.url).toBe('');
    expect(out.userAgent).toBeUndefined();
  });

  it('redacts Set-Cookie (the default res serializer still logs response headers)', () => {
    expect(params().redact.paths).toContain('res.headers["set-cookie"]');
    expect(params().redact.censor).toBe('[REDACTED]');
  });

  it('does not rely on single-level `*.token` wildcards (they gave a false sense of coverage)', () => {
    expect(params().redact.paths).not.toContain('*.token');
    expect(params().redact.paths).not.toContain('*.otp');
  });

  it('autoLogging ignores /health and /health/ready even with a query string', () => {
    const ignore = params().autoLogging.ignore;
    expect(ignore({ url: '/health' })).toBe(true);
    expect(ignore({ url: '/health/ready?x=1' })).toBe(true);
    expect(ignore({ url: '/v1/anything' })).toBe(false);
  });

  it('genReqId does not throw on an array-valued trace header and echoes x-request-id', () => {
    const res: any = { setHeader: jest.fn() };
    const id = params().genReqId(
      { headers: { 'x-cloud-trace-context': ['a/b', 'c/d'] } } as any,
      res,
    );
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', id);
  });

  it('customProps yields nulls for an unauthenticated (@Public) request', () => {
    const props = params().customProps({ headers: {} } as any);
    expect(props).toEqual({ tenantId: null, userId: null, role: null });
  });
});
