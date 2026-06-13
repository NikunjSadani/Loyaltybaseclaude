import { api, authHeader, type ApiResponse } from '../api-client';

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/* ─── authHeader ──────────────────────────────────────────────────────────── */

describe('authHeader', () => {
  it('returns empty object when no token in localStorage', () => {
    expect(authHeader()).toEqual({});
  });

  it('returns Authorization header when token exists', () => {
    localStorage.setItem('token', 'test-jwt-123');
    expect(authHeader()).toEqual({ Authorization: 'Bearer test-jwt-123' });
  });
});

/* ─── api.get ─────────────────────────────────────────────────────────────── */

describe('api.get', () => {
  it('returns the parsed body on a 200 response', async () => {
    const payload: ApiResponse<{ points: number }> = { success: true, data: { points: 42 } };
    vi.stubGlobal('fetch', mockFetch(payload));

    const result = await api.get<{ points: number }>('/api/wallet');

    expect(result).toEqual(payload);
  });

  it('sends Authorization header when token exists', async () => {
    localStorage.setItem('token', 'my-token');
    const fetchMock = mockFetch({ success: true, data: {} });
    vi.stubGlobal('fetch', fetchMock);

    await api.get('/api/wallet');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });

  it('does NOT send Content-Type on GET', async () => {
    vi.stubGlobal('fetch', mockFetch({ success: true, data: {} }));

    await api.get('/api/wallet');

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns { success: false, error } on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'Unauthorized' }, 401));

    const result = await api.get('/api/wallet');

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
  });

  it('returns { success: false, error } on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));

    const result = await api.get('/api/wallet');

    expect(result).toEqual({ success: false, error: 'Failed to fetch' });
  });
});

/* ─── api.post ────────────────────────────────────────────────────────────── */

describe('api.post', () => {
  it('sends POST with Content-Type and JSON body', async () => {
    const fetchMock = mockFetch({ success: true, data: { id: '1' } });
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/api/rewards/redeem', { rewardId: 'r1', points: 100 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rewards/redeem');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ rewardId: 'r1', points: 100 }));
  });
});

/* ─── api.del ─────────────────────────────────────────────────────────────── */

describe('api.del', () => {
  it('sends DELETE without body', async () => {
    const fetchMock = mockFetch({ success: true, data: null });
    vi.stubGlobal('fetch', fetchMock);

    await api.del('/api/items/1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});
