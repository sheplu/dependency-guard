import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startMockRegistry, type MockRegistry } from './helpers/mock-registry.ts';
import { createTmpProject, type TmpProject } from './helpers/tmp-project.ts';

const BIN = resolve(import.meta.dirname, '..', '..', 'index.ts');

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
        { name: '@private/foo', type: 'dependencies', scope: '@private' },
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
  });
});
