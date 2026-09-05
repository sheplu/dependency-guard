import { dirname } from 'node:path';
import { analyzeDependency, summarize, type Cooldown } from './analyzer.ts';
import { collectCatalogEntries, findWorkspaceFile } from './catalog.ts';
import { Cache } from './cache.ts';
import { expandWithLockfile } from './lockfile.ts';
import { TYPE_ORDER, collectDependencies, type DependencyEntry } from './package-json.ts';
import { RegistryClient, RegistryHttpError } from './registry.ts';
import { isExcluded, resolveReleaseAgeConfig, type ReleaseAgeConfig } from './release-age.ts';
import { resolveWorkspaceSpecs } from './workspace.ts';
import type {
  AnalysisReport,
  CliOptions,
  DependencyAnalysis,
  DependencyType,
  ReleaseAgeInfo,
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
  /** Override release-age resolution (tests). null disables; undefined auto-detects. */
  releaseAgeConfig?: ReleaseAgeConfig | null;
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

  // Resolve workspace: specs to local package versions.
  const { entries: wsEntries, skipped: wsSkipped } =
    await resolveWorkspaceSpecs(collected.workspaceSpecs, dirname(options.path));
  skipped.push(...wsSkipped);

  const onlySet = options.onlyNames.length > 0 ? new Set(options.onlyNames) : null;

  // Collect catalog entries from pnpm-workspace.yaml when --catalog is active.
  const catalogDirect: DependencyEntry[] = [];
  if (options.catalog) {
    const workspaceFile = await findWorkspaceFile(dirname(options.path));
    if (workspaceFile) {
      catalogDirect.push(...await collectCatalogEntries(workspaceFile, dirname(options.path)));
    }
  }

  // Merge regular, workspace, and catalog entries, preserving TYPE_ORDER sort.
  const allDirect = [...collected.entries, ...wsEntries, ...catalogDirect].toSorted((a, b) => {
    const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return typeDiff !== 0 ? typeDiff : a.name.localeCompare(b.name);
  });

  // Step 1: filter direct deps by --ignore-scope and --only.
  const directKept: DependencyEntry[] = [];
  for (const entry of allDirect) {
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

  // Resolve the minimum-release-age cooldown once, unless disabled via --no-release-age.
  let releaseAgeConfig: ReleaseAgeConfig | null = null;
  if (options.releaseAge) {
    releaseAgeConfig =
      deps.releaseAgeConfig !== undefined
        ? deps.releaseAgeConfig
        : (await resolveReleaseAgeConfig(dirname(options.path))).config;
  }

  const analyses: DependencyAnalysis[] = [];
  for (const entry of kept) {
    try {
      const meta = await registry.getPackage(entry.name);
      const cooldown: Cooldown | null = releaseAgeConfig
        ? {
            days: releaseAgeConfig.days,
            excluded: isExcluded(entry.name, releaseAgeConfig.exclude),
          }
        : null;
      analyses.push(analyzeDependency({ entry, metadata: meta, now: deps.now, cooldown }));
    } catch (err) {
      if (
        err instanceof RegistryHttpError &&
        (err.status === 404 || err.status === 401 || err.status === 403)
      ) {
        skipped.push({
          name: entry.name,
          type: entry.type,
          reason: err.status === 404 ? 'registry-not-found' : 'registry-unauthorized',
          status: err.status,
        });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to analyze ${entry.name}: ${message}`, { cause: err });
    }
  }

  const dependencies = options.sortBy !== null ? sortAnalyses(analyses, options.sortBy) : analyses;
  const releaseAge: ReleaseAgeInfo | null = releaseAgeConfig
    ? {
        days: releaseAgeConfig.days,
        source: releaseAgeConfig.source,
        file: releaseAgeConfig.file,
        exclude: releaseAgeConfig.exclude,
      }
    : null;
  return { summary: summarize(analyses), dependencies, skipped, releaseAge };
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
