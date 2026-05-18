import { formatAge } from '../age.ts';
import type { AnalysisReport, DependencyAnalysis, UpdateType } from '../types.ts';
import { statusLabel, typeShort } from './shared.ts';

const HEADERS = ['Package', 'Type', 'Current', 'Minor', 'Major', 'Age', 'Latest Age', 'Status'] as const;

const ESC = '\x1b';
const COLORS = {
  reset: `${ESC}[0m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  dim: `${ESC}[2m`,
} as const;

export interface FormatTableOptions {
  color?: boolean;
}

export function formatTable(report: AnalysisReport, opts: FormatTableOptions = {}): string {
  const useColor = opts.color ?? Boolean(process.stdout.isTTY);

  const rows = report.dependencies.map((d) => buildRow(d));
  const widths = HEADERS.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => visualLength(r[i]))),
  );

  const lines: string[] = [];
  lines.push('Summary:');
  lines.push(`  Total: ${report.summary.total}`);
  lines.push(`  ${color('✓ Up to date', 'green', useColor)}: ${report.summary.upToDate}`);
  lines.push(`  ${color('↑ Minor updates', 'yellow', useColor)}: ${report.summary.minorUpdates}`);
  lines.push(`  ${color('⬆ Major updates', 'red', useColor)}: ${report.summary.majorUpdates}`);
  lines.push('');

  lines.push(border(widths, '┌', '┬', '┐'));
  lines.push(rowLine(HEADERS as unknown as string[], widths));
  lines.push(border(widths, '├', '┼', '┤'));
  for (let i = 0; i < rows.length; i++) {
    const updateType = report.dependencies[i].updateType;
    lines.push(rowLine(rows[i], widths, useColor ? statusColor(updateType) : null));
  }
  lines.push(border(widths, '└', '┴', '┘'));

  return lines.join('\n');
}

function buildRow(dep: DependencyAnalysis): string[] {
  return [
    dep.name,
    typeShort(dep.type),
    dep.current.version,
    dep.latestMinor?.version ?? '-',
    dep.latestMajor?.version ?? '-',
    formatAge(dep.ageInDays),
    formatAge(dep.latestAgeInDays),
    statusLabel(dep.updateType),
  ];
}

function statusColor(updateType: UpdateType): keyof typeof COLORS {
  if (updateType === 'major') return 'red';
  if (updateType === 'minor') return 'yellow';
  return 'green';
}

function color(text: string, name: keyof typeof COLORS, on: boolean): string {
  if (!on) return text;
  return `${COLORS[name]}${text}${COLORS.reset}`;
}

function rowLine(cells: string[], widths: number[], statusName: keyof typeof COLORS | null = null): string {
  const padded = cells.map((c, i) => ' ' + pad(c, widths[i]) + ' ');
  if (statusName) {
    padded[padded.length - 1] = ' ' + colorPad(cells[cells.length - 1], widths[widths.length - 1], statusName) + ' ';
  }
  return '│' + padded.join('│') + '│';
}

function colorPad(text: string, width: number, name: keyof typeof COLORS): string {
  return COLORS[name] + pad(text, width) + COLORS.reset;
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
