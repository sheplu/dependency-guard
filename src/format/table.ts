import { formatAge } from '../age.ts';
import type { AnalysisReport, DependencyAnalysis, UpdateType } from '../types.ts';
import { ANSI, type AnsiColor, colorize, statusLabel, typeShort } from './shared.ts';

interface Column {
  header: string;
  optional: boolean;
  hasValue?: (dep: DependencyAnalysis) => boolean;
  cell: (dep: DependencyAnalysis, useColor: boolean) => string;
}

const ALL_COLUMNS: Column[] = [
  { header: 'Package',    optional: false, cell: packageCell },
  { header: 'Type',       optional: false, cell: (d) => typeShort(d.type) },
  { header: 'Current',    optional: false, cell: (d) => d.current.version },
  {
    header: 'Patch',
    optional: true,
    hasValue: (d) => d.latestPatch !== null,
    cell: (d) => d.latestPatch?.version ?? '-',
  },
  {
    header: 'Minor',
    optional: true,
    hasValue: (d) => d.latestMinor !== null,
    cell: (d) => d.latestMinor?.version ?? '-',
  },
  {
    header: 'Major',
    optional: true,
    hasValue: (d) => d.latestMajor !== null,
    cell: (d) => d.latestMajor?.version ?? '-',
  },
  { header: 'Age',        optional: false, cell: (d) => formatAge(d.ageInDays) },
  { header: 'Latest Age', optional: false, cell: (d) => formatAge(d.latestAgeInDays) },
  { header: 'Status',     optional: false, cell: (d) => statusLabel(d.updateType) },
];

export interface FormatTableOptions {
  color?: boolean;
  quiet?: boolean;
  allColumns?: boolean;
}

export function formatTable(report: AnalysisReport, opts: FormatTableOptions = {}): string {
  const useColor = opts.color ?? Boolean(process.stdout.isTTY);
  const columns = selectColumns(report, opts.allColumns ?? false);

  const headers = columns.map((c) => c.header);
  const rows = report.dependencies.map((d) => columns.map((c) => c.cell(d, useColor)));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => visualLength(r[i]))),
  );

  const lines: string[] = [];
  if (!opts.quiet) {
    lines.push('Summary:');
    lines.push(`  Total: ${report.summary.total}`);
    lines.push(`  ${colorize('✓ Up to date', 'green', useColor)}: ${report.summary.upToDate}`);
    lines.push(`  ${colorize('△ Patch updates', 'green', useColor)}: ${report.summary.patchUpdates}`);
    lines.push(`  ${colorize('↑ Minor updates', 'yellow', useColor)}: ${report.summary.minorUpdates}`);
    lines.push(`  ${colorize('⬆ Major updates', 'red', useColor)}: ${report.summary.majorUpdates}`);
    lines.push('');
  }

  lines.push(border(widths, '┌', '┬', '┐'));
  lines.push(rowLine(headers, widths));
  lines.push(border(widths, '├', '┼', '┤'));
  for (let i = 0; i < rows.length; i++) {
    const updateType = report.dependencies[i].updateType;
    lines.push(rowLine(rows[i], widths, useColor ? statusColor(updateType) : null));
  }
  lines.push(border(widths, '└', '┴', '┘'));

  return lines.join('\n');
}

function selectColumns(report: AnalysisReport, allColumns: boolean): Column[] {
  if (allColumns) return ALL_COLUMNS;
  return ALL_COLUMNS.filter(
    (c) => !c.optional || report.dependencies.some((d) => c.hasValue!(d)),
  );
}

function packageCell(dep: DependencyAnalysis, useColor: boolean): string {
  let name = dep.transitive ? `↳ ${dep.name}` : dep.name;
  if (dep.deprecated !== null) {
    name = `${name} ${colorize('⚠', 'yellow', useColor)}`;
  }
  return name;
}

function statusColor(updateType: UpdateType): AnsiColor {
  if (updateType === 'major') return 'red';
  if (updateType === 'minor') return 'yellow';
  return 'green';
}

function rowLine(cells: string[], widths: number[], statusName: AnsiColor | null = null): string {
  const padded = cells.map((c, i) => ' ' + pad(c, widths[i]) + ' ');
  if (statusName) {
    padded[padded.length - 1] = ' ' + colorPad(cells[cells.length - 1], widths[widths.length - 1], statusName) + ' ';
  }
  return '│' + padded.join('│') + '│';
}

function colorPad(text: string, width: number, name: AnsiColor): string {
  return ANSI[name] + pad(text, width) + ANSI.reset;
}

function pad(text: string, width: number): string {
  const len = visualLength(text);
  return text + ' '.repeat(Math.max(0, width - len));
}

function visualLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function border(widths: number[], left: string, mid: string, right: string): string {
  const segments = widths.map((w) => '─'.repeat(w + 2));
  return left + segments.join(mid) + right;
}
