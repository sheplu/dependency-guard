import { ageInDays } from './age.ts';
import { compare, isStable, maxVersion, parse } from './semver.ts';
import type { ParsedVersion } from './semver.ts';
import type {
  AnalysisSummary,
  DependencyAnalysis,
  HeldBackInfo,
  HeldBackVersion,
  RegistryPackageMetadata,
  UpdateType,
  VersionInfo,
} from './types.ts';
import type { DependencyEntry } from './package-json.ts';

/**
 * Minimum-release-age cooldown applied while choosing candidate versions.
 * `days` is the window; `excluded` is true when this package is exempt (so the
 * cooldown is effectively disabled for it).
 */
export interface Cooldown {
  days: number;
  excluded: boolean;
}

export interface AnalyzeArgs {
  entry: DependencyEntry;
  metadata: RegistryPackageMetadata;
  now?: Date;
  cooldown?: Cooldown | null;
}

export function analyzeDependency({
  entry,
  metadata,
  now,
  cooldown,
}: AnalyzeArgs): DependencyAnalysis {
  const stableVersions = metadata.versions
    .map((v) => parse(v))
    .filter((v): v is ParsedVersion => v !== null && isStable(v));

  const current = parse(entry.installedVersion ?? '') ?? parse('0.0.0')!;
  const deprecated = metadata.deprecations[current.raw] ?? null;

  // A version is eligible unless a cooldown applies and it is younger than the
  // window. Excluded packages (or no cooldown) treat every version as eligible.
  const active = cooldown != null && !cooldown.excluded;
  const cooldownDays = active ? cooldown.days : 0;
  const ageOf = (v: ParsedVersion): number | null =>
    ageInDays(metadata.time[v.raw] ?? null, now);
  const isEligible = (v: ParsedVersion): boolean => {
    const age = ageOf(v);
    // Unknown publish time → treat as eligible (don't hide versions we can't date).
    return age === null || age >= cooldownDays;
  };

  const eligibleVersions = active ? stableVersions.filter(isEligible) : stableVersions;

  // Per-tier: the newest version that exists but was suppressed by the cooldown.
  const heldBack = active
    ? computeHeldBack(stableVersions, eligibleVersions, current, ageOf, metadata)
    : null;

  const base = {
    name: entry.name,
    type: entry.type,
    current: toVersionInfo(current.raw, metadata),
    deprecated,
    transitive: entry.transitive,
    heldBack,
  };

  const latestMajorVersion = maxVersion(eligibleVersions);
  if (!latestMajorVersion) {
    const currentAge = ageInDays(metadata.time[current.raw] ?? null, now);
    return {
      ...base,
      latestPatch: null,
      latestMinor: null,
      latestMajor: null,
      ageInDays: currentAge,
      latestAgeInDays: currentAge,
      updateType: 'up-to-date',
    };
  }

  const sameMajor = eligibleVersions.filter((v) => v.major === current.major);
  const samePatch = sameMajor.filter((v) => v.minor === current.minor);
  const latestMinorVersion = maxVersion(sameMajor);
  const latestPatchVersion = maxVersion(samePatch);

  const hasNewerPatch = latestPatchVersion !== null && compare(latestPatchVersion, current) > 0;
  const hasNewerMinor =
    latestMinorVersion !== null && latestMinorVersion.minor > current.minor;
  const hasNewerMajor = latestMajorVersion.major > current.major;
  const updateType: UpdateType = hasNewerMajor
    ? 'major'
    : hasNewerMinor
      ? 'minor'
      : hasNewerPatch
        ? 'patch'
        : 'up-to-date';

  return {
    ...base,
    latestPatch: hasNewerPatch ? toVersionInfo(latestPatchVersion!.raw, metadata) : null,
    latestMinor: hasNewerMinor ? toVersionInfo(latestMinorVersion!.raw, metadata) : null,
    latestMajor: hasNewerMajor ? toVersionInfo(latestMajorVersion.raw, metadata) : null,
    ageInDays: ageInDays(metadata.time[current.raw] ?? null, now),
    latestAgeInDays: ageInDays(metadata.time[latestMajorVersion.raw] ?? null, now),
    updateType,
  };
}

/**
 * For each tier (patch/minor/major), find the newest version the cooldown is
 * suppressing: the true latest in that tier is newer than the eligible latest
 * (or there is no eligible one), and is itself an upgrade over current. Returns
 * null when no tier has anything withheld.
 */
function computeHeldBack(
  stableVersions: ReadonlyArray<ParsedVersion>,
  eligibleVersions: ReadonlyArray<ParsedVersion>,
  current: ParsedVersion,
  ageOf: (v: ParsedVersion) => number | null,
  metadata: RegistryPackageMetadata,
): HeldBackInfo | null {
  // A held-back version is, by definition, ineligible — which means it has a
  // parseable (present) publish time. So time[v.raw] is always set here.
  const toHeld = (v: ParsedVersion): HeldBackVersion => ({
    version: v.raw,
    publishedAt: metadata.time[v.raw],
    ageInDays: ageOf(v),
  });

  // The true latest in a tier is "held back" when it's newer than what's
  // eligible in that tier and is a genuine upgrade over the installed version.
  const heldInTier = (
    trueMax: ParsedVersion | null,
    eligibleMax: ParsedVersion | null,
  ): HeldBackVersion | null => {
    if (!trueMax) return null;
    if (compare(trueMax, current) <= 0) return null;
    if (eligibleMax !== null && compare(trueMax, eligibleMax) <= 0) return null;
    return toHeld(trueMax);
  };

  const trueSameMajor = stableVersions.filter((v) => v.major === current.major);
  const truePatch = maxVersion(trueSameMajor.filter((v) => v.minor === current.minor));
  const trueMinor = maxVersion(trueSameMajor);
  const trueMajor = maxVersion(stableVersions);

  const eligSameMajor = eligibleVersions.filter((v) => v.major === current.major);
  const eligPatch = maxVersion(eligSameMajor.filter((v) => v.minor === current.minor));
  const eligMinor = maxVersion(eligSameMajor);
  const eligMajor = maxVersion(eligibleVersions);

  const patch = heldInTier(truePatch, eligPatch);
  // Only surface a held-back minor/major when it actually crosses the tier
  // boundary (a newer minor/major), matching how latestMinor/latestMajor are populated.
  const minor =
    trueMinor && trueMinor.minor > current.minor ? heldInTier(trueMinor, eligMinor) : null;
  const major =
    trueMajor && trueMajor.major > current.major ? heldInTier(trueMajor, eligMajor) : null;

  if (!patch && !minor && !major) return null;
  return { patch, minor, major };
}

function toVersionInfo(version: string, metadata: RegistryPackageMetadata): VersionInfo {
  return { version, publishedAt: metadata.time[version] ?? null };
}

export function summarize(analyses: ReadonlyArray<DependencyAnalysis>): AnalysisSummary {
  const summary: AnalysisSummary = {
    total: analyses.length,
    upToDate: 0,
    patchUpdates: 0,
    minorUpdates: 0,
    majorUpdates: 0,
  };
  for (const a of analyses) {
    if (a.updateType === 'up-to-date') summary.upToDate++;
    else if (a.updateType === 'patch') summary.patchUpdates++;
    else if (a.updateType === 'minor') summary.minorUpdates++;
    else if (a.updateType === 'major') summary.majorUpdates++;
  }
  return summary;
}
