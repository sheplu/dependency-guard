import { analyzeDependency, summarize } from './analyzer.ts';
import { Cache } from './cache.ts';
import { collectDependencies, type DependencyEntry } from './package-json.ts';
import { RegistryClient } from './registry.ts';
import type {
  AnalysisReport,
  CliOptions,
  DependencyAnalysis,
  SkippedDependency,
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
  const registry = deps.registry ?? new RegistryClient({ cache });

  const entries = await collectDependencies(options.path, {
    prod: options.prod,
    dev: options.dev,
    peer: options.peer,
    optional: options.optional,
  });

  const skipped: SkippedDependency[] = [];
  const kept: DependencyEntry[] = [];
  for (const entry of entries) {
    const matched = matchScope(entry.name, options.ignoredScopes);
    if (matched !== null) {
      skipped.push({ name: entry.name, type: entry.type, scope: matched });
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

  return { summary: summarize(analyses), dependencies: analyses, skipped };
}

function matchScope(name: string, ignored: ReadonlyArray<string>): string | null {
  for (const scope of ignored) {
    if (name.startsWith(scope + '/')) return scope;
  }
  return null;
}
