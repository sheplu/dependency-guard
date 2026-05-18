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
});
