export type DependencyType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export type UpdateType = 'up-to-date' | 'minor' | 'major';

export type OutputFormat = 'table' | 'json' | 'markdown';

export type FailOnLevel = 'major' | 'minor' | 'any';

export type SortField = 'age' | 'status' | 'name';

export interface VersionInfo {
  version: string;
  publishedAt: string | null;
}

export interface DependencyAnalysis {
  name: string;
  type: DependencyType;
  current: VersionInfo;
  latestMinor: VersionInfo | null;
  latestMajor: VersionInfo | null;
  ageInDays: number | null;
  latestAgeInDays: number | null;
  updateType: UpdateType;
}

export interface AnalysisSummary {
  total: number;
  upToDate: number;
  minorUpdates: number;
  majorUpdates: number;
}

export interface SkippedDependency {
  name: string;
  type: DependencyType;
  scope: string;
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
  cache: boolean;
  cacheTtlMinutes: number;
  ignoredScopes: string[];
  quiet: boolean;
  failOnLevel: FailOnLevel | null;
  maxAgeDays: number | null;
  sortBy: SortField | null;
}

export interface RegistryPackageMetadata {
  name: string;
  versions: string[];
  time: Record<string, string>;
}
