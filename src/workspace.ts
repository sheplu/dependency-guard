import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { glob } from 'node:fs/promises';

import type { DependencyType, SkippedDependency } from './types.ts';
import type { DependencyEntry } from './package-json.ts';

export interface WorkspaceRoot {
  rootDir: string;
  type: 'pnpm' | 'npm';
}

interface WorkspacePackageInfo {
  version: string;
  isPrivate: boolean;
}

/**
 * Walk up from `startDir` looking for a workspace root.
 * Checks for pnpm-workspace.yaml first, then package.json with a `workspaces`
 * array. Returns null if nothing is found within `maxDepth` parent directories.
 */
export async function findWorkspaceRoot(
  startDir: string,
  maxDepth = 10,
): Promise<WorkspaceRoot | null> {
  let dir = startDir;
  for (let depth = 0; depth <= maxDepth; depth++) {
    // pnpm workspace
    try {
      await readFile(join(dir, 'pnpm-workspace.yaml'));
      return { rootDir: dir, type: 'pnpm' };
    } catch {
      // not found here
    }

    // npm / yarn workspace (package.json with workspaces array)
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { workspaces?: unknown };
      if (Array.isArray(pkg.workspaces)) {
        return { rootDir: dir, type: 'npm' };
      }
    } catch {
      // not found or unparseable
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Read the workspace member glob patterns from the workspace config file.
 */
export async function parseWorkspacePackages(
  rootDir: string,
  type: 'pnpm' | 'npm',
): Promise<string[]> {
  if (type === 'pnpm') {
    return parsePnpmPackages(join(rootDir, 'pnpm-workspace.yaml'));
  }
  return parseNpmWorkspaces(join(rootDir, 'package.json'));
}

/**
 * Parse the `packages:` list from pnpm-workspace.yaml using a simple
 * line-by-line reader (no external YAML library).
 */
async function parsePnpmPackages(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const patterns: string[] = [];
  let inPackages = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimStart();

    // Top-level key detection — a line with no leading whitespace and ending
    // with `:` (with optional trailing whitespace/comment).
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      inPackages = /^packages\s*:/.test(trimmed);
      continue;
    }

    if (!inPackages) continue;
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // List item: `- 'packages/*'` or `- packages/*`
    const match = trimmed.match(/^-\s+(['"]?)(.+?)\1\s*(?:#.*)?$/);
    if (match) {
      patterns.push(match[2]);
    }
  }

  return patterns;
}

/**
 * Read the `workspaces` array from a root package.json.
 */
async function parseNpmWorkspaces(pkgJsonPath: string): Promise<string[]> {
  try {
    const raw = await readFile(pkgJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { workspaces?: unknown };
    if (Array.isArray(pkg.workspaces)) {
      return pkg.workspaces.filter((p): p is string => typeof p === 'string');
    }
  } catch {
    // unreadable
  }
  return [];
}

/**
 * Read version and private flag from a package installed in node_modules.
 * In a workspace, the node_modules entry is typically a symlink to the
 * actual workspace package, so this follows it transparently.
 */
export async function readWorkspacePackageInfo(
  projectDir: string,
  pkgName: string,
): Promise<WorkspacePackageInfo | null> {
  const file = join(projectDir, 'node_modules', pkgName, 'package.json');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as {
      version?: string;
      private?: boolean;
    };
    if (!parsed.version) return null;
    return {
      version: parsed.version,
      isPrivate: parsed.private === true,
    };
  } catch {
    return null;
  }
}

/**
 * Glob-based fallback: expand workspace patterns from the root, read each
 * matched package.json, and return the info for the package whose `name`
 * matches `targetName`.
 */
async function discoverWorkspacePackage(
  rootDir: string,
  patterns: string[],
  targetName: string,
): Promise<WorkspacePackageInfo | null> {
  for (const pattern of patterns) {
    // Skip negation patterns (pnpm `!packages/foo`).
    if (pattern.startsWith('!')) continue;

    const pkgJsonPattern = `${pattern}/package.json`;
    for await (const entry of glob(pkgJsonPattern, { cwd: rootDir })) {
      const filePath = join(rootDir, entry);
      try {
        const raw = await readFile(filePath, 'utf8');
        const pkg = JSON.parse(raw) as {
          name?: string;
          version?: string;
          private?: boolean;
        };
        if (pkg.name === targetName && pkg.version) {
          return {
            version: pkg.version,
            isPrivate: pkg.private === true,
          };
        }
      } catch {
        // skip unreadable package.json
      }
    }
  }
  return null;
}

interface WorkspaceSpec {
  name: string;
  type: DependencyType;
  spec: string;
}

interface ResolvedWorkspaceSpecs {
  entries: DependencyEntry[];
  skipped: SkippedDependency[];
}

/**
 * Resolve workspace: specs to concrete versions by reading the referenced
 * package's own package.json. Private packages are surfaced as skipped
 * with reason `workspace-private`.
 */
export async function resolveWorkspaceSpecs(
  specs: WorkspaceSpec[],
  projectDir: string,
  maxDepth?: number,
): Promise<ResolvedWorkspaceSpecs> {
  const entries: DependencyEntry[] = [];
  const skipped: SkippedDependency[] = [];

  if (specs.length === 0) return { entries, skipped };

  const root = await findWorkspaceRoot(projectDir, maxDepth);
  if (!root) {
    // No workspace root found — skip all with the generic reason.
    for (const spec of specs) {
      skipped.push({
        name: spec.name,
        type: spec.type,
        reason: 'override-descriptor',
      });
    }
    return { entries, skipped };
  }

  // Pre-load workspace patterns for the glob fallback.
  let patterns: string[] | null = null;

  for (const spec of specs) {
    // Try the symlink approach first (node_modules/<name>/package.json).
    let info = await readWorkspacePackageInfo(projectDir, spec.name);

    // If not found in the project's node_modules, try the workspace root.
    if (!info && root.rootDir !== projectDir) {
      info = await readWorkspacePackageInfo(root.rootDir, spec.name);
    }

    // Glob fallback: discover the package by walking workspace patterns.
    if (!info) {
      if (patterns === null) {
        patterns = await parseWorkspacePackages(root.rootDir, root.type);
      }
      info = await discoverWorkspacePackage(root.rootDir, patterns, spec.name);
    }

    if (!info) {
      skipped.push({
        name: spec.name,
        type: spec.type,
        reason: 'override-descriptor',
      });
      continue;
    }

    if (info.isPrivate) {
      skipped.push({
        name: spec.name,
        type: spec.type,
        reason: 'workspace-private',
      });
      continue;
    }

    entries.push({
      name: spec.name,
      type: spec.type,
      spec: spec.spec,
      installedVersion: info.version,
      transitive: false,
    });
  }

  return { entries, skipped };
}
