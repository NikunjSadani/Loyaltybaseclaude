/* ─── Task Configuration lib ─────────────────────────────────────────────────
   API-backed: reads/writes via /api/admin/task-config (ProgramSetting table).
   Default label is "HO Notifications / Reminders" — admin can rename it.
──────────────────────────────────────────────────────────────────────────── */

export interface CustomTaskItem {
  id:        string;
  title:     string;
  subtitle:  string;
  priority:  'high' | 'medium' | 'low';
  startsAt?: string;  // ISO date — if set, task is hidden before this date
  endsAt?:   string;  // ISO date — if set, task disappears after this date
}

export interface TaskConfig {
  /** Label shown for the configurable task category on the sales dashboard */
  customTaskLabel: string;
  /** Task items that appear under this category */
  customTaskItems: CustomTaskItem[];
}

export const DEFAULT_TASK_CONFIG: TaskConfig = {
  customTaskLabel: 'HO Notifications / Reminders',
  customTaskItems: [],
};

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── In-memory cache (2-minute TTL) ─────────────────────────────────────────
// Both the dashboard and the tasks page call fetchTaskConfig on mount.
// The cache means the second call in a session is instant (no network round-trip).
let _taskConfigCache: { data: TaskConfig; ts: number } | null = null;
const TASK_CONFIG_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Invalidate the in-memory cache (called after admin saves a new config). */
export function invalidateTaskConfigCache(): void {
  _taskConfigCache = null;
}

/** Fetch the current task config from the API. Falls back to default on error. */
export async function fetchTaskConfig(): Promise<TaskConfig> {
  // Return cached value if still fresh
  if (_taskConfigCache && Date.now() - _taskConfigCache.ts < TASK_CONFIG_TTL_MS) {
    return _taskConfigCache.data;
  }
  try {
    const res = await fetch('/api/admin/task-config', {
      headers: { ...authHeader() },
    });
    if (!res.ok) return DEFAULT_TASK_CONFIG;
    const json  = await res.json();
    const data: TaskConfig = json.data?.config ?? DEFAULT_TASK_CONFIG;
    _taskConfigCache = { data, ts: Date.now() };
    return data;
  } catch {
    return DEFAULT_TASK_CONFIG;
  }
}

/** Persist updated task config via the API (admin only). */
export async function updateTaskConfig(config: TaskConfig): Promise<void> {
  await fetch('/api/admin/task-config', {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body:    JSON.stringify(config),
  });
  // Bust cache so the next fetchTaskConfig call picks up the new value
  invalidateTaskConfigCache();
}
