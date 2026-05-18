import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyEntry } from './package-json.ts';
import type { DependencyType } from './types.ts';

interface PackageLockNode {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLockV3 {
  lockfileVersion: number;
  packages?: Record<string, PackageLockNode>;
}

export async function expandWithLockfile(
  direct: ReadonlyArray<DependencyEntry>,
  projectDir: string,
): Promise<DependencyEntry[]> {
  const lock = await loadLockfile(projectDir);
  if (!lock) return [...direct];

  const seen = new Set(direct.map((d) => d.name));
  const queue: { name: string; type: DependencyType }[] = direct.map((d) => ({
    name: d.name,
    type: d.type,
  }));
  const transitives: DependencyEntry[] = [];

  while (queue.length > 0) {
    const { name, type } = queue.shift()!;
    const node = lock.packages?.[`node_modules/${name}`];
    if (!node) continue;
    for (const childName of allChildNames(node)) {
      if (seen.has(childName)) continue;
      seen.add(childName);
      const childNode = lock.packages?.[`node_modules/${childName}`];
      if (!childNode?.version) continue;
      transitives.push({
        name: childName,
        type,
        spec: childNode.version,
        installedVersion: childNode.version,
        transitive: true,
      });
      queue.push({ name: childName, type });
    }
  }
  return [...direct, ...transitives];
}

async function loadLockfile(projectDir: string): Promise<PackageLockV3 | null> {
  try {
    const raw = await readFile(join(projectDir, 'package-lock.json'), 'utf8');
    const parsed = JSON.parse(raw) as PackageLockV3;
    if (typeof parsed.lockfileVersion !== 'number' || parsed.lockfileVersion < 3) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function allChildNames(node: PackageLockNode): string[] {
  return [
    ...Object.keys(node.dependencies ?? {}),
    ...Object.keys(node.optionalDependencies ?? {}),
  ];
}
