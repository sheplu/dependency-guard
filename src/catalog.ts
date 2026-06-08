import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DependencyEntry } from './package-json.ts';
import { isCatalogSpec, readInstalledVersion } from './package-json.ts';
import type { PlannedUpdate } from './update.ts';
import { stripRange } from './semver.ts';

interface CatalogEntry {
  name: string;
  spec: string;
  catalogName: string | null;
  lineIndex: number;
}

export async function findWorkspaceFile(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'pnpm-workspace.yaml');
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // not found here, try parent
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseCatalogYaml(raw: string): CatalogEntry[] {
  const lines = raw.split('\n');
  const entries: CatalogEntry[] = [];

  type State = 'top' | 'default-catalog' | 'named-catalog' | 'named-catalog-pkg';
  let state: State = 'top';
  let currentCatalogName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    // Column-0 line: top-level key
    if (!line.startsWith(' ')) {
      const trimmed = line.trimEnd();
      if (trimmed === 'catalog:') {
        state = 'default-catalog';
      } else if (trimmed === 'catalogs:') {
        state = 'named-catalog';
      } else {
        state = 'top';
      }
      continue;
    }

    if (state === 'top') continue;

    if (state === 'default-catalog') {
      // 2-space indented package entries
      if (line.startsWith('  ') && !line.startsWith('    ')) {
        const m = /^  (\S[^:]*?)\s*:\s*(.+?)\s*(?:#.*)?$/.exec(line);
        if (m) {
          entries.push({ name: m[1].trim(), spec: m[2].trim(), catalogName: null, lineIndex: i });
        }
      }
      continue;
    }

    if (state === 'named-catalog') {
      // 2-space indented: a catalog name key (ends with colon, no value)
      if (line.startsWith('  ') && !line.startsWith('    ')) {
        const m = /^  (\S[^:]*?)\s*:\s*$/.exec(line);
        if (m) {
          currentCatalogName = m[1].trim();
          state = 'named-catalog-pkg';
        }
      }
      continue;
    }

    if (state === 'named-catalog-pkg') {
      // 2-space indented: next catalog name key
      if (line.startsWith('  ') && !line.startsWith('    ')) {
        const m = /^  (\S[^:]*?)\s*:\s*$/.exec(line);
        if (m) currentCatalogName = m[1].trim();
        continue;
      }
      // 4-space indented: package entry under current named catalog
      if (line.startsWith('    ') && !line.startsWith('      ')) {
        const m = /^    (\S[^:]*?)\s*:\s*(.+?)\s*(?:#.*)?$/.exec(line);
        if (m) {
          entries.push({
            name: m[1].trim(),
            spec: m[2].trim(),
            catalogName: currentCatalogName,
            lineIndex: i,
          });
        }
      }
    }
  }

  return entries;
}

export async function collectCatalogEntries(
  workspaceFilePath: string,
  projectDir: string,
): Promise<DependencyEntry[]> {
  let raw: string;
  try {
    raw = await readFile(workspaceFilePath, 'utf8');
  } catch {
    return [];
  }

  const workspaceRootDir = dirname(workspaceFilePath);
  const parsed = parseCatalogYaml(raw);
  const entries: DependencyEntry[] = [];

  for (const entry of parsed) {
    if (isCatalogSpec(entry.spec)) continue;
    const installed = await readInstalledVersion(workspaceRootDir, entry.name)
      ?? await readInstalledVersion(projectDir, entry.name);
    entries.push({
      name: entry.name,
      type: 'catalog',
      spec: entry.spec,
      installedVersion: installed ?? stripRange(entry.spec),
      transitive: false,
      catalogName: entry.catalogName,
    });
  }

  return entries;
}

export async function applyCatalogUpdates(
  workspaceFilePath: string,
  updates: ReadonlyArray<PlannedUpdate>,
): Promise<void> {
  if (updates.length === 0) return;

  const raw = await readFile(workspaceFilePath, 'utf8');
  const lines = raw.split('\n');

  const parsed = parseCatalogYaml(raw);

  // Build lookup: name → matching catalog entries (may appear in multiple catalogs)
  const byName = new Map<string, CatalogEntry[]>();
  for (const e of parsed) {
    const existing = byName.get(e.name);
    if (existing) existing.push(e);
    else byName.set(e.name, [e]);
  }

  for (const update of updates) {
    if (update.type !== 'catalog') continue;
    const candidates = byName.get(update.name);
    if (!candidates) continue;

    // If the same package appears in multiple catalogs, match by current spec
    const target = candidates.length === 1
      ? candidates[0]
      : candidates.find((c) => c.spec === update.oldSpec) ?? candidates[0];

    const original = lines[target.lineIndex];
    // Replace the spec value: group1 = indentation+name+colon+space, group2 = spec, group3 = rest
    const replaced = original.replace(
      /^(\s+\S[^:]*:\s+)(\S+)(.*)?$/,
      (_, g1, _g2, g3) => `${g1}${update.newSpec}${g3 ?? ''}`,
    );
    lines[target.lineIndex] = replaced;
  }

  await writeFile(workspaceFilePath, lines.join('\n'), 'utf8');
}
