import { parseArgs } from 'node:util';
import { runAnalysis } from './analyze.ts';
import { Cache } from './cache.ts';
import { formatJson } from './format/json.ts';
import { formatMarkdown } from './format/markdown.ts';
import { formatTable } from './format/table.ts';
import { colorize } from './format/shared.ts';
import { evaluatePolicy } from './policy.ts';
import type { AnalysisReport, CliOptions, FailOnLevel, OutputFormat } from './types.ts';

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
      --ignore-scope <scope> Skip packages in this scope (repeatable, e.g. @mycompany)
      --no-cache             Disable caching of registry responses
      --cache-clear          Clear the registry cache directory and exit
      --cache-ttl <minutes>  Cache TTL in minutes (default: 60)
      --fail-on <level>      Exit 2 if any dependency needs an upgrade at this level
                             (major | minor | any)
      --max-age <days>       Exit 2 if any installed version is older than N days
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
        cache: { type: 'boolean', default: true },
        'cache-clear': { type: 'boolean', default: false },
        'cache-ttl': { type: 'string', default: '60' },
        'fail-on': { type: 'string' },
        'max-age': { type: 'string' },
        'ignore-scope': { type: 'string', multiple: true, default: [] },
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
    cache: boolean;
    'cache-clear': boolean;
    'cache-ttl': string;
    'fail-on'?: string;
    'max-age'?: string;
    'ignore-scope': string[];
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
        stderr: `Invalid --fail-on: ${failOnRaw} (expected one of: major, minor, any)\n`,
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

  const options: CliOptions = {
    path: values.path,
    format: values.format,
    prod: values.prod,
    dev: values.dev,
    peer: values.peer,
    optional: values.optional,
    cache: values.cache,
    cacheTtlMinutes,
    ignoredScopes: values['ignore-scope'],
    quiet: values.quiet,
    failOnLevel,
    maxAgeDays,
  };

  try {
    const report = await runAnalysis(options);
    let out = render(report, options.format, { quiet: options.quiet });
    if (options.format !== 'json' && report.skipped.length > 0) {
      out += '\n\n' + skippedSummary(report);
    }

    const policy = evaluatePolicy(report, {
      failOnLevel: options.failOnLevel,
      maxAgeDays: options.maxAgeDays,
    });
    if (!policy.passed) {
      return {
        exitCode: 2,
        stdout: out + '\n',
        stderr: `Policy check failed:\n${policy.reasons.map((r) => `  - ${r}`).join('\n')}\n`,
      };
    }

    return { exitCode: 0, stdout: out + '\n', stderr: '' };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${(err as Error).message}\n`,
    };
  }
}

function isFailOnLevel(value: string): value is FailOnLevel {
  return value === 'major' || value === 'minor' || value === 'any';
}

function skippedSummary(report: AnalysisReport): string {
  const useColor = Boolean(process.stdout.isTTY);
  const scopes = [...new Set(report.skipped.map((s) => s.scope))].join(', ');
  return colorize(
    `Skipped ${report.skipped.length} package(s) from ignored scope(s): ${scopes}`,
    'yellow',
    useColor,
  );
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
