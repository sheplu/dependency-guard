import { formatAge } from '../age.ts';
import type { AnalysisReport, DependencyAnalysis } from '../types.ts';
import { typeShort, statusLabel } from './shared.ts';

/** Marker shown next to a version held back by the minimum-release-age cooldown. */
const HELD_BACK_GLYPH = '⏳';

type Tier = 'patch' | 'minor' | 'major';

export interface FormatMarkdownOptions {
  quiet?: boolean;
  showTrueLatest?: boolean;
}

export function formatMarkdown(report: AnalysisReport, opts: FormatMarkdownOptions = {}): string {
  const showTrueLatest = opts.showTrueLatest ?? false;
  const lines: string[] = [];
  if (!opts.quiet) {
    lines.push('## Dependency Report', '');
    lines.push(`- Total: ${report.summary.total}`);
    lines.push(`- Up to date: ${report.summary.upToDate}`);
    lines.push(`- Patch updates: ${report.summary.patchUpdates}`);
    lines.push(`- Minor updates: ${report.summary.minorUpdates}`);
    lines.push(`- Major updates: ${report.summary.majorUpdates}`);
    lines.push('');
  }
  lines.push('| Package | Type | Current | Patch | Minor | Major | Age | Latest Age | Status |');
  lines.push('|---------|------|---------|-------|-------|-------|-----|------------|--------|');
  for (const dep of report.dependencies) {
    lines.push(`| ${row(dep, showTrueLatest)} |`);
  }
  if (report.releaseAge !== null) {
    const held = report.dependencies.filter((d) => d.heldBack !== null);
    lines.push('');
    const window = report.releaseAge.days === 1 ? '1 day' : `${report.releaseAge.days} days`;
    lines.push(`> Minimum release age: ${window} (from ${report.releaseAge.source} config). ${HELD_BACK_GLYPH} marks ${held.length} version(s) held back by the cooldown.`);
  }
  return lines.join('\n');
}

function tierValue(
  dep: DependencyAnalysis,
  tier: Tier,
  eligible: string | null,
  showTrueLatest: boolean,
): string {
  const held = dep.heldBack !== null ? dep.heldBack[tier] : null;
  if (eligible !== null) return held ? `${eligible} ${HELD_BACK_GLYPH}` : eligible;
  if (held && showTrueLatest) return `${held.version} ${HELD_BACK_GLYPH}`;
  if (held) return HELD_BACK_GLYPH;
  return '-';
}

function row(dep: DependencyAnalysis, showTrueLatest: boolean): string {
  let name = dep.transitive ? `↳ ${dep.name}` : dep.name;
  if (dep.deprecated !== null) name = `${name} ⚠`;
  return [
    name,
    typeShort(dep.type),
    dep.current.version,
    tierValue(dep, 'patch', dep.latestPatch?.version ?? null, showTrueLatest),
    tierValue(dep, 'minor', dep.latestMinor?.version ?? null, showTrueLatest),
    tierValue(dep, 'major', dep.latestMajor?.version ?? null, showTrueLatest),
    formatAge(dep.ageInDays),
    formatAge(dep.latestAgeInDays),
    statusLabel(dep.updateType),
  ].join(' | ');
}
