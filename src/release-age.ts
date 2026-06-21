import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Minimum-release-age ("cooldown") support.
 *
 * Each package manager added its own knob to delay installing freshly-published
 * versions (a mitigation for supply-chain attacks). We read whichever config
 * applies and normalize it to a single value in days plus an exclude list:
 *
 *   npm   .npmrc             min-release-age          (days)
 *         .npmrc             min-release-age-exclude  (globs, comma/space sep)
 *   pnpm  pnpm-workspace.yaml minimumReleaseAge       (minutes)
 *         pnpm-workspace.yaml minimumReleaseAgeExclude (list)
 *   yarn  .yarnrc.yml        npmMinimalAgeGate         (duration string e.g. "1w")
 */

export interface ReleaseAgeConfig {
  /** Cooldown window in days. Always > 0 when present. */
  days: number;
  /** Package names / glob patterns exempt from the cooldown. */
  exclude: string[];
  /** Which manager's config this came from (for diagnostics). */
  source: 'npm' | 'pnpm' | 'yarn';
  /** Absolute path of the config file the value was read from. */
  file: string;
}

const MINUTES_PER_DAY = 1440;

/**
 * Discover release-age config by walking up from `startDir`. At each level we
 * read every supported config file; the first directory that yields any
 * configured value wins (closest config to the project takes precedence, which
 * mirrors how the package managers resolve their own config).
 *
 * When more than one manager defines a value in the same directory we keep the
 * most conservative (largest) window so the audit never under-reports risk, and
 * surface the conflict via the returned `conflicts` list.
 */
export interface ResolvedReleaseAge {
  config: ReleaseAgeConfig | null;
  /** Human-readable notes about ignored/looser configs, for a CLI warning. */
  conflicts: string[];
}

export async function resolveReleaseAgeConfig(startDir: string): Promise<ResolvedReleaseAge> {
  let dir = startDir;
  while (true) {
    const found = await readConfigsInDir(dir);
    if (found.length > 0) {
      return pickConfig(found);
    }
    const parent = dirname(dir);
    if (parent === dir) return { config: null, conflicts: [] };
    dir = parent;
  }
}

async function readConfigsInDir(dir: string): Promise<ReleaseAgeConfig[]> {
  const [npm, pnpm, yarn] = await Promise.all([
    readNpmrc(join(dir, '.npmrc')),
    readPnpmWorkspace(join(dir, 'pnpm-workspace.yaml')),
    readYarnrc(join(dir, '.yarnrc.yml')),
  ]);
  return [npm, pnpm, yarn].filter((c): c is ReleaseAgeConfig => c !== null);
}

function pickConfig(found: ReleaseAgeConfig[]): ResolvedReleaseAge {
  if (found.length === 1) return { config: found[0], conflicts: [] };
  // Most conservative (largest window) wins; report the rest.
  const sorted = found.toSorted((a, b) => b.days - a.days);
  const winner = sorted[0];
  const conflicts = sorted
    .slice(1)
    .map((c) => `${c.source} (${describeDays(c.days)} in ${c.file})`);
  return { config: winner, conflicts };
}

function describeDays(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

// ---------- npm: .npmrc (ini) ----------

async function readNpmrc(path: string): Promise<ReleaseAgeConfig | null> {
  const raw = await readFileOrNull(path);
  if (raw === null) return null;
  const ini = parseIni(raw);
  const rawValue = ini.get('min-release-age');
  if (rawValue === undefined) return null;
  const days = Number(rawValue);
  if (!Number.isFinite(days) || days <= 0) return null;
  const exclude = splitList(ini.get('min-release-age-exclude'));
  return { days, exclude, source: 'npm', file: path };
}

// ---------- pnpm: pnpm-workspace.yaml ----------

async function readPnpmWorkspace(path: string): Promise<ReleaseAgeConfig | null> {
  const raw = await readFileOrNull(path);
  if (raw === null) return null;
  const minutes = parseYamlScalarNumber(raw, 'minimumReleaseAge');
  if (minutes === null || minutes <= 0) return null;
  const exclude = parseYamlStringList(raw, 'minimumReleaseAgeExclude');
  return {
    days: minutes / MINUTES_PER_DAY,
    exclude,
    source: 'pnpm',
    file: path,
  };
}

// ---------- yarn: .yarnrc.yml ----------

async function readYarnrc(path: string): Promise<ReleaseAgeConfig | null> {
  const raw = await readFileOrNull(path);
  if (raw === null) return null;
  const value = parseYamlScalarString(raw, 'npmMinimalAgeGate');
  if (value === null) return null;
  const days = parseDurationToDays(value);
  if (days === null || days <= 0) return null;
  return { days, exclude: [], source: 'yarn', file: path };
}

// ---------- parsing helpers ----------

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Minimal INI key reader for .npmrc (ignores sections/comments). */
function parseIni(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) continue; // section header
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    out.set(key, value);
  }
  return out;
}

/** Split a comma/space-separated list value into trimmed, non-empty items. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Read a top-level `key: <number>` scalar from a YAML document. */
function parseYamlScalarNumber(raw: string, key: string): number | null {
  const m = topLevelScalar(raw, key);
  if (m === null) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

/** Read a top-level `key: <string>` scalar, stripping quotes. */
function parseYamlScalarString(raw: string, key: string): string | null {
  const m = topLevelScalar(raw, key);
  if (m === null) return null;
  return m.replace(/^["']|["']$/g, '');
}

function topLevelScalar(raw: string, key: string): string | null {
  const re = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.+?)\\s*(?:#.*)?$`, 'm');
  const m = re.exec(raw);
  if (!m) return null;
  const value = m[1].trim();
  if (value === '' || value === '|' || value === '>') return null;
  return value;
}

/**
 * Read a top-level YAML sequence (`key:` followed by `- item` lines, or an
 * inline `key: [a, b]` flow sequence) into a string list.
 */
function parseYamlStringList(raw: string, key: string): string[] {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.*)$`).exec(line);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith('[')) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    // Block sequence: collect following indented `- item` lines.
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue;
      const item = /^\s+-\s*(.+?)\s*$/.exec(next);
      if (!item) break;
      items.push(item[1].trim().replace(/^["']|["']$/g, ''));
    }
    return items;
  }
  return [];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a duration string (yarn's `npmMinimalAgeGate`) into days. Accepts a bare
 * number (interpreted as seconds, matching yarn) or a unit-suffixed value such
 * as `90s`, `30m`, `12h`, `7d`, `2w`.
 */
const SECONDS_PER_DAY = 86_400;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

export function parseDurationToDays(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])?$/i.exec(trimmed);
  if (!m) return null;
  // m[1] matched \d+(\.\d+)? so Number() is always a finite value here.
  const amount = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const seconds = amount * UNIT_SECONDS[unit];
  return seconds / SECONDS_PER_DAY;
}

/** Returns true if `name` matches one of the exclude patterns (glob or exact). */
export function isExcluded(name: string, patterns: ReadonlyArray<string>): boolean {
  for (const pattern of patterns) {
    if (matchPattern(name, patternName(pattern))) return true;
  }
  return false;
}

/**
 * Extract the package-name portion of an exclude pattern, dropping any version
 * constraint. pnpm allows `webpack@4.47.0 || 5.102.1`; we only match on name.
 * Scoped names keep their leading `@` — the version `@` is the one after the
 * name, so we split on the first `@` that isn't at position 0.
 */
function patternName(pattern: string): string {
  const trimmed = pattern.trim();
  const at = trimmed.indexOf('@', 1);
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

function matchPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$');
  return re.test(name);
}
