import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SQL_NOW_UTC, sqlUtc } from './sql-time';

/** Every non-spec .ts file of the Sales Import module + the owned-KPI branches it added to targets.service.ts. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !/\.(spec|testspec)\.ts$/.test(p)) out.push(p);
    }
  };
  walk(__dirname);
  out.push(join(__dirname, '..', 'targets', 'targets.service.ts'));
  return out;
}

describe('raw-SQL time is session-time-zone independent (real-DB finding 3)', () => {
  it('no bare now() / CURRENT_TIMESTAMP / LOCALTIMESTAMP in raw SQL — only (now() AT TIME ZONE \'UTC\') via sql-time.ts', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // comments
          const bare = /(?<![.\w])now\(\)(?!\s*AT TIME ZONE 'UTC')/.test(line.replace(/Date\.now\(\)/g, ''));
          if (bare || /CURRENT_TIMESTAMP|LOCALTIMESTAMP/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('SQL_NOW_UTC / sqlUtc produce UTC timestamp-without-zone values whatever the session zone', () => {
    expect(SQL_NOW_UTC.strings.join('?')).toBe("(now() AT TIME ZONE 'UTC')");
    const d = new Date(Date.UTC(2026, 10, 10, 8, 30, 0, 123));
    const s = sqlUtc(d);
    expect(s.strings.join('?')).toBe("(?::timestamptz AT TIME ZONE 'UTC')");
    expect(s.values).toEqual(['2026-11-10T08:30:00.123Z']); // ISO text with its 'Z' — never a session-local value
  });
});
