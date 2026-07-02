import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startMockRegistry, type MockRegistry } from './helpers/mock-registry.ts';
import { createTmpProject, type TmpProject } from './helpers/tmp-project.ts';

const BIN = resolve(import.meta.dirname, '..', '..', 'index.ts');

const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString();

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function startPatchRegistry() {
  // express 4.18.2 (installed) has a 4.18.5 patch and a 4.21.0 minor available.
  // lodash 4.17.20 (installed) has a 4.17.21 patch and 4.18.0 minor available.
  // typescript 5.2.2 (installed) only has 5.3.3 (minor) — no patch.
  return startMockRegistry([
    {
      name: 'express',
      versions: {
        '4.18.2': { version: '4.18.2' },
        '4.18.5': { version: '4.18.5' },
        '4.21.0': { version: '4.21.0' },
        '5.0.1': { version: '5.0.1' },
      },
      time: {
        '4.18.2': '2025-09-15T00:00:00Z',
        '4.18.5': '2025-12-01T00:00:00Z',
        '4.21.0': '2026-02-01T00:00:00Z',
        '5.0.1': '2026-03-01T00:00:00Z',
      },
    },
    {
      name: 'lodash',
      versions: {
        '4.17.20': { version: '4.17.20' },
        '4.17.21': { version: '4.17.21' },
        '4.18.0': { version: '4.18.0' },
      },
      time: {
        '4.17.20': '2024-01-01T00:00:00Z',
        '4.17.21': '2024-06-01T00:00:00Z',
        '4.18.0': '2025-01-01T00:00:00Z',
      },
    },
    {
      name: 'typescript',
      versions: {
        '5.2.2': { version: '5.2.2' },
        '5.3.3': { version: '5.3.3' },
      },
      time: {
        '5.2.2': '2026-01-01T00:00:00Z',
        '5.3.3': '2026-04-01T00:00:00Z',
      },
    },
  ]);
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolveSpawn({ exitCode: code ?? 0, stdout, stderr }));
  });
}

describe('CLI integration', () => {
  let registry: MockRegistry;
  let project: TmpProject;
  let cacheDir: string;

  beforeEach(async () => {
    registry = await startMockRegistry([
      {
        name: 'express',
        versions: {
          '4.18.2': { version: '4.18.2' },
          '4.21.0': { version: '4.21.0' },
          '5.0.1': { version: '5.0.1' },
        },
        time: {
          '4.18.2': '2025-09-15T00:00:00Z',
          '4.21.0': '2026-02-01T00:00:00Z',
          '5.0.1': '2026-03-01T00:00:00Z',
        },
      },
      {
        name: 'lodash',
        versions: { '4.17.21': { version: '4.17.21' } },
        time: { '4.17.21': '2024-01-01T00:00:00Z' },
      },
      {
        name: 'typescript',
        versions: {
          '5.2.2': { version: '5.2.2' },
          '5.3.3': { version: '5.3.3' },
        },
        time: {
          '5.2.2': '2026-01-01T00:00:00Z',
          '5.3.3': '2026-04-01T00:00:00Z',
        },
      },
    ]);
    project = await createTmpProject({
      packageJson: {
        name: 'fixture',
        version: '1.0.0',
        dependencies: {
          express: '^4.18.0',
          lodash: '4.17.21',
        },
        devDependencies: {
          typescript: '^5.2.0',
        },
      },
      installed: {
        express: '4.18.2',
        lodash: '4.17.21',
        typescript: '5.2.2',
      },
    });
    cacheDir = await mkdtemp(join(tmpdir(), 'dep-guard-cache-'));
  });

  afterEach(async () => {
    await registry.close();
    await project.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('exits 0 with --help', async () => {
    const result = await runCli(['--help'], {});
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage: dependency-guard/);
  });

  it('exits 0 with --version', async () => {
    const result = await runCli(['--version'], {});
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });

  it('produces JSON matching the README schema', async () => {
    const result = await runCli(
      ['--path', project.packageJsonPath, '--format', 'json', '--no-cache'],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.majorUpdates, 1);
    assert.equal(report.summary.minorUpdates, 1);
    assert.equal(report.summary.upToDate, 1);
    const express = report.dependencies.find((d: { name: string }) => d.name === 'express');
    assert.equal(express.updateType, 'major');
    assert.equal(express.latestMajor.version, '5.0.1');
    assert.equal(express.latestMinor.version, '4.21.0');

    const lodash = report.dependencies.find((d: { name: string }) => d.name === 'lodash');
    assert.equal(lodash.updateType, 'up-to-date');
    assert.equal(lodash.latestMajor, null);
    assert.equal(lodash.latestMinor, null);
  });

  it('renders the table format', async () => {
    const result = await runCli(
      ['--path', project.packageJsonPath, '--format', 'table', '--no-cache'],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Summary:/);
    assert.match(result.stdout, /express/);
    assert.match(result.stdout, /typescript/);
  });

  it('renders the markdown format', async () => {
    const result = await runCli(
      ['--path', project.packageJsonPath, '--format', 'markdown', '--no-cache'],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /## Dependency Report/);
    assert.match(result.stdout, /\| express \| prod \|/);
  });

  it('filters with --prod', async () => {
    const result = await runCli(
      ['--path', project.packageJsonPath, '--format', 'json', '--prod', '--no-cache'],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
    assert.deepEqual(names, ['express', 'lodash']);
  });

  it('exits 1 when package.json is missing', async () => {
    const result = await runCli(
      ['--path', join(project.dir, 'does-not-exist.json'), '--format', 'json'],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /ENOENT|no such file/i);
  });

  it('exits 1 on invalid --format', async () => {
    const result = await runCli(['--format', 'yaml'], {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --format/);
  });

  it('--quiet strips the Summary block from table output', async () => {
    const result = await runCli(
      ['--path', project.packageJsonPath, '--format', 'table', '--quiet', '--no-cache'],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Summary:/);
    assert.match(result.stdout, /express/);
  });

  it('hides Patch/Minor/Major columns when no dep has an upgrade in those tiers', async () => {
    const cleanProject = await createTmpProject({
      packageJson: {
        name: 'fixture-clean-columns',
        version: '1.0.0',
        dependencies: { lodash: '4.17.21' },
      },
      installed: { lodash: '4.17.21' },
    });
    try {
      const result = await runCli(
        ['--path', cleanProject.packageJsonPath, '--format', 'table', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /│ Patch /);
      assert.doesNotMatch(result.stdout, /│ Minor /);
      assert.doesNotMatch(result.stdout, /│ Major /);
      // Other columns are still present
      assert.match(result.stdout, /│ Package /);
      assert.match(result.stdout, /│ Current /);
      assert.match(result.stdout, /│ Status /);
    } finally {
      await cleanProject.cleanup();
    }
  });

  it('--all-columns forces Patch/Minor/Major to render even when empty', async () => {
    const cleanProject = await createTmpProject({
      packageJson: {
        name: 'fixture-clean-allcols',
        version: '1.0.0',
        dependencies: { lodash: '4.17.21' },
      },
      installed: { lodash: '4.17.21' },
    });
    try {
      const result = await runCli(
        [
          '--path',
          cleanProject.packageJsonPath,
          '--format',
          'table',
          '--all-columns',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /│ Patch /);
      assert.match(result.stdout, /│ Minor /);
      assert.match(result.stdout, /│ Major /);
    } finally {
      await cleanProject.cleanup();
    }
  });

  it('--cache-clear exits 0 against an isolated cache dir', async () => {
    const result = await runCli(['--cache-clear'], {
      DEPENDENCY_GUARD_CACHE_DIR: cacheDir,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Cache cleared:/);
  });

  it('--cache-ttl <minutes> runs successfully with a valid value', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--cache-ttl',
        '5',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.total, 3);
  });

  it('--cache-ttl rejects non-integer values with a clear error', async () => {
    const result = await runCli(['--cache-ttl', 'abc'], {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --cache-ttl: abc/);
  });

  it('--registry routes traffic to the given URL (no env var needed)', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--registry',
        registry.url,
        '--no-cache',
      ],
      {}, // intentionally NO DEPENDENCY_GUARD_REGISTRY_URL
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.total, 3);
  });

  it('--registry takes precedence over DEPENDENCY_GUARD_REGISTRY_URL', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--registry',
        registry.url,
        '--no-cache',
      ],
      // env points at a bogus URL; flag should win
      { DEPENDENCY_GUARD_REGISTRY_URL: 'http://127.0.0.1:1' },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.total, 3);
  });

  it('--registry rejects non-http URLs with exit 1', async () => {
    const result = await runCli(['--registry', 'registry.example.com'], {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --registry/);
  });

  it('--registry rejects URLs with an empty hostname', async () => {
    const result = await runCli(['--registry', 'http://'], {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --registry/);
  });

  it('--registry warns on plain HTTP but still runs', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--registry',
        registry.url, // mock registry runs on http://127.0.0.1:<port>
        '--no-cache',
      ],
      {},
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Warning:.*plain HTTP/);
    assert.match(result.stderr, new RegExp(registry.url.replace(/[/.]/g, '\\$&')));
    // stdout still parses as valid JSON
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.total, 3);
  });

  it('--registry on HTTPS does NOT emit the plain-HTTP warning', async () => {
    // We can't reach a real HTTPS mock easily; use the validation path:
    // a valid-looking https:// URL passes parsing, then the call fails — but
    // crucially the warning should be absent from stderr regardless.
    const result = await runCli(
      ['--registry', 'https://127.0.0.1:1', '--no-cache', '--format', 'json'],
      {},
    );
    // We don't assert exitCode (the unreachable host will fail); only that
    // the HTTP warning never appears for https URLs.
    assert.doesNotMatch(result.stderr, /plain HTTP/);
  });

  it('--fail-on major exits 2 with full report and reason on stderr', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--fail-on',
        'major',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 2);
    // Full report still printed to stdout
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.total, 3);
    // Reason on stderr
    assert.match(result.stderr, /Policy check failed/);
    assert.match(result.stderr, /--fail-on major/);
    assert.match(result.stderr, /express@4\.18\.2/);
  });

  it('--fail-on minor catches both minor and major upgrades', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--fail-on',
        'minor',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /express@4\.18\.2/);
    assert.match(result.stderr, /typescript@5\.2\.2/);
  });

  it('--max-age fails when an installed version is older than the threshold', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--max-age',
        '30',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--max-age 30/);
    // lodash is from 2024-01-01, well over 30 days old
    assert.match(result.stderr, /lodash/);
  });

  it('exits 0 when --fail-on threshold is not exceeded', async () => {
    // Use an isolated project where every dep is up-to-date
    const cleanProject = await createTmpProject({
      packageJson: {
        name: 'clean',
        version: '1.0.0',
        dependencies: { lodash: '4.17.21' },
      },
      installed: { lodash: '4.17.21' },
    });
    try {
      const result = await runCli(
        [
          '--path',
          cleanProject.packageJsonPath,
          '--format',
          'json',
          '--fail-on',
          'major',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
    } finally {
      await cleanProject.cleanup();
    }
  });

  it('--sort status orders major → minor → up-to-date', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--sort',
        'status',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.dependencies.map((d: { name: string; updateType: string }) => [d.name, d.updateType]),
      [
        ['express', 'major'],
        ['typescript', 'minor'],
        ['lodash', 'up-to-date'],
      ],
    );
  });

  it('--sort age orders oldest installed first', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--sort',
        'age',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    // lodash (2024-01-01) → express (2025-09-15) → typescript (2026-01-01)
    assert.deepEqual(
      report.dependencies.map((d: { name: string }) => d.name),
      ['lodash', 'express', 'typescript'],
    );
  });

  it('--sort name produces strict alphabetical, ignoring type', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--sort',
        'name',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.dependencies.map((d: { name: string }) => d.name),
      ['express', 'lodash', 'typescript'],
    );
  });

  it('--only narrows analysis to a single package', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--only',
        'express',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.dependencies.map((d: { name: string }) => d.name),
      ['express'],
    );
  });

  it('--only accepts comma-separated and repeatable forms', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--only',
        'express,typescript',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
    assert.deepEqual(names, ['express', 'typescript']);
  });

  it('--only accepts repeatable form (--only a --only b)', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--only',
        'express',
        '--only',
        'typescript',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
    assert.deepEqual(names, ['express', 'typescript']);
  });

  it('--only with unmatched names emits a stderr warning but exits 0', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--only',
        'nonexistent',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dependencies.length, 0);
    assert.match(result.stderr, /Warning: --only includes name\(s\) not found.*nonexistent/);
  });

  it('--only AND --prod intersect (dev target dropped)', async () => {
    const result = await runCli(
      [
        '--path',
        project.packageJsonPath,
        '--format',
        'json',
        '--only',
        'typescript',
        '--prod',
        '--no-cache',
      ],
      { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    // typescript is dev, --prod drops it; --only keeps nothing matching
    assert.equal(report.dependencies.length, 0);
  });

  describe('with deprecated packages', () => {
    let deprProject: TmpProject;
    let deprRegistry: MockRegistry;

    beforeEach(async () => {
      deprRegistry = await startMockRegistry([
        {
          name: 'request',
          versions: {
            '2.88.2': { version: '2.88.2', deprecated: 'request has been deprecated' },
          },
          time: { '2.88.2': '2020-02-12T00:00:00Z' },
        },
      ]);
      deprProject = await createTmpProject({
        packageJson: {
          name: 'fixture-depr',
          version: '1.0.0',
          dependencies: { request: '^2.88.0' },
        },
        installed: { request: '2.88.2' },
      });
    });

    afterEach(async () => {
      await deprRegistry.close();
      await deprProject.cleanup();
    });

    it('surfaces deprecation in JSON output', async () => {
      const result = await runCli(
        ['--path', deprProject.packageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: deprRegistry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.dependencies[0].deprecated, 'request has been deprecated');
    });

    it('renders ⚠ next to deprecated packages in table output', async () => {
      const result = await runCli(
        ['--path', deprProject.packageJsonPath, '--format', 'table', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: deprRegistry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /request ⚠/);
    });

    it('--fail-on deprecated exits 2 when an installed version is deprecated', async () => {
      const result = await runCli(
        [
          '--path',
          deprProject.packageJsonPath,
          '--format',
          'json',
          '--fail-on',
          'deprecated',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: deprRegistry.url },
      );
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /--fail-on deprecated/);
      assert.match(result.stderr, /request@2\.88\.2/);
    });
  });

  describe('with --ignore-scope', () => {
    let privateProject: TmpProject;

    beforeEach(async () => {
      privateProject = await createTmpProject({
        packageJson: {
          name: 'fixture-private',
          version: '1.0.0',
          dependencies: {
            '@private/foo': '1.0.0',
            express: '^4.18.0',
          },
        },
        installed: {
          '@private/foo': '1.0.0',
          express: '4.18.2',
        },
      });
    });

    afterEach(async () => {
      await privateProject.cleanup();
    });

    it('skips ignored scopes and reports them in JSON', async () => {
      const result = await runCli(
        [
          '--path',
          privateProject.packageJsonPath,
          '--format',
          'json',
          '--ignore-scope',
          '@private',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.dependencies.length, 1);
      assert.equal(report.dependencies[0].name, 'express');
      assert.deepEqual(report.skipped, [
        { name: '@private/foo', type: 'dependencies', reason: 'ignored-scope', scope: '@private' },
      ]);
    });

    it('appends a one-liner to stdout in table format', async () => {
      const result = await runCli(
        [
          '--path',
          privateProject.packageJsonPath,
          '--format',
          'table',
          '--ignore-scope',
          '@private',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Skipped 1 package\(s\) from ignored scope\(s\): @private/);
    });

    it('does not append the one-liner in JSON format (output stays parseable)', async () => {
      const result = await runCli(
        [
          '--path',
          privateProject.packageJsonPath,
          '--format',
          'json',
          '--ignore-scope',
          '@private',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      // JSON.parse succeeds = no extra trailing line
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.summary, 'object');
      assert.doesNotMatch(result.stdout, /Skipped/);
    });
  });

  describe('with --include-transitive', () => {
    let lockProject: TmpProject;

    beforeEach(async () => {
      lockProject = await createTmpProject({
        packageJson: {
          name: 'fixture-lock',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { lodash: '4.17.21' },
            },
            'node_modules/lodash': { version: '4.17.21' },
          },
        },
      });
    });

    afterEach(async () => {
      await lockProject.cleanup();
    });

    it('default behavior (without flag) does not include transitives', async () => {
      const result = await runCli(
        ['--path', lockProject.packageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.dependencies.length, 1);
      assert.equal(report.dependencies[0].name, 'express');
    });

    it('--include-transitive expands the lockfile graph', async () => {
      const result = await runCli(
        [
          '--path',
          lockProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
      assert.deepEqual(names, ['express', 'lodash']);
      const lodash = report.dependencies.find((d: { name: string }) => d.name === 'lodash');
      assert.equal(lodash.transitive, true);
      const express = report.dependencies.find((d: { name: string }) => d.name === 'express');
      assert.equal(express.transitive, false);
    });

    it('renders ↳ prefix for transitive rows in table format', async () => {
      const result = await runCli(
        [
          '--path',
          lockProject.packageJsonPath,
          '--format',
          'table',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /↳ lodash/);
    });

    it('warns on stderr when --include-transitive set but no lockfile is present', async () => {
      // project has no package-lock.json
      const result = await runCli(
        [
          '--path',
          project.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stderr, /Warning: --include-transitive set, but no lockfile was found/);
      assert.match(result.stderr, /package-lock\.json, pnpm-lock\.yaml, or yarn\.lock/);
    });

    it('renders ↳ prefix for npm-sourced transitives in markdown format', async () => {
      const result = await runCli(
        [
          '--path',
          lockProject.packageJsonPath,
          '--format',
          'markdown',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /\| ↳ lodash \|/);
    });

    it('rejects unsupported npm lockfile versions (v2) and falls back to direct deps only', async () => {
      const v2Project = await createTmpProject({
        packageJson: {
          name: 'fixture-v2-npm',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        // v2 is rejected by loadNpmLock (we require >= v3)
        packageLock: { lockfileVersion: 2, packages: {} },
      });
      try {
        const result = await runCli(
          [
            '--path',
            v2Project.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        // Only the direct dep; loader rejects v2 silently
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
      } finally {
        await v2Project.cleanup();
      }
    });
  });

  describe('with yarn.lock', () => {
    let yarnProject: TmpProject;

    beforeEach(async () => {
      yarnProject = await createTmpProject({
        packageJson: {
          name: 'fixture-yarn',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        yarnLock: `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    lodash: "npm:4.17.21"

"lodash@npm:4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
`,
      });
    });

    afterEach(async () => {
      await yarnProject.cleanup();
    });

    it('--include-transitive walks yarn.lock when no package-lock.json is present', async () => {
      const result = await runCli(
        [
          '--path',
          yarnProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
      assert.deepEqual(names, ['express', 'lodash']);
      const lodash = report.dependencies.find((d: { name: string }) => d.name === 'lodash');
      assert.equal(lodash.transitive, true);
    });

    it('emits a conflict warning when both package-lock.json and yarn.lock exist (npm wins)', async () => {
      const bothProject = await createTmpProject({
        packageJson: {
          name: 'fixture-both',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        // npm lock says express has lodash as a child
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { lodash: '4.17.21' },
            },
            'node_modules/lodash': { version: '4.17.21' },
          },
        },
        // yarn lock would say something different — but should be ignored
        yarnLock: `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    typescript: "npm:5.0.0"

"typescript@npm:5.0.0":
  version: 5.0.0
  resolution: "typescript@npm:5.0.0"
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            bothProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(
          result.stderr,
          /Warning: multiple lockfiles found \(package-lock\.json, yarn\.lock\); using package-lock\.json, ignoring yarn\.lock\./,
        );
        const report = JSON.parse(result.stdout);
        const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
        // npm lockfile content (express + lodash), NOT yarn (which would have typescript)
        assert.deepEqual(names, ['express', 'lodash']);
      } finally {
        await bothProject.cleanup();
      }
    });

    it('renders ↳ prefix for transitives sourced from yarn.lock (table format)', async () => {
      const result = await runCli(
        [
          '--path',
          yarnProject.packageJsonPath,
          '--format',
          'table',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /↳ lodash/);
    });

    it('renders ↳ prefix for transitives in markdown format', async () => {
      const result = await runCli(
        [
          '--path',
          yarnProject.packageJsonPath,
          '--format',
          'markdown',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /\| ↳ lodash \|/);
    });

    it('falls back gracefully when yarn.lock is malformed (treated as no lockfile)', async () => {
      const malformedProject = await createTmpProject({
        packageJson: {
          name: 'fixture-malformed',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        yarnLock: 'this is not a valid yarn.lock\n',
      });
      try {
        const result = await runCli(
          [
            '--path',
            malformedProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        // Only the direct dep; no crash from the parser
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
      } finally {
        await malformedProject.cleanup();
      }
    });

    it('--include-transitive + --ignore-scope filters yarn-sourced private transitives', async () => {
      const yarnPrivateProject = await createTmpProject({
        packageJson: {
          name: 'fixture-yarn-private',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        yarnLock: `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    "@private/inner": "npm:1.0.0"

"@private/inner@npm:1.0.0":
  version: 1.0.0
  resolution: "@private/inner@npm:1.0.0"
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            yarnPrivateProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--ignore-scope',
            '@private',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(
          report.dependencies.map((d: { name: string }) => d.name),
          ['express'],
        );
        assert.equal(report.skipped.length, 1);
        assert.equal(report.skipped[0].name, '@private/inner');
      } finally {
        await yarnPrivateProject.cleanup();
      }
    });

    it('--include-transitive + --prod walks only prod transitives (yarn)', async () => {
      const yarnMixedProject = await createTmpProject({
        packageJson: {
          name: 'fixture-yarn-mixed',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          devDependencies: { typescript: '^5.2.0' },
        },
        installed: { express: '4.18.2', typescript: '5.2.2' },
        yarnLock: `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"

"typescript@npm:^5.2.0":
  version: 5.2.2
  resolution: "typescript@npm:5.2.2"
  dependencies:
    lodash: "npm:4.17.21"

"lodash@npm:4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            yarnMixedProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--prod',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        // typescript is dev → dropped → its transitive lodash also dropped
        assert.deepEqual(
          report.dependencies.map((d: { name: string }) => d.name),
          ['express'],
        );
      } finally {
        await yarnMixedProject.cleanup();
      }
    });

    it('--include-transitive + --fail-on major exits 2 with a yarn fixture', async () => {
      const result = await runCli(
        [
          '--path',
          yarnProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--fail-on',
          'major',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      // express 4.18.2 → registry has 5.0.1 → major upgrade → exit 2
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /--fail-on major/);
      assert.match(result.stderr, /express@4\.18\.2/);
    });
  });

  describe('with --include-transitive composed with other flags', () => {
    let composedProject: TmpProject;

    beforeEach(async () => {
      composedProject = await createTmpProject({
        packageJson: {
          name: 'fixture-composed',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          devDependencies: { typescript: '^5.2.0' },
        },
        installed: { express: '4.18.2', typescript: '5.2.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { '@private/inner': '1.0.0' },
            },
            'node_modules/typescript': {
              version: '5.2.2',
              dependencies: { lodash: '4.17.21' },
            },
            'node_modules/@private/inner': { version: '1.0.0' },
            'node_modules/lodash': { version: '4.17.21' },
          },
        },
      });
    });

    afterEach(async () => {
      await composedProject.cleanup();
    });

    it('--include-transitive + --ignore-scope filters private transitives', async () => {
      const result = await runCli(
        [
          '--path',
          composedProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--ignore-scope',
          '@private',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
      // express, typescript, lodash — but NOT @private/inner
      assert.deepEqual(names, ['express', 'lodash', 'typescript']);
      assert.equal(report.skipped.length, 1);
      assert.equal(report.skipped[0].name, '@private/inner');
    });

    it('--include-transitive + --prod walks only prod transitives', async () => {
      const result = await runCli(
        [
          '--path',
          composedProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--prod',
          '--ignore-scope',
          '@private',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
      // typescript (devDep) is dropped, so its transitive lodash is dropped too
      assert.deepEqual(names, ['express']);
    });

    it('--include-transitive + --fail-on major exits 2 when any transitive needs a major upgrade', async () => {
      const result = await runCli(
        [
          '--path',
          composedProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--ignore-scope',
          '@private',
          '--fail-on',
          'major',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      // express is at 4.18.2, registry has 5.0.1 → major upgrade → exit 2
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /--fail-on major/);
      assert.match(result.stderr, /express@4\.18\.2/);
    });
  });

  describe('with pnpm-lock.yaml', () => {
    let pnpmProject: TmpProject;

    beforeEach(async () => {
      pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        pnpmLock: `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
    dependencies:
      lodash: 4.17.21

  lodash@4.17.21:
    resolution: {integrity: sha512-y}
`,
      });
    });

    afterEach(async () => {
      await pnpmProject.cleanup();
    });

    it('--include-transitive walks pnpm-lock.yaml when no other lockfile is present', async () => {
      const result = await runCli(
        [
          '--path',
          pnpmProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
      assert.deepEqual(names, ['express', 'lodash']);
      const lodash = report.dependencies.find((d: { name: string }) => d.name === 'lodash');
      assert.equal(lodash.transitive, true);
    });

    it('renders ↳ prefix for pnpm-sourced transitives in table format', async () => {
      const result = await runCli(
        [
          '--path',
          pnpmProject.packageJsonPath,
          '--format',
          'table',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /↳ lodash/);
    });

    it('three-way conflict warning lists all and uses npm', async () => {
      const allThreeProject = await createTmpProject({
        packageJson: {
          name: 'fixture-all-three',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { lodash: '4.17.21' },
            },
            'node_modules/lodash': { version: '4.17.21' },
          },
        },
        pnpmLock: `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
    dependencies:
      typescript: 5.0.0

  typescript@5.0.0:
    resolution: {integrity: sha512-y}
`,
        yarnLock: `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    yarn-only-child: "npm:1.0.0"
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            allThreeProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(
          result.stderr,
          /Warning: multiple lockfiles found \(package-lock\.json, pnpm-lock\.yaml, yarn\.lock\); using package-lock\.json, ignoring pnpm-lock\.yaml, yarn\.lock\./,
        );
        const report = JSON.parse(result.stdout);
        const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
        // npm wins: express + lodash. NOT typescript (pnpm) or yarn-only-child (yarn).
        assert.deepEqual(names, ['express', 'lodash']);
      } finally {
        await allThreeProject.cleanup();
      }
    });

    it('two-way conflict (pnpm + yarn): pnpm wins', async () => {
      const pnpmYarnProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-yarn',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        pnpmLock: `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
    dependencies:
      lodash: 4.17.21

  lodash@4.17.21:
    resolution: {integrity: sha512-y}
`,
        yarnLock: `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    yarn-only-child: "npm:1.0.0"
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmYarnProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(
          result.stderr,
          /Warning: multiple lockfiles found \(pnpm-lock\.yaml, yarn\.lock\); using pnpm-lock\.yaml, ignoring yarn\.lock\./,
        );
        const report = JSON.parse(result.stdout);
        const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
        // pnpm wins → lodash, not yarn-only-child
        assert.deepEqual(names, ['express', 'lodash']);
      } finally {
        await pnpmYarnProject.cleanup();
      }
    });

    it('falls back gracefully when pnpm-lock.yaml is malformed (treated as no lockfile)', async () => {
      const malformedProject = await createTmpProject({
        packageJson: {
          name: 'fixture-malformed-pnpm',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        // Missing lockfileVersion → loadPnpmLock returns null
        pnpmLock: 'this is not a valid pnpm-lock.yaml\n',
      });
      try {
        const result = await runCli(
          [
            '--path',
            malformedProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        // Only the direct dep; no crash from the parser
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
      } finally {
        await malformedProject.cleanup();
      }
    });

    it('two-way conflict (npm + pnpm): npm wins', async () => {
      const npmPnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-npm-pnpm',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        // npm lock says express has lodash as a child
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { lodash: '4.17.21' },
            },
            'node_modules/lodash': { version: '4.17.21' },
          },
        },
        // pnpm lock would have a different child — should be ignored
        pnpmLock: `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
    dependencies:
      typescript: 5.0.0

  typescript@5.0.0:
    resolution: {integrity: sha512-y}
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            npmPnpmProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(
          result.stderr,
          /Warning: multiple lockfiles found \(package-lock\.json, pnpm-lock\.yaml\); using package-lock\.json, ignoring pnpm-lock\.yaml\./,
        );
        const report = JSON.parse(result.stdout);
        const names = report.dependencies.map((d: { name: string }) => d.name).toSorted();
        // npm wins: lodash, NOT typescript
        assert.deepEqual(names, ['express', 'lodash']);
      } finally {
        await npmPnpmProject.cleanup();
      }
    });

    it('--include-transitive + --fail-on major exits 2 with a pnpm fixture', async () => {
      const result = await runCli(
        [
          '--path',
          pnpmProject.packageJsonPath,
          '--format',
          'json',
          '--include-transitive',
          '--fail-on',
          'major',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      // express 4.18.2 → registry mock has 5.0.1 → major upgrade → exit 2
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /--fail-on major/);
    });

    it('renders ↳ prefix for pnpm-sourced transitives in markdown format', async () => {
      const result = await runCli(
        [
          '--path',
          pnpmProject.packageJsonPath,
          '--format',
          'markdown',
          '--include-transitive',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /\| ↳ lodash \|/);
    });

    it('--include-transitive + --ignore-scope filters pnpm-sourced private transitives', async () => {
      const pnpmPrivateProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-private',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        pnpmLock: `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
    dependencies:
      '@private/inner': 1.0.0

  '@private/inner@1.0.0':
    resolution: {integrity: sha512-y}
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmPrivateProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--ignore-scope',
            '@private',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(
          report.dependencies.map((d: { name: string }) => d.name),
          ['express'],
        );
        assert.equal(report.skipped.length, 1);
        assert.equal(report.skipped[0].name, '@private/inner');
      } finally {
        await pnpmPrivateProject.cleanup();
      }
    });

    it('--include-transitive + --prod walks only prod transitives (pnpm)', async () => {
      const pnpmMixedProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-mixed',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          devDependencies: { typescript: '^5.2.0' },
        },
        installed: { express: '4.18.2', typescript: '5.2.2' },
        pnpmLock: `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}

  typescript@5.2.2:
    resolution: {integrity: sha512-y}
    dependencies:
      lodash: 4.17.21

  lodash@4.17.21:
    resolution: {integrity: sha512-z}
`,
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmMixedProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--prod',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        // typescript is dev → dropped → its transitive lodash also dropped
        assert.deepEqual(
          report.dependencies.map((d: { name: string }) => d.name),
          ['express'],
        );
      } finally {
        await pnpmMixedProject.cleanup();
      }
    });
  });

  describe('with --update', () => {
    let updateProject: TmpProject;

    beforeEach(async () => {
      updateProject = await createTmpProject({
        packageJson: {
          name: 'fixture-update',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0',
            lodash: '4.17.21',
          },
          devDependencies: {
            typescript: '^5.2.0',
          },
        },
        installed: {
          express: '4.18.2',
          lodash: '4.17.21',
          typescript: '5.2.2',
        },
      });
    });

    afterEach(async () => {
      await updateProject.cleanup();
    });

    async function readPkg(): Promise<Record<string, unknown>> {
      const raw = await readFile(updateProject.packageJsonPath, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    }

    it('--update minor --dry-run previews changes without writing', async () => {
      const before = await readFile(updateProject.packageJsonPath, 'utf8');
      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'minor',
          '--dry-run',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Would apply \d+ update\(s\) at level "minor"/);
      const after = await readFile(updateProject.packageJsonPath, 'utf8');
      assert.equal(before, after);
    });

    it('--update minor rewrites package.json with the latest minor versions', async () => {
      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'minor',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Updated \d+ dep\(s\)/);
      const pkg = await readPkg();
      const deps = pkg.dependencies as Record<string, string>;
      const dev = pkg.devDependencies as Record<string, string>;
      // express minor (4.18.0 → 4.21.0), preserves caret
      assert.equal(deps.express, '^4.21.0');
      // lodash up-to-date → unchanged
      assert.equal(deps.lodash, '4.17.21');
      // typescript minor (5.2.0 → 5.3.3), preserves caret
      assert.equal(dev.typescript, '^5.3.3');
    });

    it('--update minor leaves majors-only deps untouched', async () => {
      // Build a fixture where express has only a major upgrade available.
      // The existing fixture has both 4.21.0 (minor) and 5.0.1 (major), so
      // here we instead exercise: --update minor moves express to 4.21.0,
      // not to 5.0.1 — we already verify that above. Reusing.
      // This is a regression guard documenting the rule.
      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'minor',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const pkg = await readPkg();
      const deps = pkg.dependencies as Record<string, string>;
      // Did NOT cross the major boundary.
      assert.notEqual(deps.express, '^5.0.1');
    });

    it('--update major upgrades across the major boundary', async () => {
      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'major',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const pkg = await readPkg();
      const deps = pkg.dependencies as Record<string, string>;
      assert.equal(deps.express, '^5.0.1');
    });

    it('--update all behaves like --update major (alias)', async () => {
      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'all',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Updated \d+ dep\(s\) in package\.json at level "all"/);
      const pkg = await readPkg();
      const deps = pkg.dependencies as Record<string, string>;
      assert.equal(deps.express, '^5.0.1');
    });

    it('--update minor --prod only writes prod deps', async () => {
      const before = JSON.parse(
        await readFile(updateProject.packageJsonPath, 'utf8'),
      ) as { devDependencies: Record<string, string> };
      const originalTs = before.devDependencies.typescript;

      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'minor',
          '--prod',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const pkg = await readPkg();
      const dev = pkg.devDependencies as Record<string, string>;
      // typescript was filtered out by --prod, so it stays
      assert.equal(dev.typescript, originalTs);
    });

    it('--update minor + --fail-on major exits 2 without writing', async () => {
      const before = await readFile(updateProject.packageJsonPath, 'utf8');
      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'minor',
          '--fail-on',
          'major',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 2);
      const after = await readFile(updateProject.packageJsonPath, 'utf8');
      assert.equal(before, after);
    });

    it('--update minor on an already-up-to-date project is a no-op', async () => {
      const cleanProject = await createTmpProject({
        packageJson: {
          name: 'fixture-clean',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const before = await readFile(cleanProject.packageJsonPath, 'utf8');
        const result = await runCli(
          [
            '--path',
            cleanProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /No updates to apply at level "minor"/);
        const after = await readFile(cleanProject.packageJsonPath, 'utf8');
        assert.equal(before, after);
      } finally {
        await cleanProject.cleanup();
      }
    });

    it('preserves 4-space indent when rewriting', async () => {
      const fourSpaceProject = await createTmpProject({
        packageJson: {},
        installed: { express: '4.18.2' },
      });
      try {
        await writeFile(
          fourSpaceProject.packageJsonPath,
          JSON.stringify(
            { name: 'demo', dependencies: { express: '^4.18.0' } },
            null,
            4,
          ),
        );
        const result = await runCli(
          [
            '--path',
            fourSpaceProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const written = await readFile(fourSpaceProject.packageJsonPath, 'utf8');
        // 4-space indent × 2 nesting levels for the dependency entry
        assert.match(written, /\n {8}"express"/);
      } finally {
        await fourSpaceProject.cleanup();
      }
    });

    it('warns when --dry-run is used without --update', async () => {
      const result = await runCli(
        ['--path', updateProject.packageJsonPath, '--format', 'json', '--dry-run', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stderr, /--dry-run requires --update; ignored/);
    });

    it('--update minor --only express writes only the matching dep', async () => {
      const before = JSON.parse(
        await readFile(updateProject.packageJsonPath, 'utf8'),
      ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
      const originalTypescript = before.devDependencies.typescript;

      const result = await runCli(
        [
          '--path',
          updateProject.packageJsonPath,
          '--format',
          'json',
          '--update',
          'minor',
          '--only',
          'express',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const pkg = await readPkg();
      const deps = pkg.dependencies as Record<string, string>;
      const dev = pkg.devDependencies as Record<string, string>;
      // express was upgraded
      assert.equal(deps.express, '^4.21.0');
      // typescript was filtered out by --only, so it stays
      assert.equal(dev.typescript, originalTypescript);
    });

    it('--update minor --ignore-scope skips matching deps even if upgrades exist', async () => {
      const privateProject = await createTmpProject({
        packageJson: {
          name: 'fixture-private-update',
          version: '1.0.0',
          dependencies: {
            '@private/foo': '1.0.0',
            express: '^4.18.0',
          },
        },
        installed: { '@private/foo': '1.0.0', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            privateProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--ignore-scope',
            '@private',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const raw = await readFile(privateProject.packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw) as { dependencies: Record<string, string> };
        // express was upgraded
        assert.equal(pkg.dependencies.express, '^4.21.0');
        // @private/foo stays — ignore-scope kept it out of analysis
        assert.equal(pkg.dependencies['@private/foo'], '1.0.0');
      } finally {
        await privateProject.cleanup();
      }
    });

    it('--update minor --include-transitive does NOT write transitives to package.json', async () => {
      const lockProject = await createTmpProject({
        packageJson: {
          name: 'fixture-update-transitive',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { lodash: '4.17.21' },
            },
            'node_modules/lodash': { version: '4.17.21' },
          },
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            lockProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const raw = await readFile(lockProject.packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const deps = pkg.dependencies as Record<string, string>;
        // express (direct) gets bumped
        assert.equal(deps.express, '^4.21.0');
        // lodash (transitive) was analyzed but NOT added to package.json
        assert.ok(!('lodash' in deps), 'transitive deps must not be written to package.json');
        const top = pkg as { devDependencies?: unknown; dependencies?: unknown };
        assert.equal(top.devDependencies, undefined);
      } finally {
        await lockProject.cleanup();
      }
    });

    it('--update minor with no filter rewrites prod, dev, and peer buckets together', async () => {
      const multiBucket = await createTmpProject({
        packageJson: {
          name: 'fixture-multi-bucket',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          devDependencies: { typescript: '^5.2.0' },
          peerDependencies: { lodash: '^4.17.0' },
        },
        installed: {
          express: '4.18.2',
          typescript: '5.2.2',
          lodash: '4.17.21',
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            multiBucket.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const raw = await readFile(multiBucket.packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw) as {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
          peerDependencies: Record<string, string>;
        };
        assert.equal(pkg.dependencies.express, '^4.21.0');
        assert.equal(pkg.devDependencies.typescript, '^5.3.3');
        // lodash is up-to-date in the mock registry → spec stays unchanged
        assert.equal(pkg.peerDependencies.lodash, '^4.17.0');
      } finally {
        await multiBucket.cleanup();
      }
    });

    it('preserves a tab indent when rewriting', async () => {
      const tabProject = await createTmpProject({
        packageJson: {},
        installed: { express: '4.18.2' },
      });
      try {
        // Write with tabs manually
        await writeFile(
          tabProject.packageJsonPath,
          JSON.stringify(
            { name: 'demo', dependencies: { express: '^4.18.0' } },
            null,
            '\t',
          ),
        );
        const result = await runCli(
          [
            '--path',
            tabProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const written = await readFile(tabProject.packageJsonPath, 'utf8');
        // express line is nested 2 levels → 2 tabs
        assert.match(written, /\n\t\t"express"/);
      } finally {
        await tabProject.cleanup();
      }
    });

    it('preserves the absence of a trailing newline', async () => {
      const noNewlineProject = await createTmpProject({
        packageJson: {},
        installed: { express: '4.18.2' },
      });
      try {
        // JSON.stringify produces no trailing newline; the helper would add one
        // through JSON.stringify(..., null, 2), so we write it directly to be sure.
        await writeFile(
          noNewlineProject.packageJsonPath,
          JSON.stringify(
            { name: 'demo', dependencies: { express: '^4.18.0' } },
            null,
            2,
          ),
          'utf8',
        );
        const result = await runCli(
          [
            '--path',
            noNewlineProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const written = await readFile(noNewlineProject.packageJsonPath, 'utf8');
        assert.ok(!written.endsWith('\n'), 'trailing newline should be absent');
      } finally {
        await noNewlineProject.cleanup();
      }
    });

    it('preserves ~, >=, and exact-pin range markers across an upgrade', async () => {
      const markersProject = await createTmpProject({
        packageJson: {
          name: 'fixture-markers',
          version: '1.0.0',
          dependencies: {
            // Three different range styles for three deps
            'tilde-dep': '~4.18.0',
            'gte-dep': '>=4.18.0',
            'exact-dep': '4.18.0',
          },
        },
        installed: {
          'tilde-dep': '4.18.2',
          'gte-dep': '4.18.2',
          'exact-dep': '4.18.2',
        },
      });
      // Reuse the existing express mock by aliasing — register the three names
      // against the same versions/time so they all have a 4.21.0 minor.
      const aliasRegistry = await startMockRegistry([
        {
          name: 'tilde-dep',
          versions: { '4.18.2': { version: '4.18.2' }, '4.21.0': { version: '4.21.0' } },
          time: { '4.18.2': '2025-09-15T00:00:00Z', '4.21.0': '2026-02-01T00:00:00Z' },
        },
        {
          name: 'gte-dep',
          versions: { '4.18.2': { version: '4.18.2' }, '4.21.0': { version: '4.21.0' } },
          time: { '4.18.2': '2025-09-15T00:00:00Z', '4.21.0': '2026-02-01T00:00:00Z' },
        },
        {
          name: 'exact-dep',
          versions: { '4.18.2': { version: '4.18.2' }, '4.21.0': { version: '4.21.0' } },
          time: { '4.18.2': '2025-09-15T00:00:00Z', '4.21.0': '2026-02-01T00:00:00Z' },
        },
      ]);
      try {
        const result = await runCli(
          [
            '--path',
            markersProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: aliasRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const raw = await readFile(markersProject.packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw) as { dependencies: Record<string, string> };
        assert.equal(pkg.dependencies['tilde-dep'], '~4.21.0');
        assert.equal(pkg.dependencies['gte-dep'], '>=4.21.0');
        assert.equal(pkg.dependencies['exact-dep'], '4.21.0');
      } finally {
        await markersProject.cleanup();
        await aliasRegistry.close();
      }
    });
  });

  describe('with --update patch', () => {
    it('--update patch rewrites only the patch upgrade, leaving minor-eligible deps alone', async () => {
      const patchRegistry = await startPatchRegistry();
      const patchProject = await createTmpProject({
        packageJson: {
          name: 'fixture-update-patch',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0',
            lodash: '^4.17.20',
          },
          devDependencies: { typescript: '^5.2.0' },
        },
        installed: {
          express: '4.18.2',
          lodash: '4.17.20',
          typescript: '5.2.2',
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            patchProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'patch',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: patchRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const raw = await readFile(patchProject.packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw) as {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        };
        assert.equal(pkg.dependencies.express, '^4.18.5');
        assert.equal(pkg.dependencies.lodash, '^4.17.21');
        // typescript has no patch upgrade — left alone
        assert.equal(pkg.devDependencies.typescript, '^5.2.0');
      } finally {
        await patchProject.cleanup();
        await patchRegistry.close();
      }
    });

    it('--update patch --dry-run previews the patch bump without writing', async () => {
      const patchRegistry = await startPatchRegistry();
      const patchProject = await createTmpProject({
        packageJson: {
          name: 'fixture-update-patch-dry',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const before = await readFile(patchProject.packageJsonPath, 'utf8');
        const result = await runCli(
          [
            '--path',
            patchProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'patch',
            '--dry-run',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: patchRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /Would apply 1 update\(s\) at level "patch"/);
        const after = await readFile(patchProject.packageJsonPath, 'utf8');
        assert.equal(before, after);
      } finally {
        await patchProject.cleanup();
        await patchRegistry.close();
      }
    });

    it('--update minor falls back to a patch bump when no minor exists', async () => {
      const patchOnlyRegistry = await startMockRegistry([
        {
          name: 'patch-only',
          versions: {
            '1.2.3': { version: '1.2.3' },
            '1.2.9': { version: '1.2.9' },
          },
          time: {
            '1.2.3': '2026-01-01T00:00:00Z',
            '1.2.9': '2026-02-01T00:00:00Z',
          },
        },
      ]);
      const patchProject = await createTmpProject({
        packageJson: {
          name: 'fixture-fallback',
          version: '1.0.0',
          dependencies: { 'patch-only': '^1.2.3' },
        },
        installed: { 'patch-only': '1.2.3' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            patchProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: patchOnlyRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const raw = await readFile(patchProject.packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw) as { dependencies: Record<string, string> };
        assert.equal(pkg.dependencies['patch-only'], '^1.2.9');
      } finally {
        await patchProject.cleanup();
        await patchOnlyRegistry.close();
      }
    });

    it('--fail-on patch exits 2 when a dep has only a patch upgrade available', async () => {
      const patchOnlyRegistry = await startMockRegistry([
        {
          name: 'patch-only',
          versions: {
            '1.2.3': { version: '1.2.3' },
            '1.2.9': { version: '1.2.9' },
          },
          time: {
            '1.2.3': '2026-01-01T00:00:00Z',
            '1.2.9': '2026-02-01T00:00:00Z',
          },
        },
      ]);
      const patchProject = await createTmpProject({
        packageJson: {
          name: 'fixture-fail-on-patch',
          version: '1.0.0',
          dependencies: { 'patch-only': '^1.2.3' },
        },
        installed: { 'patch-only': '1.2.3' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            patchProject.packageJsonPath,
            '--format',
            'json',
            '--fail-on',
            'patch',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: patchOnlyRegistry.url },
        );
        assert.equal(result.exitCode, 2);
        assert.match(result.stderr, /--fail-on patch/);
        assert.match(result.stderr, /patch-only@1\.2\.3/);
      } finally {
        await patchProject.cleanup();
        await patchOnlyRegistry.close();
      }
    });

    it('--fail-on minor does NOT trip on patch-only deps (regression for the patch tier)', async () => {
      const patchOnlyRegistry = await startMockRegistry([
        {
          name: 'patch-only',
          versions: {
            '1.2.3': { version: '1.2.3' },
            '1.2.9': { version: '1.2.9' },
          },
          time: {
            '1.2.3': '2026-01-01T00:00:00Z',
            '1.2.9': '2026-02-01T00:00:00Z',
          },
        },
      ]);
      const patchProject = await createTmpProject({
        packageJson: {
          name: 'fixture-fail-on-minor-regression',
          version: '1.0.0',
          dependencies: { 'patch-only': '^1.2.3' },
        },
        installed: { 'patch-only': '1.2.3' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            patchProject.packageJsonPath,
            '--format',
            'json',
            '--fail-on',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: patchOnlyRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
      } finally {
        await patchProject.cleanup();
        await patchOnlyRegistry.close();
      }
    });
  });

  describe('with overrides', () => {
    it('analyzes top-level overrides as their own bucket', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'overrides');
        assert.equal(express.current.version, '4.18.2');
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('surfaces path-specific overrides in the skipped block', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-path',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { foo: { bar: '1.0.0' } },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        assert.deepEqual(report.skipped, [
          { name: 'foo', type: 'overrides', reason: 'override-path-specific' },
        ]);

        const tableResult = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(tableResult.stdout, /path-specific override\(s\): foo/);
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('surfaces reference overrides ($name) in the skipped block', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-ref',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { baz: '$lodash' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        assert.deepEqual(report.skipped, [
          { name: 'baz', type: 'overrides', reason: 'override-reference' },
        ]);

        const tableResult = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(tableResult.stdout, /reference override\(s\).*baz/);
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('analyzes the "." key when present alongside path-specific siblings', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-dot',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { express: { '.': '4.18.2', other: '1.0.0' } },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'overrides');
        assert.equal(express.current.version, '4.18.2');
        assert.deepEqual(report.skipped, []);
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('--update minor leaves the overrides block byte-identical', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-noupdate',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          overrides: { express: '4.18.2' },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const before = JSON.parse(
          await readFile(overrideProject.packageJsonPath, 'utf8'),
        ) as { overrides: Record<string, string> };
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const after = JSON.parse(
          await readFile(overrideProject.packageJsonPath, 'utf8'),
        ) as { dependencies: Record<string, string>; overrides: Record<string, string> };
        // dependencies bumped, overrides untouched
        assert.equal(after.dependencies.express, '^4.21.0');
        assert.deepEqual(after.overrides, before.overrides);
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('--overrides flag scopes the report to overrides only', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-only',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--overrides',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
        assert.equal(report.dependencies[0].type, 'overrides');
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('--ignore-scope skips scoped overrides with reason "ignored-scope"', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-ignore-scope',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { '@private/pinned': '1.0.0' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--ignore-scope',
            '@private',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(
          report.dependencies.map((d: { name: string }) => d.name),
          ['lodash'],
        );
        assert.deepEqual(report.skipped, [
          {
            name: '@private/pinned',
            type: 'overrides',
            reason: 'ignored-scope',
            scope: '@private',
          },
        ]);
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('--only filters overrides like any other bucket', async () => {
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-only-filter',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--only',
            'express',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
        assert.equal(report.dependencies[0].type, 'overrides');
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('--include-transitive does not expand overrides via the lockfile', async () => {
      // The lockfile says express has body-parser as a dependency. If overrides
      // were expansion roots, body-parser would appear; it must not.
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-transitive',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          overrides: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/lodash': { version: '4.17.21' },
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { 'body-parser': '1.20.0' },
            },
            'node_modules/body-parser': { version: '1.20.0' },
          },
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const names = report.dependencies
          .map((d: { name: string }) => d.name)
          .toSorted();
        assert.deepEqual(names, ['express', 'lodash']);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'overrides');
        assert.equal(express.transitive, false);
      } finally {
        await overrideProject.cleanup();
      }
    });

    it('--fail-on minor exits 2 when a stale override has a minor upgrade', async () => {
      // express 4.18.2 has 4.21.0 minor available in the mock registry.
      const overrideProject = await createTmpProject({
        packageJson: {
          name: 'fixture-overrides-fail-on',
          version: '1.0.0',
          overrides: { express: '4.18.2' },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            overrideProject.packageJsonPath,
            '--format',
            'json',
            '--fail-on',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 2);
        assert.match(result.stderr, /express@4\.18\.2/);
      } finally {
        await overrideProject.cleanup();
      }
    });
  });

  describe('with resolutions', () => {
    it('analyzes top-level yarn resolutions as their own bucket', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resolutions',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          resolutions: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'resolutions');
        assert.equal(express.current.version, '4.18.2');
      } finally {
        await resolProject.cleanup();
      }
    });

    it('surfaces parent/child path-specific resolutions in the skipped block', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-path',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          resolutions: { 'webpack/memory-fs': '0.4.1' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        assert.deepEqual(report.skipped, [
          {
            name: 'webpack/memory-fs',
            type: 'resolutions',
            reason: 'override-path-specific',
          },
        ]);

        const tableResult = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(
          tableResult.stdout,
          /path-specific override\(s\): webpack\/memory-fs/,
        );
      } finally {
        await resolProject.cleanup();
      }
    });

    it('surfaces npm: descriptor resolutions as override-descriptor', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-descriptor',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          resolutions: { aliased: 'npm:foo@1.0.0' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        assert.deepEqual(report.skipped, [
          { name: 'aliased', type: 'resolutions', reason: 'override-descriptor' },
        ]);

        const tableResult = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(tableResult.stdout, /non-semver pin\(s\).*aliased/);
      } finally {
        await resolProject.cleanup();
      }
    });

    it('--update minor leaves the resolutions block byte-identical', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-noupdate',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          resolutions: { express: '4.18.2' },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const before = JSON.parse(
          await readFile(resolProject.packageJsonPath, 'utf8'),
        ) as { resolutions: Record<string, string> };
        const result = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const after = JSON.parse(
          await readFile(resolProject.packageJsonPath, 'utf8'),
        ) as { dependencies: Record<string, string>; resolutions: Record<string, string> };
        assert.equal(after.dependencies.express, '^4.21.0');
        assert.deepEqual(after.resolutions, before.resolutions);
      } finally {
        await resolProject.cleanup();
      }
    });

    it('--resolutions flag scopes the report to resolutions only', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-only',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          resolutions: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--resolutions',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
        assert.equal(report.dependencies[0].type, 'resolutions');
      } finally {
        await resolProject.cleanup();
      }
    });

    it('--ignore-scope skips scoped resolutions with reason "ignored-scope"', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-ignore-scope',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          resolutions: { '@private/pinned': '1.0.0' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--ignore-scope',
            '@private',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(
          report.dependencies.map((d: { name: string }) => d.name),
          ['lodash'],
        );
        assert.deepEqual(report.skipped, [
          {
            name: '@private/pinned',
            type: 'resolutions',
            reason: 'ignored-scope',
            scope: '@private',
          },
        ]);
      } finally {
        await resolProject.cleanup();
      }
    });

    it('--include-transitive does not expand resolutions via the lockfile', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-transitive',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          resolutions: { express: '4.18.2' },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/lodash': { version: '4.17.21' },
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { 'body-parser': '1.20.0' },
            },
            'node_modules/body-parser': { version: '1.20.0' },
          },
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const names = report.dependencies
          .map((d: { name: string }) => d.name)
          .toSorted();
        assert.deepEqual(names, ['express', 'lodash']);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'resolutions');
        assert.equal(express.transitive, false);
      } finally {
        await resolProject.cleanup();
      }
    });

    it('--fail-on minor exits 2 when a stale resolution has a minor upgrade', async () => {
      const resolProject = await createTmpProject({
        packageJson: {
          name: 'fixture-resol-fail-on',
          version: '1.0.0',
          resolutions: { express: '4.18.2' },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            resolProject.packageJsonPath,
            '--format',
            'json',
            '--fail-on',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 2);
        assert.match(result.stderr, /express@4\.18\.2/);
      } finally {
        await resolProject.cleanup();
      }
    });
  });

  describe('with pnpm overrides', () => {
    it('analyzes top-level pnpm.overrides as their own bucket', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-overrides',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { express: '4.18.2' } },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'pnpm.overrides');
        assert.equal(express.current.version, '4.18.2');
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('surfaces parent>child path-specific pnpm overrides in the skipped block', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-path',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { 'foo>bar': '1.0.0' } },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        assert.deepEqual(report.skipped, [
          {
            name: 'foo>bar',
            type: 'pnpm.overrides',
            reason: 'override-path-specific',
          },
        ]);

        const tableResult = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(tableResult.stdout, /path-specific override\(s\): foo>bar/);
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('surfaces npm: descriptor pnpm overrides as override-descriptor', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-descriptor',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { aliased: 'npm:foo@1.0.0' } },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report.skipped, [
          { name: 'aliased', type: 'pnpm.overrides', reason: 'override-descriptor' },
        ]);
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('surfaces catalog: references as catalog in skipped list and CLI message', async () => {
      const catalogProject = await createTmpProject({
        packageJson: {
          name: 'fixture-catalog-ref',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          devDependencies: { typescript: 'catalog:', '@types/node': 'catalog:tooling' },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            catalogProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        const catalogSkipped = report.skipped.filter(
          (s: { reason: string }) => s.reason === 'catalog',
        );
        assert.equal(catalogSkipped.length, 2);

        const tableResult = await runCli(
          [
            '--path',
            catalogProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(
          tableResult.stdout,
          /pnpm catalog reference\(s\).*typescript/,
        );
      } finally {
        await catalogProject.cleanup();
      }
    });

    it('surfaces a "-" pnpm override as override-removal', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-removal',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { 'removed-dep': '-' } },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const jsonResult = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(jsonResult.exitCode, 0, jsonResult.stderr);
        const report = JSON.parse(jsonResult.stdout);
        assert.deepEqual(report.skipped, [
          { name: 'removed-dep', type: 'pnpm.overrides', reason: 'override-removal' },
        ]);

        const tableResult = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(tableResult.exitCode, 0, tableResult.stderr);
        assert.match(tableResult.stdout, /removal pin\(s\).*removed-dep/);
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('surfaces a "$name" pnpm override as override-reference', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-ref',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { 'ref-dep': '$lodash' } },
        },
        installed: { lodash: '4.17.21' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report.skipped, [
          { name: 'ref-dep', type: 'pnpm.overrides', reason: 'override-reference' },
        ]);
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('--update minor leaves the pnpm.overrides block byte-identical', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-noupdate',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          pnpm: { overrides: { express: '4.18.2' } },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const before = JSON.parse(
          await readFile(pnpmProject.packageJsonPath, 'utf8'),
        ) as { pnpm: { overrides: Record<string, string> } };
        const result = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const after = JSON.parse(
          await readFile(pnpmProject.packageJsonPath, 'utf8'),
        ) as {
          dependencies: Record<string, string>;
          pnpm: { overrides: Record<string, string> };
        };
        assert.equal(after.dependencies.express, '^4.21.0');
        assert.deepEqual(after.pnpm.overrides, before.pnpm.overrides);
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('--pnpm-overrides flag scopes the report to pnpm.overrides only', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-only',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { express: '4.18.2' } },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--pnpm-overrides',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.dependencies.length, 1);
        assert.equal(report.dependencies[0].name, 'express');
        assert.equal(report.dependencies[0].type, 'pnpm.overrides');
      } finally {
        await pnpmProject.cleanup();
      }
    });

    it('--include-transitive does not expand pnpm.overrides via the lockfile', async () => {
      const pnpmProject = await createTmpProject({
        packageJson: {
          name: 'fixture-pnpm-transitive',
          version: '1.0.0',
          dependencies: { lodash: '4.17.21' },
          pnpm: { overrides: { express: '4.18.2' } },
        },
        installed: { lodash: '4.17.21', express: '4.18.2' },
        packageLock: {
          lockfileVersion: 3,
          packages: {
            'node_modules/lodash': { version: '4.17.21' },
            'node_modules/express': {
              version: '4.18.2',
              dependencies: { 'body-parser': '1.20.0' },
            },
            'node_modules/body-parser': { version: '1.20.0' },
          },
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            pnpmProject.packageJsonPath,
            '--format',
            'json',
            '--include-transitive',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const names = report.dependencies
          .map((d: { name: string }) => d.name)
          .toSorted();
        assert.deepEqual(names, ['express', 'lodash']);
        const express = report.dependencies.find(
          (d: { name: string }) => d.name === 'express',
        );
        assert.equal(express.type, 'pnpm.overrides');
        assert.equal(express.transitive, false);
      } finally {
        await pnpmProject.cleanup();
      }
    });
  });

  describe('with mixed pin sources', () => {
    it('audits dependencies, overrides, resolutions, and pnpm.overrides together; --update leaves all three pin buckets byte-identical', async () => {
      const mixedProject = await createTmpProject({
        packageJson: {
          name: 'fixture-mixed',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
          overrides: { lodash: '4.17.21' },
          resolutions: { typescript: '5.2.2' },
          pnpm: { overrides: { express: '4.18.2' } },
        },
        installed: {
          express: '4.18.2',
          lodash: '4.17.21',
          typescript: '5.2.2',
        },
      });
      try {
        const before = JSON.parse(
          await readFile(mixedProject.packageJsonPath, 'utf8'),
        ) as {
          overrides: Record<string, string>;
          resolutions: Record<string, string>;
          pnpm: { overrides: Record<string, string> };
        };
        // First pass: read-only JSON to verify all four pin sources show up.
        const reportResult = await runCli(
          [
            '--path',
            mixedProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(reportResult.exitCode, 0, reportResult.stderr);
        const report = JSON.parse(reportResult.stdout);
        const keys = new Set(
          (report.dependencies as Array<{ name: string; type: string }>).map(
            (d) => `${d.type}:${d.name}`,
          ),
        );
        assert.ok(keys.has('dependencies:express'));
        assert.ok(keys.has('overrides:lodash'));
        assert.ok(keys.has('resolutions:typescript'));
        assert.ok(keys.has('pnpm.overrides:express'));

        // Second pass: --update minor and verify pin buckets byte-identical.
        const updateResult = await runCli(
          [
            '--path',
            mixedProject.packageJsonPath,
            '--update',
            'minor',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
        );
        assert.equal(updateResult.exitCode, 0, updateResult.stderr);
        const after = JSON.parse(
          await readFile(mixedProject.packageJsonPath, 'utf8'),
        ) as {
          dependencies: Record<string, string>;
          overrides: Record<string, string>;
          resolutions: Record<string, string>;
          pnpm: { overrides: Record<string, string> };
        };
        assert.equal(after.dependencies.express, '^4.21.0');
        assert.deepEqual(after.overrides, before.overrides);
        assert.deepEqual(after.resolutions, before.resolutions);
        assert.deepEqual(after.pnpm.overrides, before.pnpm.overrides);
      } finally {
        await mixedProject.cleanup();
      }
    });
  });

  describe('with private-scope packages', () => {
    let privateRegistry: MockRegistry;
    let privateProject: TmpProject;

    beforeEach(async () => {
      privateRegistry = await startMockRegistry([
        {
          name: 'express',
          versions: {
            '4.18.2': { version: '4.18.2' },
            '4.21.0': { version: '4.21.0' },
          },
          time: {
            '4.18.2': '2025-09-15T00:00:00Z',
            '4.21.0': '2026-02-01T00:00:00Z',
          },
        },
        {
          name: '@private/foo',
          versions: {},
          time: {},
          status: 403,
        },
      ]);
      privateProject = await createTmpProject({
        packageJson: {
          name: 'fixture-private',
          version: '1.0.0',
          dependencies: {
            '@private/foo': '1.0.0',
            express: '^4.18.0',
          },
        },
        installed: {
          '@private/foo': '1.0.0',
          express: '4.18.2',
        },
      });
    });

    afterEach(async () => {
      await privateRegistry.close();
      await privateProject.cleanup();
    });

    it('skips a 403 package and continues analyzing the rest (JSON)', async () => {
      const result = await runCli(
        [
          '--path',
          privateProject.packageJsonPath,
          '--format',
          'json',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: privateRegistry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.dependencies.length, 1);
      assert.equal(report.dependencies[0].name, 'express');
      assert.deepEqual(report.skipped, [
        {
          name: '@private/foo',
          type: 'dependencies',
          reason: 'registry-unauthorized',
          status: 403,
        },
      ]);
    });

    it('appends the skippedSummary line below the table for a 403 package', async () => {
      const result = await runCli(
        [
          '--path',
          privateProject.packageJsonPath,
          '--format',
          'table',
          '--no-cache',
        ],
        { DEPENDENCY_GUARD_REGISTRY_URL: privateRegistry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /express/);
      assert.match(
        result.stdout,
        /Skipped 1 package\(s\) — registry returned 401\/403 \(unauthorized; private scope\?\): @private\/foo \(403\)/,
      );
    });

    it('skips a 404 package and surfaces it as "registry returned 404 (not found)"', async () => {
      const notFoundProject = await createTmpProject({
        packageJson: {
          name: 'fixture-404',
          version: '1.0.0',
          dependencies: {
            'totally-not-a-real-package': '1.0.0',
            express: '^4.18.0',
          },
        },
        installed: {
          'totally-not-a-real-package': '1.0.0',
          express: '4.18.2',
        },
      });
      try {
        const result = await runCli(
          [
            '--path',
            notFoundProject.packageJsonPath,
            '--format',
            'table',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: privateRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /express/);
        assert.match(
          result.stdout,
          /Skipped 1 package\(s\) — registry returned 404 \(not found\): totally-not-a-real-package/,
        );
      } finally {
        await notFoundProject.cleanup();
      }
    });

    it('still exits 1 when the registry returns 500 (not silently swallowed)', async () => {
      const flakyRegistry = await startMockRegistry([
        {
          name: 'express',
          versions: {},
          time: {},
          status: 500,
        },
      ]);
      const flakyProject = await createTmpProject({
        packageJson: {
          name: 'fixture-flaky',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
      });
      try {
        const result = await runCli(
          [
            '--path',
            flakyProject.packageJsonPath,
            '--format',
            'json',
            '--no-cache',
          ],
          { DEPENDENCY_GUARD_REGISTRY_URL: flakyRegistry.url },
        );
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Failed to analyze express/);
        assert.match(result.stderr, /500/);
      } finally {
        await flakyRegistry.close();
        await flakyProject.cleanup();
      }
    });
  });

  describe('with --catalog', () => {
    it('includes catalog entries in JSON report with type catalog', async () => {
      const catalogRegistry = await startMockRegistry([
        {
          name: 'react',
          versions: { '18.0.0': { version: '18.0.0' }, '18.3.0': { version: '18.3.0' } },
          time: { '18.0.0': '2022-01-01T00:00:00Z', '18.3.0': '2024-01-01T00:00:00Z' },
        },
      ]);
      const proj = await createTmpProject({
        packageJson: { name: 'fixture-catalog', version: '1.0.0', dependencies: {} },
        pnpmWorkspace: 'catalog:\n  react: ^18.0.0\n',
      });
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--catalog', '--format', 'json', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: catalogRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const catalogDep = report.dependencies.find((d: { name: string }) => d.name === 'react');
        assert.ok(catalogDep, 'react should appear in dependencies');
        assert.equal(catalogDep.type, 'catalog');
      } finally {
        await proj.cleanup();
        await catalogRegistry.close();
      }
    });

    it('shows catalog in the Type column of table output', async () => {
      const catalogRegistry = await startMockRegistry([
        {
          name: 'react',
          versions: { '18.0.0': { version: '18.0.0' } },
          time: { '18.0.0': '2022-01-01T00:00:00Z' },
        },
      ]);
      const proj = await createTmpProject({
        packageJson: { name: 'fixture-catalog-table', version: '1.0.0', dependencies: {} },
        pnpmWorkspace: 'catalog:\n  react: 18.0.0\n',
      });
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--catalog', '--format', 'table', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: catalogRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /catalog/);
        assert.match(result.stdout, /react/);
      } finally {
        await proj.cleanup();
        await catalogRegistry.close();
      }
    });

    it('--catalog --update minor --dry-run previews without writing any file', async () => {
      const catalogRegistry = await startMockRegistry([
        {
          name: 'react',
          versions: { '18.0.0': { version: '18.0.0' }, '18.3.0': { version: '18.3.0' } },
          time: { '18.0.0': '2022-01-01T00:00:00Z', '18.3.0': '2024-01-01T00:00:00Z' },
        },
      ]);
      const originalWorkspace = 'catalog:\n  react: ^18.0.0\n';
      const proj = await createTmpProject({
        packageJson: { name: 'fixture-catalog-dryrun', version: '1.0.0', dependencies: {} },
        pnpmWorkspace: originalWorkspace,
      });
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--catalog', '--update', 'minor', '--dry-run', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: catalogRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const workspaceAfter = await readFile(join(proj.dir, 'pnpm-workspace.yaml'), 'utf8');
        assert.equal(workspaceAfter, originalWorkspace, 'workspace file should be unchanged after dry-run');
      } finally {
        await proj.cleanup();
        await catalogRegistry.close();
      }
    });

    it('--catalog --update minor rewrites pnpm-workspace.yaml and not package.json', async () => {
      const catalogRegistry = await startMockRegistry([
        {
          name: 'react',
          versions: { '18.0.0': { version: '18.0.0' }, '18.3.0': { version: '18.3.0' } },
          time: { '18.0.0': '2022-01-01T00:00:00Z', '18.3.0': '2024-01-01T00:00:00Z' },
        },
      ]);
      const proj = await createTmpProject({
        packageJson: { name: 'fixture-catalog-update', version: '1.0.0', dependencies: {} },
        pnpmWorkspace: 'catalog:\n  react: ^18.0.0\n',
      });
      try {
        const pkgBefore = await readFile(proj.packageJsonPath, 'utf8');
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--catalog', '--update', 'minor', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: catalogRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const workspaceAfter = await readFile(join(proj.dir, 'pnpm-workspace.yaml'), 'utf8');
        assert.ok(workspaceAfter.includes('^18.3.0'), `expected ^18.3.0 in workspace:\n${workspaceAfter}`);
        const pkgAfter = await readFile(proj.packageJsonPath, 'utf8');
        assert.equal(pkgAfter, pkgBefore, 'package.json should be unchanged');
      } finally {
        await proj.cleanup();
        await catalogRegistry.close();
      }
    });

    it('exits 0 with no catalog entries when pnpm-workspace.yaml is absent', async () => {
      const catalogRegistry = await startMockRegistry([]);
      const proj = await createTmpProject({
        packageJson: { name: 'fixture-no-workspace', version: '1.0.0', dependencies: {} },
      });
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--catalog', '--format', 'json', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: catalogRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.dependencies.filter((d: { type: string }) => d.type === 'catalog').length, 0);
      } finally {
        await proj.cleanup();
        await catalogRegistry.close();
      }
    });

    it('--ignore-scope filters catalog entries in the same scope', async () => {
      const catalogRegistry = await startMockRegistry([
        {
          name: 'react',
          versions: { '18.0.0': { version: '18.0.0' } },
          time: { '18.0.0': '2022-01-01T00:00:00Z' },
        },
      ]);
      const proj = await createTmpProject({
        packageJson: { name: 'fixture-catalog-scope', version: '1.0.0', dependencies: {} },
        pnpmWorkspace: 'catalog:\n  react: 18.0.0\n  \'@internal/lib\': 1.0.0\n',
      });
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--catalog', '--ignore-scope', '@internal', '--format', 'json', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: catalogRegistry.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        const names = report.dependencies.map((d: { name: string }) => d.name);
        assert.ok(!names.includes('@internal/lib'), '@internal/lib should be ignored');
        const skippedNames = report.skipped.map((s: { name: string }) => s.name);
        assert.ok(skippedNames.includes("'@internal/lib'"), '@internal/lib should appear in skipped');
      } finally {
        await proj.cleanup();
        await catalogRegistry.close();
      }
    });
  });

  describe('minimum release age (cooldown)', () => {
    async function startAgeRegistry() {
      // express: 4.21.0 published recently (within cooldown), 4.20.0 older.
      return startMockRegistry([
        {
          name: 'express',
          versions: {
            '4.18.2': { version: '4.18.2' },
            '4.20.0': { version: '4.20.0' },
            '4.21.0': { version: '4.21.0' },
          },
          time: {
            '4.18.2': daysAgo(400),
            '4.20.0': daysAgo(120),
            '4.21.0': daysAgo(2),
          },
        },
      ]);
    }

    it('holds back a fresh version and reports it via JSON', async () => {
      const reg = await startAgeRegistry();
      const proj = await createTmpProject({
        packageJson: {
          name: 'fixture-age',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
      });
      await writeFile(join(proj.dir, '.npmrc'), 'min-release-age=30\n');
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--format', 'json', '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: reg.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.releaseAge.days, 30);
        assert.equal(report.releaseAge.source, 'npm');
        const express = report.dependencies.find((d: { name: string }) => d.name === 'express');
        // 4.21.0 is 2 days old → withheld; 4.20.0 (120 days) is the chosen minor.
        assert.equal(express.latestMinor.version, '4.20.0');
        assert.ok(express.heldBack);
        assert.equal(express.heldBack.minor.version, '4.21.0');
      } finally {
        await proj.cleanup();
        await reg.close();
      }
    });

    it('--no-release-age ignores the cooldown and shows the true latest', async () => {
      const reg = await startAgeRegistry();
      const proj = await createTmpProject({
        packageJson: {
          name: 'fixture-age',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
      });
      await writeFile(join(proj.dir, '.npmrc'), 'min-release-age=30\n');
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--format', 'json', '--no-cache', '--no-release-age'],
          { DEPENDENCY_GUARD_REGISTRY_URL: reg.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.releaseAge, null);
        const express = report.dependencies.find((d: { name: string }) => d.name === 'express');
        assert.equal(express.latestMinor.version, '4.21.0');
        assert.equal(express.heldBack, null);
      } finally {
        await proj.cleanup();
        await reg.close();
      }
    });

    it('prints a cooldown note in table output', async () => {
      const reg = await startAgeRegistry();
      const proj = await createTmpProject({
        packageJson: {
          name: 'fixture-age',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
      });
      await writeFile(join(proj.dir, '.npmrc'), 'min-release-age=30\n');
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: reg.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /Minimum release age: 30 days/);
        assert.match(result.stdout, /Holding back 1 package/);
      } finally {
        await proj.cleanup();
        await reg.close();
      }
    });

    it('reports a fractional, sub-day window and plural held-back packages', async () => {
      // Two packages each with a fresh major held back; pnpm 720 min = 0.5 days.
      const reg = await startMockRegistry([
        {
          name: 'alpha',
          versions: { '1.0.0': { version: '1.0.0' }, '2.0.0': { version: '2.0.0' } },
          time: { '1.0.0': daysAgo(400), '2.0.0': daysAgo(0) },
        },
        {
          name: 'beta',
          versions: { '1.0.0': { version: '1.0.0' }, '2.0.0': { version: '2.0.0' } },
          time: { '1.0.0': daysAgo(400), '2.0.0': daysAgo(0) },
        },
      ]);
      const proj = await createTmpProject({
        packageJson: {
          name: 'fixture-age',
          version: '1.0.0',
          dependencies: { alpha: '^1.0.0', beta: '^1.0.0' },
        },
        installed: { alpha: '1.0.0', beta: '1.0.0' },
      });
      // pnpm minutes → 720 min = 0.5 days (exercises the fractional formatter).
      await writeFile(join(proj.dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 720\n');
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: reg.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /Minimum release age: 0\.5 days/);
        assert.match(result.stdout, /Holding back 2 packages/);
        assert.match(result.stdout, /alpha 2\.0\.0/);
        assert.match(result.stdout, /beta 2\.0\.0/);
      } finally {
        await proj.cleanup();
        await reg.close();
      }
    });

    it('reports a package held back only in the patch tier', async () => {
      const reg = await startMockRegistry([
        {
          name: 'gamma',
          versions: { '1.0.0': { version: '1.0.0' }, '1.0.1': { version: '1.0.1' } },
          time: { '1.0.0': daysAgo(400), '1.0.1': daysAgo(1) },
        },
      ]);
      const proj = await createTmpProject({
        packageJson: {
          name: 'fixture-age',
          version: '1.0.0',
          dependencies: { gamma: '^1.0.0' },
        },
        installed: { gamma: '1.0.0' },
      });
      await writeFile(join(proj.dir, '.npmrc'), 'min-release-age=30\n');
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: reg.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /Holding back 1 package.*gamma 1\.0\.1/);
      } finally {
        await proj.cleanup();
        await reg.close();
      }
    });

    it('uses the singular "1 day" for a one-day window', async () => {
      const reg = await startAgeRegistry();
      const proj = await createTmpProject({
        packageJson: {
          name: 'fixture-age',
          version: '1.0.0',
          dependencies: { express: '^4.18.0' },
        },
        installed: { express: '4.18.2' },
      });
      // pnpm 1440 minutes = exactly 1 day.
      await writeFile(join(proj.dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 1440\n');
      try {
        const result = await runCli(
          ['--path', proj.packageJsonPath, '--no-cache'],
          { DEPENDENCY_GUARD_REGISTRY_URL: reg.url },
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /Minimum release age: 1 day \(/);
      } finally {
        await proj.cleanup();
        await reg.close();
      }
    });
  });
});
