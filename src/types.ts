export type DependencyType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies'
  | 'overrides'
  | 'resolutions'
  | 'pnpm.overrides'
  | 'catalog';

export type SkippedReason =
  | 'ignored-scope'
  | 'catalog'
  | 'override-path-specific'
  | 'override-reference'
  | 'override-removal'
  | 'override-descriptor'
  | 'registry-not-found'
  | 'registry-unauthorized';

export type UpdateType = 'up-to-date' | 'patch' | 'minor' | 'major';

export type OutputFormat = 'table' | 'json' | 'markdown';

export type FailOnLevel = 'major' | 'minor' | 'patch' | 'any' | 'deprecated';

export type SortField = 'age' | 'status' | 'name';

export type UpdateLevel = 'patch' | 'minor' | 'major' | 'all';

export interface VersionInfo {
  version: string;
  publishedAt: string | null;
}

export interface DependencyAnalysis {
  name: string;
  type: DependencyType;
  current: VersionInfo;
  latestPatch: VersionInfo | null;
  latestMinor: VersionInfo | null;
  latestMajor: VersionInfo | null;
  ageInDays: number | null;
  latestAgeInDays: number | null;
  updateType: UpdateType;
  deprecated: string | null;
  transitive: boolean;
  /**
   * Per-tier versions withheld because they are younger than the configured
   * minimum release age (cooldown). A tier is populated when a newer version
   * exists for it but was suppressed in favor of an older eligible one (or no
   * eligible upgrade at all). null when no cooldown applies, the package is
   * excluded, or nothing is held back.
   */
  heldBack: HeldBackInfo | null;
}

export interface HeldBackVersion {
  version: string;
  publishedAt: string | null;
  ageInDays: number | null;
}

export interface HeldBackInfo {
  patch: HeldBackVersion | null;
  minor: HeldBackVersion | null;
  major: HeldBackVersion | null;
}

export interface AnalysisSummary {
  total: number;
  upToDate: number;
  patchUpdates: number;
  minorUpdates: number;
  majorUpdates: number;
}

export interface SkippedDependency {
  name: string;
  type: DependencyType;
  reason: SkippedReason;
  scope?: string;
  status?: number;
}

export interface AnalysisReport {
  summary: AnalysisSummary;
  dependencies: DependencyAnalysis[];
  skipped: SkippedDependency[];
  /** Active minimum-release-age cooldown, if one was resolved from config. */
  releaseAge: ReleaseAgeInfo | null;
}

export interface ReleaseAgeInfo {
  days: number;
  source: 'npm' | 'pnpm' | 'yarn';
  file: string;
  exclude: string[];
}

export interface CliOptions {
  path: string;
  format: OutputFormat;
  prod: boolean;
  dev: boolean;
  peer: boolean;
  optional: boolean;
  overrides: boolean;
  resolutions: boolean;
  pnpmOverrides: boolean;
  catalog?: boolean;
  cache: boolean;
  cacheTtlMinutes: number;
  ignoredScopes: string[];
  onlyNames: string[];
  quiet: boolean;
  failOnLevel: FailOnLevel | null;
  maxAgeDays: number | null;
  sortBy: SortField | null;
  registryUrl: string | null;
  includeTransitive: boolean;
  updateLevel: UpdateLevel | null;
  dryRun: boolean;
  allColumns: boolean;
  /**
   * Honor the minimum-release-age cooldown discovered from package-manager
   * config (default true). When false, --no-release-age was passed.
   */
  releaseAge: boolean;
  /**
   * Show the true latest versions even when held back by the cooldown
   * (--show-true-latest). Affects display only, not the chosen update target.
   */
  showTrueLatest: boolean;
}

export interface RegistryPackageMetadata {
  name: string;
  versions: string[];
  time: Record<string, string>;
  deprecations: Record<string, string>;
}
