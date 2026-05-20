import { dirname } from 'node:path';
import { analyzeDependency, summarize } from './analyzer.ts';
import { Cache } from './cache.ts';
import { expandWithLockfile } from './lockfile.ts';
import { collectDependencies, type DependencyEntry } from './package-json.ts';
import { RegistryClient } from './registry.ts';
import type {
  AnalysisReport,
  CliOptions,
  DependencyAnalysis,
  DependencyType,
  SkippedDependency,
  SortField,
  UpdateType,
} from './types.ts';

export function isOverrideType(t: DependencyType): boolean {
  return t === 'overrides' || t === 'resolutions' || t === 'pnpm.overrides';
}

export interface AnalyzeRunDeps {
  registry?: RegistryClient;
  cache?: Cache;
  now?: Date;
}

export async function runAnalysis(
  options: CliOptions,
  deps: AnalyzeRunDeps = {},
): Promise<AnalysisReport> {
  const cache = deps.cache ?? new Cache({
    enabled: options.cache,
    ttlMs: options.cacheTtlMinutes * 60_000,
  });
  const registry =
    deps.registry ??
    new RegistryClient({ cache, baseUrl: options.registryUrl ?? undefined });

  const collected = await collectDependencies(options.path, {
    prod: options.prod,
    dev: options.dev,
    peer: options.peer,
    optional: options.optional,
    overrides: options.overrides,
    resolutions: options.resolutions,
    pnpmOverrides: options.pnpmOverrides,
  });

  const skipped: SkippedDependency[] = collected.skipped.map((s) => ({
    name: s.name,
    type: s.type,
    reason: s.reason,
  }));
  const onlySet = options.onlyNames.length > 0 ? new Set(options.onlyNames) : null;

  // Step 1: filter direct deps by --ignore-scope and --only.
  const directKept: DependencyEntry[] = [];
  for (const entry of collected.entries) {
    const matched = matchScope(entry.name, options.ignoredScopes);
    if (matched !== null) {
      skipped.push({ name: entry.name, type: entry.type, reason: 'ignored-scope', scope: matched });
    } else if (onlySet !== null && !onlySet.has(entry.name)) {
      // dropped by --only; not surfaced in report
    } else {
      directKept.push(entry);
    }
  }

  // Step 2: expand transitives (if requested) — but never traverse from any pin
  // type (npm overrides, yarn resolutions, pnpm.overrides), since they're
  // declarations rather than resolution roots. Re-apply --ignore-scope afterwards
  // so transitives picked up from a denied scope are filtered.
  const overrideEntries = directKept.filter((e) => isOverrideType(e.type));
  const lockRoots = directKept.filter((e) => !isOverrideType(e.type));
  const expanded = options.includeTransitive
    ? [
        ...(await expandWithLockfile(lockRoots, dirname(options.path))),
        ...overrideEntries,
      ]
    : directKept;

  const kept: DependencyEntry[] = [];
  for (const entry of expanded) {
    if (!entry.transitive) {
      kept.push(entry);
      continue;
    }
    const matched = matchScope(entry.name, options.ignoredScopes);
    if (matched !== null) {
      skipped.push({ name: entry.name, type: entry.type, reason: 'ignored-scope', scope: matched });
    } else {
      kept.push(entry);
    }
  }

  const analyses: DependencyAnalysis[] = [];
  for (const entry of kept) {
    try {
      const meta = await registry.getPackage(entry.name);
      analyses.push(analyzeDependency({ entry, metadata: meta, now: deps.now }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to analyze ${entry.name}: ${message}`, { cause: err });
    }
  }

  const dependencies = options.sortBy !== null ? sortAnalyses(analyses, options.sortBy) : analyses;
  return { summary: summarize(analyses), dependencies, skipped };
}

function matchScope(name: string, ignored: ReadonlyArray<string>): string | null {
  for (const scope of ignored) {
    if (name.startsWith(scope + '/')) return scope;
  }
  return null;
}

const STATUS_ORDER: Record<UpdateType, number> = {
  major: 0,
  minor: 1,
  patch: 2,
  'up-to-date': 3,
};

function sortAnalyses(deps: DependencyAnalysis[], field: SortField): DependencyAnalysis[] {
  const sorted = [...deps];
  sorted.sort((a, b) => {
    const primary = compareBy(a, b, field);
    return primary !== 0 ? primary : a.name.localeCompare(b.name);
  });
  return sorted;
}

function compareBy(a: DependencyAnalysis, b: DependencyAnalysis, field: SortField): number {
  if (field === 'name') return 0;
  if (field === 'status') return STATUS_ORDER[a.updateType] - STATUS_ORDER[b.updateType];
  // 'age': oldest first; null sorts to bottom
  const aAge = a.ageInDays;
  const bAge = b.ageInDays;
  if (aAge === null && bAge === null) return 0;
  if (aAge === null) return 1;
  if (bAge === null) return -1;
  return bAge - aAge;
}
