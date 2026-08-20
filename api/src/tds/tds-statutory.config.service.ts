/**
 * TdsStatutoryConfigService — the editable, platform-level, effective-by-financial-year TDS
 * statutory config (rates + thresholds).
 *
 * WHY: the statutory rates were hardcoded in tds.helpers.ts (rate194R/rate194C) and the three
 * thresholds were duplicated as constants in tds.service.ts + credits.service.ts. This service
 * makes all of them editable at the PLATFORM level, keyed by financial year, with the current
 * hardcoded values (DEFAULT_TDS_STATUTORY) as the built-in defaults. The engines call getForFy()
 * once per computation and pass the ResolvedTdsStatutory into rate194RFrom / rate194CFrom and the
 * threshold comparisons.
 *
 * STORAGE: ONE platform-level ProgramSetting row — clientId='gifsy', settingKey='tdsStatutory' —
 * whose value is an EFFECTIVE-DATED LIST { entries: [...] }. Thresholds are stored as whole
 * RUPEES for readability and converted ×100 to paise in the resolver. Rates are stored as whole
 * PERCENTAGES. Reads reuse the same program_settings store TenantSettingsService.resolveTdsPolicy
 * uses; the write goes through AdminCoreService.upsertSetting (from the controller) so the
 * config-change AuditLog fires.
 *
 * FAIL-SAFE: the read path (getForFy) NEVER throws — a missing/malformed setting, an out-of-bounds
 * entry, or a bad FY label all fall back to DEFAULT_RESOLVED_TDS_STATUTORY (logged as a warning).
 * Payouts must not break because someone stored a bad config. The WRITE path is strict
 * (validateStatutoryEntries → BadRequest) so a bad config can't be persisted in the first place.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_TDS_STATUTORY,
  DEFAULT_RESOLVED_TDS_STATUTORY,
  ResolvedTdsStatutory,
  toTdsRate,
  fyOfToday,
} from './tds.helpers';

/** The platform "tenant" that owns platform-global settings (mirrors HOLIDAY/REPORTS clientIds). */
export const TDS_STATUTORY_CLIENT_ID = 'gifsy';
/** The program_settings key under which the effective-dated statutory list is stored. */
export const TDS_STATUTORY_SETTING_KEY = 'tdsStatutory';

/**
 * One effective-dated statutory entry AS STORED (and as accepted on the PUT body). Rates are
 * whole percentages; thresholds are whole RUPEES (converted ×100 to paise by the resolver).
 * `effectiveFromFy` is a "YYYY-YY" FY label (e.g. "2026-27") — the entry applies to that FY and
 * every later FY until a newer entry supersedes it.
 */
export interface StoredStatutoryEntry {
  effectiveFromFy: string;
  r194rWithPanPct: number;
  r194rNoPanPct: number;
  c194cIndividualPct: number;
  c194cOtherPct: number;
  c194cNoPanPct: number;
  thr194cSingleRupees: number;
  thr194cFyRupees: number;
  thr194rFyRupees: number;
}

/** The starting year int of a "YYYY-YY" FY label; NaN if the label is malformed. */
function fyStartYear(fyLabel: string): number {
  return /^\d{4}-\d{2}$/.test(fyLabel) ? parseInt(fyLabel.slice(0, 4), 10) : NaN;
}

const PCT_FIELDS = [
  'r194rWithPanPct',
  'r194rNoPanPct',
  'c194cIndividualPct',
  'c194cOtherPct',
  'c194cNoPanPct',
] as const;

const RUPEE_FIELDS = ['thr194cSingleRupees', 'thr194cFyRupees', 'thr194rFyRupees'] as const;

/**
 * STRICT validation for a statutory-config write (money path). Enforces, listing the offending
 * field on any failure:
 *   - `entries` is a non-empty array;
 *   - every `effectiveFromFy` matches /^\d{4}-\d{2}$/ and is UNIQUE across the list;
 *   - every rate percentage is an INTEGER 0..95 (so den = 100 − pct stays positive and sane);
 *   - every threshold rupee value is an INTEGER >= 0.
 * Returns the normalised, typed entries. THROWS BadRequestException on any violation — never
 * silently coerces (this is the money-path write gate).
 */
export function validateStatutoryEntries(entries: unknown): StoredStatutoryEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new BadRequestException('entries must be a non-empty array of statutory config entries.');
  }
  const seenFy = new Set<string>();
  const out: StoredStatutoryEntry[] = [];

  entries.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new BadRequestException(`entries[${i}] must be an object.`);
    }
    const e = raw as Record<string, unknown>;

    const fy = e.effectiveFromFy;
    if (typeof fy !== 'string' || !/^\d{4}-\d{2}$/.test(fy)) {
      throw new BadRequestException(
        `entries[${i}].effectiveFromFy must be a "YYYY-YY" financial-year label (got ${JSON.stringify(fy)}).`,
      );
    }
    if (seenFy.has(fy)) {
      throw new BadRequestException(`entries[${i}].effectiveFromFy "${fy}" is duplicated — each FY may appear once.`);
    }
    seenFy.add(fy);

    for (const f of PCT_FIELDS) {
      const v = e[f];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 95) {
        throw new BadRequestException(
          `entries[${i}].${f} must be an integer percentage between 0 and 95 (got ${JSON.stringify(v)}).`,
        );
      }
    }
    for (const f of RUPEE_FIELDS) {
      const v = e[f];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new BadRequestException(
          `entries[${i}].${f} must be an integer number of rupees >= 0 (got ${JSON.stringify(v)}).`,
        );
      }
    }

    out.push({
      effectiveFromFy: fy,
      r194rWithPanPct: e.r194rWithPanPct as number,
      r194rNoPanPct: e.r194rNoPanPct as number,
      c194cIndividualPct: e.c194cIndividualPct as number,
      c194cOtherPct: e.c194cOtherPct as number,
      c194cNoPanPct: e.c194cNoPanPct as number,
      thr194cSingleRupees: e.thr194cSingleRupees as number,
      thr194cFyRupees: e.thr194cFyRupees as number,
      thr194rFyRupees: e.thr194rFyRupees as number,
    });
  });

  return out;
}

/** Convert one stored entry into a resolved config (pct → {num,den}; rupees ×100 → paise). */
function resolveEntry(e: StoredStatutoryEntry): ResolvedTdsStatutory {
  return {
    r194rWithPan:       toTdsRate(e.r194rWithPanPct),
    r194rNoPan:         toTdsRate(e.r194rNoPanPct),
    c194cIndividual:    toTdsRate(e.c194cIndividualPct),
    c194cOther:         toTdsRate(e.c194cOtherPct),
    c194cNoPan:         toTdsRate(e.c194cNoPanPct),
    thr194cSinglePaise: BigInt(e.thr194cSingleRupees) * 100n,
    thr194cFyPaise:     BigInt(e.thr194cFyRupees) * 100n,
    thr194rFyPaise:     BigInt(e.thr194rFyRupees) * 100n,
  };
}

/** The built-in defaults expressed in the stored (rupees/pct) shape — for the admin GET view. */
export const DEFAULT_STATUTORY_VIEW = {
  r194rWithPanPct: DEFAULT_TDS_STATUTORY.r194rWithPanPct,
  r194rNoPanPct: DEFAULT_TDS_STATUTORY.r194rNoPanPct,
  c194cIndividualPct: DEFAULT_TDS_STATUTORY.c194cIndividualPct,
  c194cOtherPct: DEFAULT_TDS_STATUTORY.c194cOtherPct,
  c194cNoPanPct: DEFAULT_TDS_STATUTORY.c194cNoPanPct,
  thr194cSingleRupees: Number(DEFAULT_TDS_STATUTORY.thr194cSinglePaise / 100n),
  thr194cFyRupees: Number(DEFAULT_TDS_STATUTORY.thr194cFyPaise / 100n),
  thr194rFyRupees: Number(DEFAULT_TDS_STATUTORY.thr194rFyPaise / 100n),
} as const;

/** JSON-safe serialisation of a resolved config (BigInt paise → string; rates as {num,den}). */
function serializeResolved(r: ResolvedTdsStatutory) {
  return {
    r194rWithPan: r.r194rWithPan,
    r194rNoPan: r.r194rNoPan,
    c194cIndividual: r.c194cIndividual,
    c194cOther: r.c194cOther,
    c194cNoPan: r.c194cNoPan,
    thr194cSinglePaise: r.thr194cSinglePaise.toString(),
    thr194cFyPaise: r.thr194cFyPaise.toString(),
    thr194rFyPaise: r.thr194rFyPaise.toString(),
  };
}

@Injectable()
export class TdsStatutoryConfigService {
  private readonly logger = new Logger(TdsStatutoryConfigService.name);

  // Parsed cache. `entries === null` means "absent/malformed → use defaults"; a non-null array is
  // the validated, stored entries. Short TTL + explicit invalidate() (called on every write).
  private cache: { entries: StoredStatutoryEntry[] | null; cachedAt: number } | null = null;
  private readonly CACHE_TTL_MS = 60 * 1000; // 60s; also busted on write via invalidate()

  constructor(private readonly prisma: PrismaService) {}

  /** Bust the in-memory cache — call on every write so the new config is visible immediately. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Load + validate the stored entries, cached. Returns the validated entries, or `null` when the
   * setting is ABSENT, MALFORMED, or ANY entry is out of bounds (fail-safe → caller uses defaults).
   * NEVER throws.
   */
  private async loadEntries(): Promise<StoredStatutoryEntry[] | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < this.CACHE_TTL_MS) {
      return this.cache.entries;
    }

    let entries: StoredStatutoryEntry[] | null = null;
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: {
          clientId_settingKey: {
            clientId: TDS_STATUTORY_CLIENT_ID,
            settingKey: TDS_STATUTORY_SETTING_KEY,
          },
        },
        select: { settingValue: true },
      });
      if (row) {
        const v = row.settingValue;
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as { entries?: unknown }).entries)) {
          // Strict validate — any out-of-bounds entry throws → caught below → defaults (fail-safe).
          entries = validateStatutoryEntries((v as { entries: unknown }).entries);
        } else {
          this.logger.warn(
            `tdsStatutory setting is present but malformed (expected { entries: [...] }); using built-in defaults.`,
          );
          entries = null;
        }
      }
    } catch (e) {
      this.logger.warn(`tdsStatutory read/parse failed; using built-in defaults: ${e}`);
      entries = null;
    }

    this.cache = { entries, cachedAt: now };
    return entries;
  }

  /**
   * Resolve the statutory config effective for `fyLabel` ("YYYY-YY", e.g. "2026-27").
   *
   * Picks the entry with the LATEST `effectiveFromFy` that is <= fyLabel (compared by starting
   * year int). If no entry qualifies — or the setting is absent/malformed/out-of-bounds, or the
   * FY label itself is malformed — returns DEFAULT_RESOLVED_TDS_STATUTORY. NEVER throws (money
   * path).
   */
  async getForFy(fyLabel: string): Promise<ResolvedTdsStatutory> {
    const entries = await this.loadEntries();
    if (!entries || entries.length === 0) return DEFAULT_RESOLVED_TDS_STATUTORY;

    const target = fyStartYear(fyLabel);
    if (Number.isNaN(target)) {
      this.logger.warn(`getForFy received a malformed FY label "${fyLabel}"; using built-in defaults.`);
      return DEFAULT_RESOLVED_TDS_STATUTORY;
    }

    let chosen: StoredStatutoryEntry | null = null;
    let chosenStart = -Infinity;
    for (const e of entries) {
      const start = fyStartYear(e.effectiveFromFy); // validated → always finite here
      if (start <= target && start > chosenStart) {
        chosen = e;
        chosenStart = start;
      }
    }

    return chosen ? resolveEntry(chosen) : DEFAULT_RESOLVED_TDS_STATUTORY;
  }

  /**
   * Admin GET payload: the raw stored entries (rupees/pct — JSON-safe), the built-in defaults,
   * and the config RESOLVED for the current FY (rates as {num,den}; thresholds as string paise).
   * `entries` is [] when nothing is stored (or the stored value was malformed — the resolved view
   * then reflects the defaults). NEVER throws.
   */
  async getAll(): Promise<{
    entries: StoredStatutoryEntry[];
    defaults: typeof DEFAULT_STATUTORY_VIEW;
    currentFyLabel: string;
    resolvedForCurrentFy: ReturnType<typeof serializeResolved>;
  }> {
    const entries = await this.loadEntries();
    const currentFyLabel = fyOfToday().fyLabel;
    const resolved = await this.getForFy(currentFyLabel);
    return {
      entries: entries ?? [],
      defaults: DEFAULT_STATUTORY_VIEW,
      currentFyLabel,
      resolvedForCurrentFy: serializeResolved(resolved),
    };
  }
}
