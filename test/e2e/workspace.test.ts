/**
 * End-to-end tests for workspace: spec resolution.
 *
 * Unlike integration tests (which create flat node_modules entries as plain
 * files), these tests build realistic monorepo layouts with actual symlinks
 * in node_modules — the way pnpm, npm, and Yarn set up workspaces in
 * practice.  The CLI binary is spawned as a child process against a mock
 * registry so tests stay offline and deterministic.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startMockRegistry, type MockRegistry } from '../integration/helpers/mock-registry.ts';

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

// ---------------------------------------------------------------------------
// Helpers to build realistic monorepo layouts with real symlinks
// ---------------------------------------------------------------------------

interface WorkspacePackage {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}

interface MonorepoOptions {
  /** pnpm-workspace.yaml content; omit for npm workspaces */
  pnpmWorkspace?: string;
  /** Root package.json fields (name, workspaces, etc.) */
  rootPackageJson: Record<string, unknown>;
  /** Workspace member packages keyed by relative dir (e.g. 'packages/utils') */
  packages: Record<string, WorkspacePackage>;
  /** The consuming app — relative dir and its package.json */
  app: { dir: string; packageJson: Record<string, unknown> };
}

async function createMonorepo(opts: MonorepoOptions) {
  const root = await mkdtemp(join(tmpdir(), 'dep-guard-e2e-'));

  // Root files
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(opts.rootPackageJson, null, 2),
  );
  if (opts.pnpmWorkspace) {
    await writeFile(join(root, 'pnpm-workspace.yaml'), opts.pnpmWorkspace);
  }

  // Create workspace packages on disk
  for (const [relDir, pkg] of Object.entries(opts.packages)) {
    const pkgDir = join(root, relDir);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        ...(pkg.private ? { private: true } : {}),
        ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
      }, null, 2),
    );
  }

  // Create the app package
  const appDir = join(root, opts.app.dir);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify(opts.app.packageJson, null, 2),
  );

  // Create real symlinks in node_modules (like pnpm/npm would)
  for (const [relDir, pkg] of Object.entries(opts.packages)) {
    const pkgDir = join(root, relDir);

    // Symlink inside the app's node_modules → actual workspace package dir
    const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0] : null;
    const linkTarget = scope
      ? join(appDir, 'node_modules', scope, pkg.name.split('/')[1])
      : join(appDir, 'node_modules', pkg.name);

    if (scope) {
      await mkdir(join(appDir, 'node_modules', scope), { recursive: true });
    } else {
      await mkdir(join(appDir, 'node_modules'), { recursive: true });
    }
    await symlink(pkgDir, linkTarget, 'dir');
  }

  return {
    root,
    appDir,
    appPackageJsonPath: join(appDir, 'package.json'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: workspace resolution with real symlinks', () => {
  let registry: MockRegistry;

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
        name: '@myorg/shared',
        versions: {
          '2.0.0': { version: '2.0.0' },
          '2.1.0': { version: '2.1.0' },
          '3.0.0': { version: '3.0.0' },
        },
        time: {
          '2.0.0': '2024-01-01T00:00:00Z',
          '2.1.0': '2025-06-01T00:00:00Z',
          '3.0.0': '2026-01-01T00:00:00Z',
        },
      },
    ]);
  });

  afterEach(async () => {
    await registry.close();
  });

  it('pnpm monorepo: resolves workspace:* via real symlinks and audits against registry', async () => {
    const mono = await createMonorepo({
      pnpmWorkspace: 'packages:\n  - "packages/*"\n',
      rootPackageJson: { name: 'monorepo-root', private: true },
      packages: {
        'packages/shared': { name: '@myorg/shared', version: '2.0.0' },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: {
            '@myorg/shared': 'workspace:*',
            lodash: '4.17.21',
          },
        },
      },
    });

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);

      // @myorg/shared should be resolved via the real symlink.
      const shared = report.dependencies.find(
        (d: { name: string }) => d.name === '@myorg/shared',
      );
      assert.ok(shared, '@myorg/shared should appear in dependencies');
      assert.equal(shared.current.version, '2.0.0');
      assert.equal(shared.type, 'dependencies');
      // It has updates available (2.1.0 minor, 3.0.0 major).
      assert.equal(shared.updateType, 'major');

      // lodash should also be present (normal dep).
      const lodash = report.dependencies.find(
        (d: { name: string }) => d.name === 'lodash',
      );
      assert.ok(lodash, 'lodash should appear in dependencies');
    } finally {
      await mono.cleanup();
    }
  });

  it('pnpm monorepo: version-pinned workspace:^2.0.0 resolves via real symlinks', async () => {
    const mono = await createMonorepo({
      pnpmWorkspace: 'packages:\n  - "packages/*"\n',
      rootPackageJson: { name: 'monorepo-root', private: true },
      packages: {
        'packages/shared': { name: '@myorg/shared', version: '2.1.0' },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: { '@myorg/shared': 'workspace:^2.0.0' },
        },
      },
    });

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);

      const shared = report.dependencies.find(
        (d: { name: string }) => d.name === '@myorg/shared',
      );
      assert.ok(shared, 'version-pinned workspace dep should resolve via symlink');
      assert.equal(shared.current.version, '2.1.0');
    } finally {
      await mono.cleanup();
    }
  });

  it('npm monorepo: resolves workspace:~ via real symlinks (no pnpm-workspace.yaml)', async () => {
    const mono = await createMonorepo({
      rootPackageJson: {
        name: 'npm-monorepo',
        private: true,
        workspaces: ['packages/*'],
      },
      packages: {
        'packages/shared': { name: '@myorg/shared', version: '2.0.0' },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: { '@myorg/shared': 'workspace:~' },
        },
      },
    });

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);

      const shared = report.dependencies.find(
        (d: { name: string }) => d.name === '@myorg/shared',
      );
      assert.ok(shared, 'npm workspace dep should resolve via symlink');
      assert.equal(shared.current.version, '2.0.0');
    } finally {
      await mono.cleanup();
    }
  });

  it('private workspace package is skipped with workspace-private reason', async () => {
    const mono = await createMonorepo({
      pnpmWorkspace: 'packages:\n  - "packages/*"\n',
      rootPackageJson: { name: 'monorepo-root', private: true },
      packages: {
        'packages/internal': { name: '@myorg/internal', version: '0.1.0', private: true },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: { '@myorg/internal': 'workspace:*' },
        },
      },
    });

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);

      assert.equal(
        report.dependencies.find((d: { name: string }) => d.name === '@myorg/internal'),
        undefined,
        'private package should NOT appear in dependencies',
      );
      const skipped = report.skipped.find(
        (s: { name: string }) => s.name === '@myorg/internal',
      );
      assert.ok(skipped, 'private package should appear in skipped');
      assert.equal(skipped.reason, 'workspace-private');
    } finally {
      await mono.cleanup();
    }
  });

  it('--fail-on major exits 2 when workspace dep needs major update', async () => {
    const mono = await createMonorepo({
      pnpmWorkspace: 'packages:\n  - "packages/*"\n',
      rootPackageJson: { name: 'monorepo-root', private: true },
      packages: {
        // Version 2.0.0 has a major update to 3.0.0 in the mock registry.
        'packages/shared': { name: '@myorg/shared', version: '2.0.0' },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: { '@myorg/shared': 'workspace:*' },
        },
      },
    });

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--fail-on', 'major', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 2, 'should exit 2 for major upgrade on workspace dep');
    } finally {
      await mono.cleanup();
    }
  });

  it('--update preserves workspace: specs in package.json', async () => {
    const mono = await createMonorepo({
      pnpmWorkspace: 'packages:\n  - "packages/*"\n',
      rootPackageJson: { name: 'monorepo-root', private: true },
      packages: {
        // Has minor update 2.0.0 → 2.1.0.
        'packages/shared': { name: '@myorg/shared', version: '2.0.0' },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: { '@myorg/shared': 'workspace:^' },
        },
      },
    });

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--update', 'minor', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);

      const after = JSON.parse(await readFile(mono.appPackageJsonPath, 'utf8'));
      assert.equal(
        after.dependencies['@myorg/shared'],
        'workspace:^',
        'workspace: spec must NOT be overwritten by --update',
      );
    } finally {
      await mono.cleanup();
    }
  });

  it('multi-package monorepo: mixes public, private, and normal deps correctly', async () => {
    const mono = await createMonorepo({
      pnpmWorkspace: 'packages:\n  - "packages/*"\n  - "libs/*"\n',
      rootPackageJson: { name: 'monorepo-root', private: true },
      packages: {
        'packages/shared': { name: '@myorg/shared', version: '2.0.0' },
        'libs/internal': { name: '@myorg/internal', version: '0.5.0', private: true },
      },
      app: {
        dir: 'packages/app',
        packageJson: {
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: {
            '@myorg/shared': 'workspace:*',
            '@myorg/internal': 'workspace:^',
            lodash: '4.17.21',
          },
        },
      },
    });

    // Also symlink lodash as a regular dep (not a workspace symlink)
    await mkdir(join(mono.appDir, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(
      join(mono.appDir, 'node_modules', 'lodash', 'package.json'),
      JSON.stringify({ name: 'lodash', version: '4.17.21' }),
    );

    try {
      const result = await runCli(
        ['--path', mono.appPackageJsonPath, '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);

      // Public workspace dep → in dependencies.
      const shared = report.dependencies.find(
        (d: { name: string }) => d.name === '@myorg/shared',
      );
      assert.ok(shared, '@myorg/shared should be in dependencies');
      assert.equal(shared.current.version, '2.0.0');

      // Normal dep → in dependencies.
      const lodash = report.dependencies.find(
        (d: { name: string }) => d.name === 'lodash',
      );
      assert.ok(lodash, 'lodash should be in dependencies');

      // Private workspace dep → in skipped.
      const internal = report.skipped.find(
        (s: { name: string }) => s.name === '@myorg/internal',
      );
      assert.ok(internal, '@myorg/internal should be in skipped');
      assert.equal(internal.reason, 'workspace-private');

      assert.equal(report.summary.total, 2, 'only 2 auditable deps (shared + lodash)');
    } finally {
      await mono.cleanup();
    }
  });

  it('glob fallback resolves workspace dep when node_modules has no symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dep-guard-e2e-glob-'));
    try {
      // Set up workspace but intentionally do NOT create any symlinks.
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'root', private: true }),
      );

      // Workspace package on disk.
      const sharedDir = join(root, 'packages', 'shared');
      await mkdir(sharedDir, { recursive: true });
      await writeFile(
        join(sharedDir, 'package.json'),
        JSON.stringify({ name: '@myorg/shared', version: '2.0.0' }),
      );

      // App with workspace dep but NO node_modules at all.
      const appDir = join(root, 'packages', 'app');
      await mkdir(appDir, { recursive: true });
      await writeFile(
        join(appDir, 'package.json'),
        JSON.stringify({
          name: '@myorg/app',
          version: '1.0.0',
          dependencies: { '@myorg/shared': 'workspace:*' },
        }),
      );

      const result = await runCli(
        ['--path', join(appDir, 'package.json'), '--format', 'json', '--no-cache'],
        { DEPENDENCY_GUARD_REGISTRY_URL: registry.url },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);

      const shared = report.dependencies.find(
        (d: { name: string }) => d.name === '@myorg/shared',
      );
      assert.ok(shared, 'glob fallback should resolve the workspace package');
      assert.equal(shared.current.version, '2.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
