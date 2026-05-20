import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { runAnalysis } from './analyze.ts';
import { Cache } from './cache.ts';
import { detectLockfiles } from './lockfile.ts';
import { formatJson } from './format/json.ts';
import { formatMarkdown } from './format/markdown.ts';
import { formatTable } from './format/table.ts';
import { colorize } from './format/shared.ts';
import { evaluatePolicy } from './policy.ts';
import type { AnalysisReport, CliOptions, FailOnLevel, OutputFormat, SortField, UpdateLevel } from './types.ts';
import { applyUpdates, collectAllSpecs, planUpdates, type PlannedUpdate } from './update.ts';
import { readPackageJson } from './package-json.ts';

const HELP = `Usage: dependency-guard [options]

Analyze your project's dependencies against the npm registry.

Options:
  -p, --path <path>          Path to package.json (default: ./package.json)
  -f, --format <format>      Output format: table, json, markdown (default: table)
  -q, --quiet                Suppress the summary block (table/markdown only)
      --prod                 Only check production dependencies
      --dev                  Only check dev dependencies
      --peer                 Only check peer dependencies
      --optional             Only check optional dependencies
      --overrides            Only check the npm overrides bucket
      --resolutions          Only check the yarn resolutions bucket
      --pnpm-overrides       Only check the pnpm.overrides bucket
      --ignore-scope <scope> Skip packages in this scope (repeatable, e.g. @mycompany)
      --only <names>         Analyze only these packages (comma-separated or
                             repeatable, e.g. --only express,react)
      --include-transitive   Also analyze transitive deps from package-lock.json
                             (npm v3+; default: direct deps only)
      --no-cache             Disable caching of registry responses
      --cache-clear          Clear the registry cache directory and exit
      --cache-ttl <minutes>  Cache TTL in minutes (default: 60)
      --fail-on <level>      Exit 2 if any dependency needs an upgrade at this level
                             (major | minor | any | deprecated)
      --max-age <days>       Exit 2 if any installed version is older than N days
      --sort <field>         Sort by age, status, or name (default: type then name)
      --registry <url>       Registry URL (default: https://registry.npmjs.org;
                             also via DEPENDENCY_GUARD_REGISTRY_URL env var)
      --update <level>       Rewrite package.json with the chosen upgrades
                             (minor | major); leaves up-to-date deps alone
      --dry-run              With --update, preview the changes without writing
  -h, --help                 Show help
  -v, --version              Show version number
`;

const VERSION = '0.1.0';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(argv: ReadonlyArray<string>): Promise<RunResult> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        path: { type: 'string', short: 'p', default: './package.json' },
        format: { type: 'string', short: 'f', default: 'table' },
        prod: { type: 'boolean', default: false },
        dev: { type: 'boolean', default: false },
        peer: { type: 'boolean', default: false },
        optional: { type: 'boolean', default: false },
        overrides: { type: 'boolean', default: false },
        resolutions: { type: 'boolean', default: false },
        'pnpm-overrides': { type: 'boolean', default: false },
        cache: { type: 'boolean', default: true },
        'cache-clear': { type: 'boolean', default: false },
        'cache-ttl': { type: 'string', default: '60' },
        'fail-on': { type: 'string' },
        'max-age': { type: 'string' },
        sort: { type: 'string' },
        registry: { type: 'string' },
        'ignore-scope': { type: 'string', multiple: true, default: [] },
        only: { type: 'string', multiple: true, default: [] },
        'include-transitive': { type: 'boolean', default: false },
        update: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      strict: true,
      allowNegative: true,
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${(err as Error).message}\n${HELP}`,
    };
  }

  const values = parsed.values as {
    path: string;
    format: string;
    prod: boolean;
    dev: boolean;
    peer: boolean;
    optional: boolean;
    overrides: boolean;
    resolutions: boolean;
    'pnpm-overrides': boolean;
    cache: boolean;
    'cache-clear': boolean;
    'cache-ttl': string;
    'fail-on'?: string;
    'max-age'?: string;
    sort?: string;
    registry?: string;
    'ignore-scope': string[];
    only: string[];
    'include-transitive': boolean;
    update?: string;
    'dry-run': boolean;
    quiet: boolean;
    help: boolean;
    version: boolean;
  };

  if (values.help) return { exitCode: 0, stdout: HELP, stderr: '' };
  if (values.version) return { exitCode: 0, stdout: `${VERSION}\n`, stderr: '' };

  if (values['cache-clear']) {
    const cache = new Cache();
    await cache.clear();
    return { exitCode: 0, stdout: `Cache cleared: ${cache.dir}\n`, stderr: '' };
  }

  if (!isOutputFormat(values.format)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Invalid --format value: ${values.format}. Expected one of: table, json, markdown\n`,
    };
  }

  const ttlRaw = values['cache-ttl'];
  const cacheTtlMinutes = Number(ttlRaw);
  if (!Number.isInteger(cacheTtlMinutes) || cacheTtlMinutes <= 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Invalid --cache-ttl: ${ttlRaw} (expected positive integer minutes)\n`,
    };
  }

  const failOnRaw = values['fail-on'];
  let failOnLevel: FailOnLevel | null = null;
  if (failOnRaw !== undefined) {
    if (!isFailOnLevel(failOnRaw)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid --fail-on: ${failOnRaw} (expected one of: major, minor, any, deprecated)\n`,
      };
    }
    failOnLevel = failOnRaw;
  }

  const maxAgeRaw = values['max-age'];
  let maxAgeDays: number | null = null;
  if (maxAgeRaw !== undefined) {
    const parsedAge = Number(maxAgeRaw);
    if (!Number.isInteger(parsedAge) || parsedAge <= 0) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid --max-age: ${maxAgeRaw} (expected positive integer days)\n`,
      };
    }
    maxAgeDays = parsedAge;
  }

  const sortRaw = values.sort;
  let sortBy: SortField | null = null;
  if (sortRaw !== undefined) {
    if (!isSortField(sortRaw)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid --sort: ${sortRaw} (expected one of: age, status, name)\n`,
      };
    }
    sortBy = sortRaw;
  }

  const registryRaw = values.registry;
  let registryUrl: string | null = null;
  if (registryRaw !== undefined) {
    if (!isHttpUrl(registryRaw)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid --registry: ${registryRaw} (expected URL starting with http:// or https://)\n`,
      };
    }
    registryUrl = registryRaw;
  }

  const updateRaw = values.update;
  let updateLevel: UpdateLevel | null = null;
  if (updateRaw !== undefined) {
    if (!isUpdateLevel(updateRaw)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid --update: ${updateRaw} (expected one of: minor, major)\n`,
      };
    }
    updateLevel = updateRaw;
  }

  const options: CliOptions = {
    path: values.path,
    format: values.format,
    prod: values.prod,
    dev: values.dev,
    peer: values.peer,
    optional: values.optional,
    overrides: values.overrides,
    resolutions: values.resolutions,
    pnpmOverrides: values['pnpm-overrides'],
    cache: values.cache,
    cacheTtlMinutes,
    ignoredScopes: values['ignore-scope'],
    onlyNames: flattenCsv(values.only),
    quiet: values.quiet,
    failOnLevel,
    maxAgeDays,
    sortBy,
    registryUrl,
    includeTransitive: values['include-transitive'],
    updateLevel,
    dryRun: values['dry-run'],
  };

  let extraStderr = '';
  if (options.registryUrl !== null && options.registryUrl.startsWith('http://')) {
    const useColor = Boolean(process.stderr.isTTY);
    extraStderr += colorize(
      `Warning: --registry is using plain HTTP (${options.registryUrl}); prefer HTTPS when available.`,
      'yellow',
      useColor,
    ) + '\n';
  }

  let lockfilesPresent = { npm: false, pnpm: false, yarn: false };
  if (options.includeTransitive) {
    lockfilesPresent = await detectLockfiles(dirname(options.path));
    const found: string[] = [];
    if (lockfilesPresent.npm) found.push('package-lock.json');
    if (lockfilesPresent.pnpm) found.push('pnpm-lock.yaml');
    if (lockfilesPresent.yarn) found.push('yarn.lock');
    if (found.length > 1) {
      const winner = found[0];
      const ignored = found.slice(1).join(', ');
      const useColor = Boolean(process.stderr.isTTY);
      extraStderr += colorize(
        `Warning: multiple lockfiles found (${found.join(', ')}); using ${winner}, ignoring ${ignored}.`,
        'yellow',
        useColor,
      ) + '\n';
    }
  }

  try {
    const report = await runAnalysis(options);
    let out = render(report, options.format, { quiet: options.quiet });
    if (options.format !== 'json' && report.skipped.length > 0) {
      out += '\n\n' + skippedSummary(report);
    }

    if (options.onlyNames.length > 0) {
      const analyzed = new Set(report.dependencies.map((d) => d.name));
      const unmatched = options.onlyNames.filter((n) => !analyzed.has(n));
      if (unmatched.length > 0) {
        const useColor = Boolean(process.stderr.isTTY);
        extraStderr += colorize(
          `Warning: --only includes name(s) not found in package.json: ${unmatched.join(', ')}`,
          'yellow',
          useColor,
        ) + '\n';
      }
    }

    if (
      options.includeTransitive &&
      !lockfilesPresent.npm &&
      !lockfilesPresent.pnpm &&
      !lockfilesPresent.yarn
    ) {
      const useColor = Boolean(process.stderr.isTTY);
      extraStderr += colorize(
        'Warning: --include-transitive set, but no lockfile was found (expected package-lock.json, pnpm-lock.yaml, or yarn.lock).',
        'yellow',
        useColor,
      ) + '\n';
    }

    const policy = evaluatePolicy(report, {
      failOnLevel: options.failOnLevel,
      maxAgeDays: options.maxAgeDays,
    });
    if (!policy.passed) {
      return {
        exitCode: 2,
        stdout: out + '\n',
        stderr: extraStderr + `Policy check failed:\n${policy.reasons.map((r) => `  - ${r}`).join('\n')}\n`,
      };
    }

    if (options.updateLevel !== null) {
      const pkg = await readPackageJson(options.path);
      const originalSpecs = collectAllSpecs(pkg);
      const updates = planUpdates(report, options.updateLevel, originalSpecs);
      const useColor = Boolean(process.stdout.isTTY);
      if (updates.length === 0) {
        out += `\n\nNo updates to apply at level "${options.updateLevel}".`;
      } else if (options.dryRun) {
        out += '\n\n' + formatUpdateSummary(updates, options.updateLevel, true, useColor);
      } else {
        await applyUpdates(options.path, updates);
        out += '\n\n' + formatUpdateSummary(updates, options.updateLevel, false, useColor);
      }
    } else if (options.dryRun) {
      const useColor = Boolean(process.stderr.isTTY);
      extraStderr += colorize(
        'Warning: --dry-run requires --update; ignored.',
        'yellow',
        useColor,
      ) + '\n';
    }

    return { exitCode: 0, stdout: out + '\n', stderr: extraStderr };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: extraStderr + `${(err as Error).message}\n`,
    };
  }
}

function flattenCsv(values: ReadonlyArray<string>): string[] {
  return values.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
}

function isFailOnLevel(value: string): value is FailOnLevel {
  return value === 'major' || value === 'minor' || value === 'any' || value === 'deprecated';
}

function isSortField(value: string): value is SortField {
  return value === 'age' || value === 'status' || value === 'name';
}

function isUpdateLevel(value: string): value is UpdateLevel {
  return value === 'minor' || value === 'major';
}

function formatUpdateSummary(
  updates: ReadonlyArray<PlannedUpdate>,
  level: UpdateLevel,
  dryRun: boolean,
  useColor: boolean,
): string {
  const headline = dryRun
    ? `Would apply ${updates.length} update(s) at level "${level}":`
    : `Updated ${updates.length} dep(s) in package.json at level "${level}":`;
  const arrow = dryRun ? '↑' : '✓';
  const arrowColor = dryRun ? 'yellow' : 'green';
  const nameWidth = updates.reduce((m, u) => Math.max(m, u.name.length), 0);
  const lines = updates.map((u) => {
    const padded = u.name.padEnd(nameWidth);
    return `  ${colorize(arrow, arrowColor, useColor)} ${padded}  ${u.oldSpec} → ${u.newSpec}`;
  });
  return [colorize(headline, arrowColor, useColor), ...lines].join('\n');
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//.test(value)) return false;
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return parsed.hostname.length > 0;
}

function skippedSummary(report: AnalysisReport): string {
  const useColor = Boolean(process.stdout.isTTY);
  const lines: string[] = [];

  const ignoredScopes = report.skipped.filter((s) => s.reason === 'ignored-scope');
  if (ignoredScopes.length > 0) {
    const scopes = [...new Set(ignoredScopes.map((s) => s.scope))].join(', ');
    lines.push(
      `Skipped ${ignoredScopes.length} package(s) from ignored scope(s): ${scopes}`,
    );
  }

  const pathSpecific = report.skipped.filter((s) => s.reason === 'override-path-specific');
  if (pathSpecific.length > 0) {
    const names = pathSpecific.map((s) => s.name).join(', ');
    lines.push(
      `Skipped ${pathSpecific.length} path-specific override(s): ${names}`,
    );
  }

  const references = report.skipped.filter((s) => s.reason === 'override-reference');
  if (references.length > 0) {
    const names = references.map((s) => s.name).join(', ');
    lines.push(
      `Skipped ${references.length} reference override(s) ("$name"): ${names}`,
    );
  }

  const removals = report.skipped.filter((s) => s.reason === 'override-removal');
  if (removals.length > 0) {
    const names = removals.map((s) => s.name).join(', ');
    lines.push(
      `Skipped ${removals.length} pnpm removal pin(s) ("-"): ${names}`,
    );
  }

  const descriptors = report.skipped.filter((s) => s.reason === 'override-descriptor');
  if (descriptors.length > 0) {
    const names = descriptors.map((s) => s.name).join(', ');
    lines.push(
      `Skipped ${descriptors.length} non-semver pin(s) (npm:/file:/portal:/git+/etc): ${names}`,
    );
  }

  return colorize(lines.join('\n'), 'yellow', useColor);
}

interface RenderOptions {
  quiet: boolean;
}

function render(report: AnalysisReport, format: OutputFormat, opts: RenderOptions): string {
  if (format === 'json') return formatJson(report);
  if (format === 'markdown') return formatMarkdown(report, { quiet: opts.quiet });
  return formatTable(report, { quiet: opts.quiet });
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'table' || value === 'json' || value === 'markdown';
}
