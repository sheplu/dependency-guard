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
  resolutions?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
}

export interface DependencyEntry {
  name: string;
  type: DependencyType;
  spec: string;
  installedVersion: string | null;
  transitive: boolean;
  catalogName?: string | null;
}

export interface DependencyFilters {
  prod: boolean;
  dev: boolean;
  peer: boolean;
  optional: boolean;
  overrides: boolean;
  resolutions: boolean;
  pnpmOverrides: boolean;
}

type OverrideSkipReason =
  | 'catalog'
  | 'override-path-specific'
  | 'override-reference'
  | 'override-removal'
  | 'override-descriptor';

export interface CollectedOverrides {
  entries: Array<{ name: string; version: string }>;
  skipped: Array<{
    name: string;
    reason: 'catalog' | 'override-path-specific' | 'override-reference' | 'override-descriptor';
  }>;
}

export interface CollectedResolutions {
  entries: Array<{ name: string; version: string }>;
  skipped: Array<{
    name: string;
    reason: 'catalog' | 'override-path-specific' | 'override-descriptor';
  }>;
}

export interface CollectedPnpmOverrides {
  entries: Array<{ name: string; version: string }>;
  skipped: Array<{
    name: string;
    reason: OverrideSkipReason;
  }>;
}

export interface CollectedDependencies {
  entries: DependencyEntry[];
  skipped: Array<{
    name: string;
    type: DependencyType;
    reason: OverrideSkipReason;
  }>;
}

const DESCRIPTOR_RE = /^(npm:|file:|portal:|link:|workspace:|git\+|https?:)/;
const KEY_RE = /^(@[^/]+\/)?[^/@>*]+$/;

function isAuditableSpec(v: string): boolean {
  if (v === '' || v === '-') return false;
  if (v.startsWith('$')) return false;
  return !DESCRIPTOR_RE.test(v);
}

function isAuditableKey(k: string): boolean {
  return KEY_RE.test(k);
}

export function isCatalogSpec(v: string): boolean {
  return v.startsWith('catalog:');
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
      if (isCatalogSpec(value)) {
        skipped.push({ name, reason: 'catalog' });
      } else if (value.startsWith('$')) {
        skipped.push({ name, reason: 'override-reference' });
      } else if (!isAuditableSpec(value)) {
        skipped.push({ name, reason: 'override-descriptor' });
      } else {
        entries.push({ name, version: value });
      }
      continue;
    }
    const dot = value['.'];
    if (typeof dot === 'string') {
      if (isCatalogSpec(dot)) {
        skipped.push({ name, reason: 'catalog' });
      } else if (dot.startsWith('$')) {
        skipped.push({ name, reason: 'override-reference' });
      } else if (!isAuditableSpec(dot)) {
        skipped.push({ name, reason: 'override-descriptor' });
      } else {
        entries.push({ name, version: dot });
      }
    } else {
      skipped.push({ name, reason: 'override-path-specific' });
    }
  }

  return { entries, skipped };
}

export function collectResolutions(
  raw: PackageJson['resolutions'] | undefined,
): CollectedResolutions {
  const entries: CollectedResolutions['entries'] = [];
  const skipped: CollectedResolutions['skipped'] = [];
  if (!raw) return { entries, skipped };

  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      skipped.push({ name, reason: 'override-path-specific' });
      continue;
    }
    if (!isAuditableKey(name)) {
      skipped.push({ name, reason: 'override-path-specific' });
      continue;
    }
    if (isCatalogSpec(value)) {
      skipped.push({ name, reason: 'catalog' });
      continue;
    }
    if (!isAuditableSpec(value)) {
      skipped.push({ name, reason: 'override-descriptor' });
      continue;
    }
    entries.push({ name, version: value });
  }

  return { entries, skipped };
}

export function collectPnpmOverrides(
  raw: Record<string, string> | undefined,
): CollectedPnpmOverrides {
  const entries: CollectedPnpmOverrides['entries'] = [];
  const skipped: CollectedPnpmOverrides['skipped'] = [];
  if (!raw) return { entries, skipped };

  for (const [name, value] of Object.entries(raw)) {
    if (value === '-') {
      skipped.push({ name, reason: 'override-removal' });
      continue;
    }
    if (typeof value === 'string' && value.startsWith('$')) {
      skipped.push({ name, reason: 'override-reference' });
      continue;
    }
    if (!isAuditableKey(name)) {
      skipped.push({ name, reason: 'override-path-specific' });
      continue;
    }
    if (typeof value === 'string' && isCatalogSpec(value)) {
      skipped.push({ name, reason: 'catalog' });
      continue;
    }
    if (typeof value !== 'string' || !isAuditableSpec(value)) {
      skipped.push({ name, reason: 'override-descriptor' });
      continue;
    }
    entries.push({ name, version: value });
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
  const allMode = !anyFilterSet(filters);
  const includeOverrides = allMode || filters.overrides;
  const includeResolutions = allMode || filters.resolutions;
  const includePnpmOverrides = allMode || filters.pnpmOverrides;

  const entries: DependencyEntry[] = [];
  const skipped: CollectedDependencies['skipped'] = [];

  for (const [type, deps] of buckets) {
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (isCatalogSpec(spec)) {
        skipped.push({ name, type, reason: 'catalog' });
        continue;
      }
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

  if (includeResolutions) {
    const collected = collectResolutions(pkg.resolutions);
    for (const entry of collected.entries) {
      const installed = await readInstalledVersion(projectDir, entry.name);
      entries.push({
        name: entry.name,
        type: 'resolutions',
        spec: entry.version,
        installedVersion: installed ?? stripRange(entry.version),
        transitive: false,
      });
    }
    for (const s of collected.skipped) {
      skipped.push({ name: s.name, type: 'resolutions', reason: s.reason });
    }
  }

  if (includePnpmOverrides) {
    const collected = collectPnpmOverrides(pkg.pnpm?.overrides);
    for (const entry of collected.entries) {
      const installed = await readInstalledVersion(projectDir, entry.name);
      entries.push({
        name: entry.name,
        type: 'pnpm.overrides',
        spec: entry.version,
        installedVersion: installed ?? stripRange(entry.version),
        transitive: false,
      });
    }
    for (const s of collected.skipped) {
      skipped.push({ name: s.name, type: 'pnpm.overrides', reason: s.reason });
    }
  }

  entries.sort((a, b) => {
    const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return typeDiff !== 0 ? typeDiff : a.name.localeCompare(b.name);
  });
  return { entries, skipped };
}

export const TYPE_ORDER: Record<DependencyType, number> = {
  dependencies: 0,
  devDependencies: 1,
  peerDependencies: 2,
  optionalDependencies: 3,
  overrides: 4,
  resolutions: 5,
  'pnpm.overrides': 6,
  catalog: 7,
};

function anyFilterSet(filters: DependencyFilters): boolean {
  return (
    filters.prod ||
    filters.dev ||
    filters.peer ||
    filters.optional ||
    filters.overrides ||
    filters.resolutions ||
    filters.pnpmOverrides
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
