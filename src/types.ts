export type DependencyType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies'
  | 'overrides'
  | 'resolutions'
  | 'pnpm.overrides';

export type SkippedReason =
  | 'ignored-scope'
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
}

export interface RegistryPackageMetadata {
  name: string;
  versions: string[];
  time: Record<string, string>;
  deprecations: Record<string, string>;
}
