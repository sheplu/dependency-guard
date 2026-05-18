import type { AnalysisReport, FailOnLevel, UpdateType } from './types.ts';

export interface PolicyOptions {
  failOnLevel: FailOnLevel | null;
  maxAgeDays: number | null;
}

export interface PolicyResult {
  passed: boolean;
  reasons: string[];
}

export function evaluatePolicy(
  report: AnalysisReport,
  options: PolicyOptions,
): PolicyResult {
  const reasons: string[] = [];

  if (options.failOnLevel !== null) {
    if (options.failOnLevel === 'deprecated') {
      const offenders = report.dependencies.filter((d) => d.deprecated !== null);
      if (offenders.length > 0) {
        const names = offenders.map((d) => `${d.name}@${d.current.version}`).join(', ');
        reasons.push(
          `--fail-on deprecated: ${offenders.length} installed version${offenders.length === 1 ? ' is' : 's are'} deprecated (${names})`,
        );
      }
    } else {
      const offenders = report.dependencies.filter((d) =>
        violatesLevel(d.updateType, options.failOnLevel as Exclude<FailOnLevel, 'deprecated'>),
      );
      if (offenders.length > 0) {
        const names = offenders.map((d) => `${d.name}@${d.current.version}`).join(', ');
        reasons.push(
          `--fail-on ${options.failOnLevel}: ${offenders.length} dependenc${offenders.length === 1 ? 'y' : 'ies'} need upgrade (${names})`,
        );
      }
    }
  }

  if (options.maxAgeDays !== null) {
    const tooOld = report.dependencies.filter(
      (d) => d.ageInDays !== null && d.ageInDays > options.maxAgeDays!,
    );
    if (tooOld.length > 0) {
      const names = tooOld.map((d) => `${d.name} (${d.ageInDays}d)`).join(', ');
      reasons.push(
        `--max-age ${options.maxAgeDays}: ${tooOld.length} dependenc${tooOld.length === 1 ? 'y is' : 'ies are'} older than ${options.maxAgeDays} days (${names})`,
      );
    }
  }

  return { passed: reasons.length === 0, reasons };
}

function violatesLevel(updateType: UpdateType, level: Exclude<FailOnLevel, 'deprecated'>): boolean {
  if (level === 'major') return updateType === 'major';
  // 'minor' and 'any' both fail on anything that isn't up-to-date
  return updateType === 'major' || updateType === 'minor';
}
