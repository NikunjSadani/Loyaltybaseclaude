import { describe, it, expect } from 'vitest';
import { ok, err } from '../api-response';

describe('api-response helpers', () => {
  it('ok() wraps data in a success envelope, 200 by default', async () => {
    const res = ok({ id: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { id: 1 } });
  });

  it('ok() honors a custom status code', async () => {
    const res = ok({ created: true }, 201);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { created: true } });
  });

  it('err() wraps a message in an error envelope, 400 by default', async () => {
    const res = err('Bad input');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Bad input' });
  });

  it('err() honors a custom status code (e.g. 404)', async () => {
    const res = err('Not found', 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'Not found' });
  });
});
