import { ageInDays } from './age.ts';
import { compare, isStable, maxVersion, parse } from './semver.ts';
import type { ParsedVersion } from './semver.ts';
import type {
  AnalysisSummary,
  DependencyAnalysis,
  RegistryPackageMetadata,
  UpdateType,
  VersionInfo,
} from './types.ts';
import type { DependencyEntry } from './package-json.ts';

export interface AnalyzeArgs {
  entry: DependencyEntry;
  metadata: RegistryPackageMetadata;
  now?: Date;
}

export function analyzeDependency({ entry, metadata, now }: AnalyzeArgs): DependencyAnalysis {
  const stableVersions = metadata.versions
    .map((v) => parse(v))
    .filter((v): v is ParsedVersion => v !== null && isStable(v));

  const current = parse(entry.installedVersion ?? '') ?? parse('0.0.0')!;

  const latestMajorVersion = maxVersion(stableVersions);
  if (!latestMajorVersion) {
    const currentAge = ageInDays(metadata.time[current.raw] ?? null, now);
    return {
      name: entry.name,
      type: entry.type,
      current: toVersionInfo(current.raw, metadata),
      latestMinor: null,
      latestMajor: null,
      ageInDays: currentAge,
      latestAgeInDays: currentAge,
      updateType: 'up-to-date',
    };
  }

  const sameMajor = stableVersions.filter((v) => v.major === current.major);
  const latestMinorVersion = maxVersion(sameMajor);

  const hasNewerMinor = latestMinorVersion !== null && compare(latestMinorVersion, current) > 0;
  const hasNewerMajor = latestMajorVersion.major > current.major;
  const updateType: UpdateType = hasNewerMajor ? 'major' : hasNewerMinor ? 'minor' : 'up-to-date';

  return {
    name: entry.name,
    type: entry.type,
    current: toVersionInfo(current.raw, metadata),
    latestMinor: hasNewerMinor ? toVersionInfo(latestMinorVersion!.raw, metadata) : null,
    latestMajor: hasNewerMajor ? toVersionInfo(latestMajorVersion.raw, metadata) : null,
    ageInDays: ageInDays(metadata.time[current.raw] ?? null, now),
    latestAgeInDays: ageInDays(metadata.time[latestMajorVersion.raw] ?? null, now),
    updateType,
  };
}

function toVersionInfo(version: string, metadata: RegistryPackageMetadata): VersionInfo {
  return { version, publishedAt: metadata.time[version] ?? null };
}

export function summarize(analyses: ReadonlyArray<DependencyAnalysis>): AnalysisSummary {
  const summary: AnalysisSummary = {
    total: analyses.length,
    upToDate: 0,
    minorUpdates: 0,
    majorUpdates: 0,
  };
  for (const a of analyses) {
    if (a.updateType === 'up-to-date') summary.upToDate++;
    else if (a.updateType === 'minor') summary.minorUpdates++;
    else if (a.updateType === 'major') summary.majorUpdates++;
  }
  return summary;
}
