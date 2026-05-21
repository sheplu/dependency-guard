import { readFile, writeFile } from 'node:fs/promises';
import { isOverrideType } from './analyze.ts';
import type {
  AnalysisReport,
  DependencyType,
  UpdateLevel,
  VersionInfo,
} from './types.ts';
import type { PackageJson } from './package-json.ts';

export interface PlannedUpdate {
  name: string;
  type: DependencyType;
  from: string;
  to: string;
  oldSpec: string;
  newSpec: string;
}

export function planUpdates(
  report: AnalysisReport,
  level: UpdateLevel,
  originalSpecs: ReadonlyMap<string, string>,
): PlannedUpdate[] {
  const out: PlannedUpdate[] = [];
  for (const dep of report.dependencies) {
    if (dep.transitive) continue;
    if (isOverrideType(dep.type)) continue;
    const target = pickTarget(dep.latestPatch, dep.latestMinor, dep.latestMajor, level);
    if (!target) continue;
    if (target.version === dep.current.version) continue;

    const oldSpec = originalSpecs.get(dep.name) ?? dep.current.version;
    out.push({
      name: dep.name,
      type: dep.type,
      from: dep.current.version,
      to: target.version,
      oldSpec,
      newSpec: applyRange(oldSpec, target.version),
    });
  }
  return out;
}

function pickTarget(
  latestPatch: VersionInfo | null,
  latestMinor: VersionInfo | null,
  latestMajor: VersionInfo | null,
  level: UpdateLevel,
): VersionInfo | null {
  if (level === 'major' || level === 'all') return latestMajor ?? latestMinor ?? latestPatch;
  if (level === 'minor') return latestMinor ?? latestPatch;
  return latestPatch;
}

export function applyRange(oldSpec: string, version: string): string {
  // Detect leading range marker. Mirrors stripRange() logic in semver.ts.
  const match = /^([\^~><=v\s]+)/.exec(oldSpec);
  const marker = match ? match[1].replace(/v/g, '').trim() : '';
  return marker + version;
}

export async function applyUpdates(
  packageJsonPath: string,
  updates: ReadonlyArray<PlannedUpdate>,
): Promise<void> {
  const raw = await readFile(packageJsonPath, 'utf8');
  const indent = detectIndent(raw);
  const trailingNewline = raw.endsWith('\n');
  const pkg = JSON.parse(raw) as Record<string, unknown>;

  for (const update of updates) {
    const bucket = pkg[update.type] as Record<string, string> | undefined;
    if (!bucket || !(update.name in bucket)) continue;
    bucket[update.name] = update.newSpec;
  }

  const out = JSON.stringify(pkg, null, indent) + (trailingNewline ? '\n' : '');
  await writeFile(packageJsonPath, out, 'utf8');
}

export function detectIndent(raw: string): number | string {
  const m = /\n(\t|  +)/.exec(raw);
  if (!m) return 2;
  if (m[1].startsWith('\t')) return '\t';
  return m[1].length;
}

export function collectAllSpecs(pkg: PackageJson): Map<string, string> {
  const out = new Map<string, string>();
  const buckets = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;
  for (const bucket of buckets) {
    const entries = pkg[bucket];
    if (!entries) continue;
    for (const [name, spec] of Object.entries(entries)) {
      out.set(name, spec);
    }
  }
  return out;
}
