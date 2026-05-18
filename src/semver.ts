export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  build: ReadonlyArray<string>;
  raw: string;
}

const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const WILDCARD_RE = /[xX*]/;

function expandWildcard(version: string): string {
  if (!WILDCARD_RE.test(version)) return version;
  const parts = version.split('.').map((p) => (/^[xX*]$/.test(p) ? '0' : p));
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

export function parse(input: string): ParsedVersion | null {
  const cleaned = input.trim().replace(/^[v=]/, '').replace(/^[\^~><=\s]+/, '');
  const expanded = expandWildcard(cleaned);
  const match = VERSION_RE.exec(expanded);
  if (!match) return null;
  const [, major, minor, patch, pre, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre
      ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [],
    build: build ? build.split('.') : [],
    raw: expanded,
  };
}

export function isStable(v: ParsedVersion): boolean {
  return v.prerelease.length === 0;
}

export function compare(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(
  a: ReadonlyArray<string | number>,
  b: ReadonlyArray<string | number>,
): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;
    const aNum = typeof ai === 'number';
    const bNum = typeof bi === 'number';
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    if (aNum && bNum) return (ai as number) - (bi as number);
    return (ai as string) < (bi as string) ? -1 : 1;
  }
  return a.length - b.length;
}

export function maxVersion(
  versions: ReadonlyArray<ParsedVersion>,
): ParsedVersion | null {
  if (versions.length === 0) return null;
  let best = versions[0];
  for (let i = 1; i < versions.length; i++) {
    if (compare(versions[i], best) > 0) best = versions[i];
  }
  return best;
}

export function stripRange(spec: string): string {
  return spec.trim().replace(/^[\^~><=\s]+/, '');
}
