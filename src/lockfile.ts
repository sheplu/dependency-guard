import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyEntry } from './package-json.ts';
import type { DependencyType } from './types.ts';

interface LockGraph {
  resolve(name: string): { version: string; childNames: string[] } | null;
}

export async function expandWithLockfile(
  direct: ReadonlyArray<DependencyEntry>,
  projectDir: string,
): Promise<DependencyEntry[]> {
  const graph =
    (await loadNpmLock(projectDir)) ??
    (await loadPnpmLock(projectDir)) ??
    (await loadYarnLock(projectDir));
  if (!graph) return [...direct];
  return walk(direct, graph);
}

export async function detectLockfiles(
  projectDir: string,
): Promise<{ npm: boolean; pnpm: boolean; yarn: boolean }> {
  const [npm, pnpm, yarn] = await Promise.all([
    fileExists(join(projectDir, 'package-lock.json')),
    fileExists(join(projectDir, 'pnpm-lock.yaml')),
    fileExists(join(projectDir, 'yarn.lock')),
  ]);
  return { npm, pnpm, yarn };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function walk(
  direct: ReadonlyArray<DependencyEntry>,
  graph: LockGraph,
): DependencyEntry[] {
  const seen = new Set(direct.map((d) => d.name));
  const queue: { name: string; type: DependencyType }[] = direct.map((d) => ({
    name: d.name,
    type: d.type,
  }));
  const transitives: DependencyEntry[] = [];

  while (queue.length > 0) {
    const { name, type } = queue.shift()!;
    const node = graph.resolve(name);
    if (!node) continue;
    for (const childName of node.childNames) {
      if (seen.has(childName)) continue;
      seen.add(childName);
      const childNode = graph.resolve(childName);
      if (!childNode) continue;
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

// ---------- npm package-lock.json (v3+) ----------

interface NpmLockNode {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface NpmLockFile {
  lockfileVersion: number;
  packages?: Record<string, NpmLockNode>;
}

async function loadNpmLock(projectDir: string): Promise<LockGraph | null> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, 'package-lock.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: NpmLockFile;
  try {
    parsed = JSON.parse(raw) as NpmLockFile;
  } catch {
    return null;
  }
  if (typeof parsed.lockfileVersion !== 'number' || parsed.lockfileVersion < 3) {
    return null;
  }
  const packages = parsed.packages ?? {};
  return {
    resolve(name) {
      const node = packages[`node_modules/${name}`];
      if (!node?.version) return null;
      return {
        version: node.version,
        childNames: [
          ...Object.keys(node.dependencies ?? {}),
          ...Object.keys(node.optionalDependencies ?? {}),
        ],
      };
    },
  };
}

// ---------- pnpm-lock.yaml (lockfileVersion 6+, pnpm 7/8/9/10) ----------

interface PnpmEntry {
  name: string;
  version: string;
  childNames: string[];
}

async function loadPnpmLock(projectDir: string): Promise<LockGraph | null> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, 'pnpm-lock.yaml'), 'utf8');
  } catch {
    return null;
  }
  // Quick version gate: lockfileVersion 6.x or higher.
  const versionMatch = /^lockfileVersion:\s*['"]?(\d+)\.\d+['"]?/m.exec(raw);
  if (!versionMatch || Number(versionMatch[1]) < 6) return null;

  const entries = parsePnpmLock(raw);
  if (entries.length === 0) return null;

  const byName = new Map<string, PnpmEntry>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }

  return {
    resolve(name) {
      const entry = byName.get(name);
      if (!entry) return null;
      return { version: entry.version, childNames: entry.childNames };
    },
  };
}

export function parsePnpmLock(raw: string): PnpmEntry[] {
  const lines = raw.split('\n');
  const entries: PnpmEntry[] = [];
  let inPackages = false;
  let current: PnpmEntry | null = null;
  let inDeps = false;
  let inOptDeps = false;

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.trimStart().startsWith('#')) continue;

    // Top-level key (col 0, ends with ':')
    if (!line.startsWith(' ') && line.endsWith(':')) {
      finalizePnpm(current, entries);
      current = null;
      inDeps = false;
      inOptDeps = false;
      inPackages = line === 'packages:';
      continue;
    }

    if (!inPackages) continue;

    // 2-space indent: a package key. e.g. "  express@4.18.2:" or "  '@types/node@20.5.1':"
    if (line.startsWith('  ') && !line.startsWith('    ')) {
      const trimmed = line.trim();
      if (!trimmed.endsWith(':')) continue;
      const headerRaw = trimmed.slice(0, -1);
      const parsed = parsePnpmKey(headerRaw);
      finalizePnpm(current, entries);
      current = parsed
        ? { name: parsed.name, version: parsed.version, childNames: [] }
        : null;
      inDeps = false;
      inOptDeps = false;
      continue;
    }

    if (!current) continue;

    // 4-space indent: keys of the package (dependencies, optionalDependencies, etc).
    if (line.startsWith('    ') && !line.startsWith('      ')) {
      const trimmed = line.trim();
      inDeps = trimmed === 'dependencies:';
      inOptDeps = trimmed === 'optionalDependencies:';
      continue;
    }

    // 6-space indent: child entries inside dependencies/optionalDependencies.
    if (line.startsWith('      ') && (inDeps || inOptDeps)) {
      const m = /^\s+("?)([^":]+)\1:\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const value = m[3];
      // Skip flow-style mappings like `resolution: {integrity: ...}`.
      if (value.startsWith('{')) continue;
      current.childNames.push(m[2]);
    }
  }
  finalizePnpm(current, entries);
  return entries;
}

function finalizePnpm(entry: PnpmEntry | null, out: PnpmEntry[]): void {
  if (entry && entry.version !== '') out.push(entry);
}

function parsePnpmKey(headerRaw: string): { name: string; version: string } | null {
  const stripped = headerRaw.replace(/^'|'$/g, '');
  // Strip trailing peer-resolution suffix `(react@18.2.0)` etc.
  const noSuffix = stripped.replace(/\(.+\)$/, '');
  // Split on the LAST `@` so scoped names work: `@scope/name@1.2.3` → ["@scope/name", "1.2.3"]
  const at = noSuffix.lastIndexOf('@');
  if (at <= 0) return null;
  const version = noSuffix.slice(at + 1);
  if (version === '') return null;
  return { name: noSuffix.slice(0, at), version };
}

// ---------- yarn.lock (Yarn Berry, lockfileVersion 6+) ----------

interface YarnEntry {
  selectors: string[];
  version: string;
  childNames: string[];
}

async function loadYarnLock(projectDir: string): Promise<LockGraph | null> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, 'yarn.lock'), 'utf8');
  } catch {
    return null;
  }
  const entries = parseYarnLock(raw);
  if (entries.length === 0) return null;

  const byName = new Map<string, YarnEntry>();
  for (const entry of entries) {
    for (const sel of entry.selectors) {
      const name = parseSelectorName(sel);
      if (name === null) continue;
      if (!byName.has(name)) byName.set(name, entry);
    }
  }

  return {
    resolve(name) {
      const entry = byName.get(name);
      if (!entry) return null;
      return { version: entry.version, childNames: entry.childNames };
    },
  };
}

const SKIP_PROTOCOL = /@(?:workspace|patch|portal|file|exec|link):/;
const GIT_PROTOCOL = /@(?:git\+|git@|github:)/;

export function parseYarnLock(raw: string): YarnEntry[] {
  const lines = raw.split('\n');
  const entries: YarnEntry[] = [];
  let current: YarnEntry | null = null;
  let inDeps = false;
  let inOptDeps = false;

  for (const line of lines) {
    if (line.length === 0 || line.trimStart().startsWith('#')) continue;

    // Top-level entry header: starts at column 0, ends with `:`.
    if (!line.startsWith(' ') && line.endsWith(':')) {
      finalize(current, entries);
      const headerRaw = line.slice(0, -1);
      const selectors = splitSelectors(headerRaw);
      // Skip __metadata block and protocol-only entries.
      const first = selectors[0];
      if (first === '__metadata' || SKIP_PROTOCOL.test(first) || GIT_PROTOCOL.test(first)) {
        current = null;
        inDeps = false;
        inOptDeps = false;
        continue;
      }
      current = { selectors, version: '', childNames: [] };
      inDeps = false;
      inOptDeps = false;
      continue;
    }

    if (!current) continue;

    // 2-space indent: top-level keys of the entry.
    if (line.startsWith('  ') && !line.startsWith('    ')) {
      const trimmed = line.trim();
      inDeps = trimmed === 'dependencies:';
      inOptDeps = trimmed === 'optionalDependencies:';
      const versionMatch = /^version:\s*"?([^"]+)"?$/.exec(trimmed);
      if (versionMatch) {
        current.version = versionMatch[1];
      }
      continue;
    }

    // 4-space indent: child entries inside dependencies/optionalDependencies.
    if (line.startsWith('    ') && (inDeps || inOptDeps)) {
      const childMatch = /^\s+("?)([^":]+)\1:\s*("?)([^"]+)\3\s*$/.exec(line);
      if (!childMatch) continue;
      const childName = childMatch[2];
      const childSpec = childMatch[4];
      // Only follow npm: protocol children (or unprotocoled, for v1 tolerance).
      if (childSpec.startsWith('npm:') || !childSpec.includes(':')) {
        current.childNames.push(childName);
      }
    }
  }
  finalize(current, entries);
  return entries;
}

function finalize(entry: YarnEntry | null, out: YarnEntry[]): void {
  if (entry && entry.version !== '') out.push(entry);
}

function splitSelectors(headerRaw: string): string[] {
  // Headers can be a single selector or comma-separated. Strip outer quotes.
  return headerRaw.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

function parseSelectorName(selector: string): string | null {
  // Selector forms: "name@npm:^1.0.0", "@scope/name@npm:^1.0.0", or v1 "name@^1.0.0"
  const i = selector.lastIndexOf('@npm:');
  if (i > 0) return selector.slice(0, i);
  // v1 fallback: split at last '@' that isn't position 0
  const at = selector.lastIndexOf('@');
  if (at > 0) return selector.slice(0, at);
  return null;
}
