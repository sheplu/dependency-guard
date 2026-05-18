import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripRange } from './semver.ts';
import type { DependencyType } from './types.ts';

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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

export async function collectDependencies(
  pkgJsonPath: string,
  filters: DependencyFilters,
): Promise<DependencyEntry[]> {
  const pkg = await readPackageJson(pkgJsonPath);
  const projectDir = dirname(pkgJsonPath);
  const buckets = pickBuckets(pkg, filters);

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
  entries.sort((a, b) => {
    const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return typeDiff !== 0 ? typeDiff : a.name.localeCompare(b.name);
  });
  return entries;
}

const TYPE_ORDER: Record<DependencyType, number> = {
  dependencies: 0,
  devDependencies: 1,
  peerDependencies: 2,
  optionalDependencies: 3,
};

function pickBuckets(
  pkg: PackageJson,
  filters: DependencyFilters,
): ReadonlyArray<readonly [DependencyType, Record<string, string> | undefined]> {
  const all = !filters.prod && !filters.dev && !filters.peer && !filters.optional;
  const out: Array<readonly [DependencyType, Record<string, string> | undefined]> = [];
  if (all || filters.prod) out.push(['dependencies', pkg.dependencies]);
  if (all || filters.dev) out.push(['devDependencies', pkg.devDependencies]);
  if (all || filters.peer) out.push(['peerDependencies', pkg.peerDependencies]);
  if (all || filters.optional) out.push(['optionalDependencies', pkg.optionalDependencies]);
  return out;
}
