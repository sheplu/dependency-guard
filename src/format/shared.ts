import type { DependencyType, UpdateType } from '../types.ts';

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
