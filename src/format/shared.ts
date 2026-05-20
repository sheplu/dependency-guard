import type { DependencyType, UpdateType } from '../types.ts';

const ESC = '\x1b';
export const ANSI = {
  reset: `${ESC}[0m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  dim: `${ESC}[2m`,
} as const;

export type AnsiColor = keyof typeof ANSI;

export function colorize(text: string, name: AnsiColor, on: boolean): string {
  if (!on) return text;
  return `${ANSI[name]}${text}${ANSI.reset}`;
}

export function typeShort(type: DependencyType): string {
  switch (type) {
    case 'dependencies':
      return 'prod';
    case 'devDependencies':
      return 'dev';
    case 'peerDependencies':
      return 'peer';
    case 'optionalDependencies':
      return 'opt';
    case 'overrides':
      return 'over';
    case 'resolutions':
      return 'resol';
    case 'pnpm.overrides':
      return 'pnpm';
  }
}

export function statusLabel(updateType: UpdateType): string {
  switch (updateType) {
    case 'up-to-date':
      return '✓ Up to date';
    case 'minor':
      return '↑ Minor';
    case 'major':
      return '⬆ Major';
  }
}
