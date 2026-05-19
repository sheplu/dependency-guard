import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripRange } from './semver.ts';
import type { DependencyType } from './types.ts';

export type OverrideValue =
  | string
  | { '.'?: string; [path: string]: string | OverrideValue | undefined };

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, OverrideValue>;
}

export interface DependencyEntry {
  name: string;
  type: DependencyType;
  spec: string;
  installedVersion: string | null;
  transitive: boolean;
}

export interface DependencyFilters {
  prod: boolean;
  dev: boolean;
  peer: boolean;
  optional: boolean;
  overrides: boolean;
}

export interface CollectedOverrides {
  entries: Array<{ name: string; version: string }>;
  skipped: Array<{
    name: string;
    reason: 'override-path-specific' | 'override-reference';
  }>;
}

export interface CollectedDependencies {
  entries: DependencyEntry[];
  skipped: Array<{
    name: string;
    type: DependencyType;
    reason: 'override-path-specific' | 'override-reference';
  }>;
}

export async function readPackageJson(path: string): Promise<PackageJson> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

export async function readInstalledVersion(
  projectDir: string,
  pkgName: string,
): Promise<string | null> {
  const file = join(projectDir, 'node_modules', pkgName, 'package.json');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

export function collectOverrides(
  raw: PackageJson['overrides'] | undefined,
): CollectedOverrides {
  const entries: CollectedOverrides['entries'] = [];
  const skipped: CollectedOverrides['skipped'] = [];
  if (!raw) return { entries, skipped };

  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (value.startsWith('$')) {
        skipped.push({ name, reason: 'override-reference' });
      } else {
        entries.push({ name, version: value });
      }
      continue;
    }
    const dot = value['.'];
    if (typeof dot === 'string') {
      if (dot.startsWith('$')) {
        skipped.push({ name, reason: 'override-reference' });
      } else {
        entries.push({ name, version: dot });
      }
    } else {
      skipped.push({ name, reason: 'override-path-specific' });
    }
  }

  return { entries, skipped };
}

export async function collectDependencies(
  pkgJsonPath: string,
  filters: DependencyFilters,
): Promise<CollectedDependencies> {
  const pkg = await readPackageJson(pkgJsonPath);
  const projectDir = dirname(pkgJsonPath);
  const buckets = pickBuckets(pkg, filters);
  const includeOverrides = !anyFilterSet(filters) || filters.overrides;

  const entries: DependencyEntry[] = [];
  for (const [type, deps] of buckets) {
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const installed = await readInstalledVersion(projectDir, name);
      entries.push({
        name,
        type,
        spec,
        installedVersion: installed ?? stripRange(spec),
        transitive: false,
      });
    }
  }

  const skipped: CollectedDependencies['skipped'] = [];
  if (includeOverrides) {
    const collected = collectOverrides(pkg.overrides);
    for (const entry of collected.entries) {
      const installed = await readInstalledVersion(projectDir, entry.name);
      entries.push({
        name: entry.name,
        type: 'overrides',
        spec: entry.version,
        installedVersion: installed ?? stripRange(entry.version),
        transitive: false,
      });
    }
    for (const s of collected.skipped) {
      skipped.push({ name: s.name, type: 'overrides', reason: s.reason });
    }
  }

  entries.sort((a, b) => {
    const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return typeDiff !== 0 ? typeDiff : a.name.localeCompare(b.name);
  });
  return { entries, skipped };
}

const TYPE_ORDER: Record<DependencyType, number> = {
  dependencies: 0,
  devDependencies: 1,
  peerDependencies: 2,
  optionalDependencies: 3,
  overrides: 4,
};

function anyFilterSet(filters: DependencyFilters): boolean {
  return (
    filters.prod ||
    filters.dev ||
    filters.peer ||
    filters.optional ||
    filters.overrides
  );
}

function pickBuckets(
  pkg: PackageJson,
  filters: DependencyFilters,
): ReadonlyArray<readonly [DependencyType, Record<string, string> | undefined]> {
  const all = !anyFilterSet(filters);
  const out: Array<readonly [DependencyType, Record<string, string> | undefined]> = [];
  if (all || filters.prod) out.push(['dependencies', pkg.dependencies]);
  if (all || filters.dev) out.push(['devDependencies', pkg.devDependencies]);
  if (all || filters.peer) out.push(['peerDependencies', pkg.peerDependencies]);
  if (all || filters.optional) out.push(['optionalDependencies', pkg.optionalDependencies]);
  return out;
}
