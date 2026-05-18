import { analyzeDependency, summarize } from './analyzer.ts';
import { Cache } from './cache.ts';
import { collectDependencies, type DependencyEntry } from './package-json.ts';
import { RegistryClient } from './registry.ts';
import type {
  AnalysisReport,
  CliOptions,
  DependencyAnalysis,
  SkippedDependency,
  SortField,
  UpdateType,
} from './types.ts';

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

  const entries = await collectDependencies(options.path, {
    prod: options.prod,
    dev: options.dev,
    peer: options.peer,
    optional: options.optional,
  });

  const skipped: SkippedDependency[] = [];
  const kept: DependencyEntry[] = [];
  const onlySet = options.onlyNames.length > 0 ? new Set(options.onlyNames) : null;
  for (const entry of entries) {
    const matched = matchScope(entry.name, options.ignoredScopes);
    if (matched !== null) {
      skipped.push({ name: entry.name, type: entry.type, scope: matched });
    } else if (onlySet !== null && !onlySet.has(entry.name)) {
      // dropped by --only; not surfaced in report
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
  'up-to-date': 2,
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
