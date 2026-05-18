import { analyzeDependency, summarize } from './analyzer.ts';
import { Cache } from './cache.ts';
import { collectDependencies } from './package-json.ts';
import { RegistryClient } from './registry.ts';
import type {
  AnalysisReport,
  CliOptions,
  DependencyAnalysis,
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
  const cache = deps.cache ?? new Cache({ enabled: options.cache });
  const registry = deps.registry ?? new RegistryClient({ cache });

  const entries = await collectDependencies(options.path, {
    prod: options.prod,
    dev: options.dev,
    peer: options.peer,
    optional: options.optional,
  });

  const analyses: DependencyAnalysis[] = [];
  for (const entry of entries) {
    try {
      const meta = await registry.getPackage(entry.name);
      analyses.push(analyzeDependency({ entry, metadata: meta, now: deps.now }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to analyze ${entry.name}: ${message}`, { cause: err });
    }
  }

  return { summary: summarize(analyses), dependencies: analyses };
}
