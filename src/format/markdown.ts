import { formatAge } from '../age.ts';
import type { AnalysisReport, DependencyAnalysis } from '../types.ts';
import { typeShort, statusLabel } from './shared.ts';

export interface FormatMarkdownOptions {
  quiet?: boolean;
}

export function formatMarkdown(report: AnalysisReport, opts: FormatMarkdownOptions = {}): string {
  const lines: string[] = [];
  if (!opts.quiet) {
    lines.push('## Dependency Report', '');
    lines.push(`- Total: ${report.summary.total}`);
    lines.push(`- Up to date: ${report.summary.upToDate}`);
    lines.push(`- Minor updates: ${report.summary.minorUpdates}`);
    lines.push(`- Major updates: ${report.summary.majorUpdates}`);
    lines.push('');
  }
  lines.push('| Package | Type | Current | Minor | Major | Age | Latest Age | Status |');
  lines.push('|---------|------|---------|-------|-------|-----|------------|--------|');
  for (const dep of report.dependencies) {
    lines.push(`| ${row(dep)} |`);
  }
  return lines.join('\n');
}

function row(dep: DependencyAnalysis): string {
  let name = dep.transitive ? `↳ ${dep.name}` : dep.name;
  if (dep.deprecated !== null) name = `${name} ⚠`;
  return [
    name,
    typeShort(dep.type),
    dep.current.version,
    dep.latestMinor?.version ?? '-',
    dep.latestMajor?.version ?? '-',
    formatAge(dep.ageInDays),
    formatAge(dep.latestAgeInDays),
    statusLabel(dep.updateType),
  ].join(' | ');
}
