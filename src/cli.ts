import { parseArgs } from 'node:util';
import { runAnalysis } from './analyze.ts';
import { formatJson } from './format/json.ts';
import { formatMarkdown } from './format/markdown.ts';
import { formatTable } from './format/table.ts';
import { colorize } from './format/shared.ts';
import type { AnalysisReport, CliOptions, OutputFormat } from './types.ts';

const HELP = `Usage: dependency-guard [options]

Analyze your project's dependencies against the npm registry.

Options:
  -p, --path <path>          Path to package.json (default: ./package.json)
  -f, --format <format>      Output format: table, json, markdown (default: table)
      --prod                 Only check production dependencies
      --dev                  Only check dev dependencies
      --peer                 Only check peer dependencies
      --optional             Only check optional dependencies
      --ignore-scope <scope> Skip packages in this scope (repeatable, e.g. @mycompany)
      --no-cache             Disable caching of registry responses
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
        'ignore-scope': { type: 'string', multiple: true, default: [] },
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
    'ignore-scope': string[];
    help: boolean;
    version: boolean;
  };

  if (values.help) return { exitCode: 0, stdout: HELP, stderr: '' };
  if (values.version) return { exitCode: 0, stdout: `${VERSION}\n`, stderr: '' };

  if (!isOutputFormat(values.format)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Invalid --format value: ${values.format}. Expected one of: table, json, markdown\n`,
    };
  }

  const options: CliOptions = {
    path: values.path,
    format: values.format,
    prod: values.prod,
    dev: values.dev,
    peer: values.peer,
    optional: values.optional,
    cache: values.cache,
    ignoredScopes: values['ignore-scope'],
  };

  try {
    const report = await runAnalysis(options);
    let out = render(report, options.format);
    if (options.format !== 'json' && report.skipped.length > 0) {
      out += '\n\n' + skippedSummary(report);
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

function skippedSummary(report: AnalysisReport): string {
  const useColor = Boolean(process.stdout.isTTY);
  const scopes = [...new Set(report.skipped.map((s) => s.scope))].join(', ');
  return colorize(
    `Skipped ${report.skipped.length} package(s) from ignored scope(s): ${scopes}`,
    'yellow',
    useColor,
  );
}

function render(report: AnalysisReport, format: OutputFormat): string {
  if (format === 'json') return formatJson(report);
  if (format === 'markdown') return formatMarkdown(report);
  return formatTable(report);
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'table' || value === 'json' || value === 'markdown';
}
