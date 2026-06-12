/// <reference types="vitest/globals" />
/**
 * TDD — Task Config API migration
 *
 * RED phase: all tests fail before implementation.
 *
 * Changes under test:
 *  1. lib/task-config.ts  — drop localStorage helpers; add async API helpers
 *  2. app/api/admin/task-config/route.ts  — new GET + PUT route
 *  3. app/sales/dashboard/page.tsx  — remove hardcoded HO_TASKS
 *  4. app/admin/settings/page.tsx  — use API helpers, not localStorage
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── A: lib/task-config.ts — API shape ───────────────────────────────────────

describe('A — lib/task-config.ts API shape', () => {
  const code = src('lib/task-config.ts');

  it('A1: no longer exports getTaskConfig (localStorage)', () => {
    expect(code).not.toMatch(/export\s+function\s+getTaskConfig/);
  });

  it('A2: no longer exports saveTaskConfig (localStorage)', () => {
    expect(code).not.toMatch(/export\s+function\s+saveTaskConfig/);
  });

  it('A3: no longer stores task config in localStorage (only reads auth token)', () => {
    // localStorage is allowed for reading the auth token, but must not be used
    // as a config store (setItem / getItem with task-related keys)
    expect(code).not.toMatch(/localStorage\.setItem/);
    expect(code).not.toMatch(/lb_task_config/);
  });

  it('A4: exports fetchTaskConfig (async)', () => {
    expect(code).toMatch(/export\s+async\s+function\s+fetchTaskConfig/);
  });

  it('A5: exports updateTaskConfig (async)', () => {
    expect(code).toMatch(/export\s+async\s+function\s+updateTaskConfig/);
  });

  it('A6: default label is "HO Notifications / Reminders"', () => {
    expect(code).toMatch(/HO Notifications \/ Reminders/);
  });

  it('A7: exports DEFAULT_TASK_CONFIG', () => {
    expect(code).toMatch(/export\s+const\s+DEFAULT_TASK_CONFIG/);
  });
});

// ─── B: API route file exists and is shaped correctly ────────────────────────

describe('B — app/api/admin/task-config/route.ts shape', () => {
  const code = src('app/api/admin/task-config/route.ts');

  it('B1: exports GET', () => {
    expect(code).toMatch(/export\s+async\s+function\s+GET/);
  });

  it('B2: exports PUT', () => {
    expect(code).toMatch(/export\s+async\s+function\s+PUT/);
  });

  it('B3: uses prisma.programSetting', () => {
    expect(code).toMatch(/programSetting/);
  });

  it('B4: uses settingKey "task_config"', () => {
    expect(code).toMatch(/task_config/);
  });

  it('B5: GET allows CLIENT_ADMIN', () => {
    expect(code).toMatch(/CLIENT_ADMIN/);
  });

  it('B6: PUT allows CLIENT_ADMIN', () => {
    // PUT must not be locked to GIFSY_ADMIN only — clients manage their own tasks
    expect(code).toMatch(/CLIENT_ADMIN/);
  });
});

// ─── C: sales/dashboard/page.tsx — hardcoded HO_TASKS removed ────────────────

describe('C — sales/dashboard/page.tsx hardcoded HO tasks removed', () => {
  const code = src('app/sales/dashboard/page.tsx');

  it('C1: no HO_TASKS const', () => {
    expect(code).not.toMatch(/const\s+HO_TASKS/);
  });

  it('C2: no ho_notification group id', () => {
    expect(code).not.toMatch(/ho_notification/);
  });

  it('C3: no hardcoded "May MTD review call"', () => {
    expect(code).not.toMatch(/May MTD review call/);
  });

  it('C4: does not import getTaskConfig (old sync version)', () => {
    expect(code).not.toMatch(/getTaskConfig/);
  });

  it('C5: imports fetchTaskConfig', () => {
    expect(code).toMatch(/fetchTaskConfig/);
  });
});

// ─── D: admin/settings/page.tsx — uses API helpers ───────────────────────────

describe('D — admin/settings/page.tsx uses API helpers', () => {
  const code = src('app/admin/settings/page.tsx');

  it('D1: does not import getTaskConfig', () => {
    expect(code).not.toMatch(/getTaskConfig/);
  });

  it('D2: does not import saveTaskConfig', () => {
    expect(code).not.toMatch(/saveTaskConfig/);
  });

  it('D3: imports fetchTaskConfig', () => {
    expect(code).toMatch(/fetchTaskConfig/);
  });

  it('D4: imports updateTaskConfig', () => {
    expect(code).toMatch(/updateTaskConfig/);
  });

  it('D5: placeholder no longer says "e.g. Others"', () => {
    expect(code).not.toMatch(/e\.g\. Others/);
  });
});

// ─── E: API route runtime ─────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  default: {
    programSetting: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser: vi.fn(),
}));

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn(() => 'client_test'),
}));

import { GET, PUT } from '../../app/api/admin/task-config/route';
import prisma        from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

const clientAdmin = { userId: 'u_1', role: 'CLIENT_ADMIN' };
const gifsyAdmin  = { userId: 'u_2', role: 'GIFSY_ADMIN'  };

function makeReq(opts: { body?: unknown; role?: string | null } = {}) {
  const { role = 'CLIENT_ADMIN', body } = opts;
  const payload = role === 'CLIENT_ADMIN' ? clientAdmin : role === 'GIFSY_ADMIN' ? gifsyAdmin : null;
  (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(payload);
  return {
    headers: { get: (k: string) => (k === 'x-tenant-slug' ? 'testclient' : null) },
    json: () => Promise.resolve(body),
  } as any;
}

const DEFAULT_CONFIG = { customTaskLabel: 'HO Notifications / Reminders', customTaskItems: [] };

describe('E — API route runtime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('E1: GET returns 401 when not authenticated', async () => {
    const req = makeReq({ role: null });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('E2: GET returns 200 for SALES_SO role (sales users can read task config)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_x', role: 'SALES_SO' });
    (prisma.programSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const req = {
      headers: { get: () => 'testclient' },
      json: () => Promise.resolve({}),
    } as any;
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('E3: GET returns default config when no setting stored', async () => {
    (prisma.programSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res  = await GET(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.config.customTaskLabel).toBe('HO Notifications / Reminders');
    expect(body.data.config.customTaskItems).toEqual([]);
  });

  it('E4: GET returns stored config when setting exists', async () => {
    const stored = { customTaskLabel: 'My Tasks', customTaskItems: [{ id: 't1', title: 'Foo', subtitle: '', priority: 'high' }] };
    (prisma.programSetting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ settingValue: stored });
    const res  = await GET(makeReq());
    const body = await res.json();
    expect(body.data.config.customTaskLabel).toBe('My Tasks');
    expect(body.data.config.customTaskItems).toHaveLength(1);
  });

  it('E5: PUT returns 401 when not authenticated', async () => {
    const res = await PUT(makeReq({ role: null, body: DEFAULT_CONFIG }));
    expect(res.status).toBe(401);
  });

  it('E6: PUT upserts programSetting with key "task_config"', async () => {
    (prisma.programSetting.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ps_1' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const req = makeReq({ body: DEFAULT_CONFIG });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const call = (prisma.programSetting.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId_settingKey.settingKey).toBe('task_config');
  });

  it('E7: PUT rejects body missing customTaskLabel', async () => {
    const req = makeReq({ body: { customTaskItems: [] } }); // missing label
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('E8: PUT returns 403 for SALES_SO (only admins can write)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 'u_x', role: 'SALES_SO' });
    const req = {
      headers: { get: () => 'testclient' },
      json: () => Promise.resolve(DEFAULT_CONFIG),
    } as any;
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it('E9: PUT accepts customTaskItems with startsAt and endsAt', async () => {
    (prisma.programSetting.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ps_1' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const config = {
      customTaskLabel: 'HO Notifications / Reminders',
      customTaskItems: [{
        id: 't1', title: 'Foo', subtitle: 'Bar', priority: 'high',
        startsAt: '2026-06-01', endsAt: '2026-06-30',
      }],
    };
    const res = await PUT(makeReq({ body: config }));
    expect(res.status).toBe(200);
  });
});

// ─── F: CustomTaskItem has date fields ───────────────────────────────────────

describe('F — CustomTaskItem has start/end date fields', () => {
  const code = src('lib/task-config.ts');

  it('F1: CustomTaskItem has startsAt?: string', () => {
    expect(code).toMatch(/startsAt\s*\?\s*:\s*string/);
  });

  it('F2: CustomTaskItem has endsAt?: string', () => {
    expect(code).toMatch(/endsAt\s*\?\s*:\s*string/);
  });

  it('F3: fetchTaskConfig sends Authorization header', () => {
    expect(code).toMatch(/Authorization/);
  });

  it('F4: updateTaskConfig sends Authorization header', () => {
    expect(code).toMatch(/Authorization/);
  });
});

// ─── G: sales dashboard filters expired tasks ────────────────────────────────

describe('G — sales/dashboard/page.tsx filters tasks by date', () => {
  const code = src('app/sales/dashboard/page.tsx');

  it('G1: filters tasks where endsAt is in the past', () => {
    expect(code).toMatch(/endsAt/);
  });

  it('G2: filters tasks where startsAt is in the future', () => {
    expect(code).toMatch(/startsAt/);
  });
});
