import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  findWorkspaceRoot,
  parseWorkspacePackages,
  readWorkspacePackageInfo,
  resolveWorkspaceSpecs,
} from '../../src/workspace.ts';

// ---------------------------------------------------------------------------
// findWorkspaceRoot
// ---------------------------------------------------------------------------

describe('findWorkspaceRoot', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-wsroot-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds pnpm-workspace.yaml in the same directory', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const result = await findWorkspaceRoot(dir);
    assert.deepEqual(result, { rootDir: dir, type: 'pnpm' });
  });

  it('finds pnpm-workspace.yaml two levels up', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const nested = join(dir, 'packages', 'my-app');
    await mkdir(nested, { recursive: true });
    const result = await findWorkspaceRoot(nested);
    assert.deepEqual(result, { rootDir: dir, type: 'pnpm' });
  });

  it('finds npm/yarn package.json with workspaces array', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    const result = await findWorkspaceRoot(dir);
    assert.deepEqual(result, { rootDir: dir, type: 'npm' });
  });

  it('ignores package.json without workspaces field', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'not-a-workspace' }),
    );
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await writeFile(join(sub, 'package.json'), JSON.stringify({ name: 'child' }));
    const result = await findWorkspaceRoot(sub, 1);
    // The root has no workspaces, so it won't match — result depends on depth.
    // With maxDepth=1, we check sub (no workspaces) and dir (no workspaces).
    assert.equal(result, null);
  });

  it('prefers pnpm-workspace.yaml over package.json workspaces', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    const result = await findWorkspaceRoot(dir);
    assert.deepEqual(result, { rootDir: dir, type: 'pnpm' });
  });

  it('returns null when nothing found', async () => {
    const sub = join(dir, 'deep', 'nested');
    await mkdir(sub, { recursive: true });
    const result = await findWorkspaceRoot(sub, 2);
    // With maxDepth=2, checks sub, dir/deep, dir — none have workspace markers.
    assert.equal(result, null);
  });

  it('returns null when walking up hits filesystem root', async () => {
    // Start from / with a high depth — dirname('/') === '/' triggers the root check.
    const result = await findWorkspaceRoot('/', 0);
    assert.equal(result, null);
  });

  it('respects maxDepth limit', async () => {
    // Put the workspace file 3 levels up, but set maxDepth to 1.
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "**"\n');
    const deep = join(dir, 'a', 'b', 'c');
    await mkdir(deep, { recursive: true });
    const result = await findWorkspaceRoot(deep, 1);
    // maxDepth=1: checks c (depth 0) and b (depth 1) — doesn't reach root.
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// parseWorkspacePackages
// ---------------------------------------------------------------------------

describe('parseWorkspacePackages', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-wspkg-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses packages list from pnpm-workspace.yaml', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "apps/*"\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, ['packages/*', 'apps/*']);
  });

  it('handles unquoted patterns in pnpm-workspace.yaml', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n  - apps/*\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, ['packages/*', 'apps/*']);
  });

  it('skips negation patterns in pnpm-workspace.yaml', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "!packages/ignore"\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    // Negation patterns are returned as-is — filtering happens in discoverWorkspacePackage.
    assert.deepEqual(patterns, ['packages/*', '!packages/ignore']);
  });

  it('returns empty array when pnpm-workspace.yaml has no packages key', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'catalog:\n  react: ^18.0.0\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, []);
  });

  it('reads workspaces from npm package.json', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*', 'libs/*'] }),
    );
    const patterns = await parseWorkspacePackages(dir, 'npm');
    assert.deepEqual(patterns, ['packages/*', 'libs/*']);
  });

  it('returns empty array when npm package.json has no workspaces', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root' }),
    );
    const patterns = await parseWorkspacePackages(dir, 'npm');
    assert.deepEqual(patterns, []);
  });

  it('filters non-string entries from npm workspaces array', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*', 42, null, 'apps/*'] }),
    );
    const patterns = await parseWorkspacePackages(dir, 'npm');
    assert.deepEqual(patterns, ['packages/*', 'apps/*']);
  });

  it('returns empty array when file is missing', async () => {
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, []);
  });

  it('returns empty array when npm package.json is unreadable', async () => {
    // Write invalid JSON to trigger the catch path.
    await writeFile(join(dir, 'package.json'), '{{{not json');
    const patterns = await parseWorkspacePackages(dir, 'npm');
    assert.deepEqual(patterns, []);
  });

  it('ignores inline comments in pnpm-workspace.yaml', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*" # main packages\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, ['packages/*']);
  });

  it('skips standalone comment lines inside packages block', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  # Core packages\n  - "packages/*"\n  - "apps/*"\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, ['packages/*', 'apps/*']);
  });

  it('stops reading packages at the next top-level key', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\ncatalog:\n  react: ^18.0.0\n',
    );
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, ['packages/*']);
  });

  it('returns empty array for completely garbage pnpm-workspace.yaml', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'zzzz\n{{{garbage\nrandom text!!!\n');
    const patterns = await parseWorkspacePackages(dir, 'pnpm');
    assert.deepEqual(patterns, []);
  });
});

// ---------------------------------------------------------------------------
// readWorkspacePackageInfo
// ---------------------------------------------------------------------------

describe('readWorkspacePackageInfo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-wsinfo-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns version and private=false for a public package', async () => {
    await mkdir(join(dir, 'node_modules', 'my-pkg'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'my-pkg', 'package.json'),
      JSON.stringify({ name: 'my-pkg', version: '2.0.0' }),
    );
    const info = await readWorkspacePackageInfo(dir, 'my-pkg');
    assert.deepEqual(info, { version: '2.0.0', isPrivate: false });
  });

  it('returns version and private=true for a private package', async () => {
    await mkdir(join(dir, 'node_modules', 'my-pkg'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'my-pkg', 'package.json'),
      JSON.stringify({ name: 'my-pkg', version: '1.0.0', private: true }),
    );
    const info = await readWorkspacePackageInfo(dir, 'my-pkg');
    assert.deepEqual(info, { version: '1.0.0', isPrivate: true });
  });

  it('handles scoped package names', async () => {
    await mkdir(join(dir, 'node_modules', '@myorg', 'ui'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', '@myorg', 'ui', 'package.json'),
      JSON.stringify({ name: '@myorg/ui', version: '3.0.0' }),
    );
    const info = await readWorkspacePackageInfo(dir, '@myorg/ui');
    assert.deepEqual(info, { version: '3.0.0', isPrivate: false });
  });

  it('returns null when package is not installed', async () => {
    const info = await readWorkspacePackageInfo(dir, 'nonexistent');
    assert.equal(info, null);
  });

  it('returns null when package.json has no version', async () => {
    await mkdir(join(dir, 'node_modules', 'no-ver'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'no-ver', 'package.json'),
      JSON.stringify({ name: 'no-ver' }),
    );
    const info = await readWorkspacePackageInfo(dir, 'no-ver');
    assert.equal(info, null);
  });

  it('returns null when package.json is malformed JSON', async () => {
    await mkdir(join(dir, 'node_modules', 'bad-json'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'bad-json', 'package.json'),
      '{{{not valid json',
    );
    const info = await readWorkspacePackageInfo(dir, 'bad-json');
    assert.equal(info, null);
  });

  it('treats non-boolean private field as not private', async () => {
    await mkdir(join(dir, 'node_modules', 'str-priv'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'str-priv', 'package.json'),
      JSON.stringify({ name: 'str-priv', version: '1.0.0', private: 'yes' }),
    );
    const info = await readWorkspacePackageInfo(dir, 'str-priv');
    assert.deepEqual(info, { version: '1.0.0', isPrivate: false });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceSpecs
// ---------------------------------------------------------------------------

describe('resolveWorkspaceSpecs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-wsresolve-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns early when specs is empty', async () => {
    const result = await resolveWorkspaceSpecs([], dir);
    assert.deepEqual(result, { entries: [], skipped: [] });
  });

  it('resolves a public workspace dep to an entry', async () => {
    // Set up a pnpm workspace root at dir.
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    // Create the consuming project's node_modules with a symlink-like structure.
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', '@myorg', 'utils'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', '@myorg', 'utils', 'package.json'),
      JSON.stringify({ name: '@myorg/utils', version: '1.5.0' }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: '@myorg/utils', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: '@myorg/utils',
        type: 'dependencies',
        spec: 'workspace:*',
        installedVersion: '1.5.0',
        transitive: false,
      },
    ]);
    assert.deepEqual(result.skipped, []);
  });

  it('resolves version-pinned workspace specs (workspace:^1.0.0)', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'my-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'my-lib', 'package.json'),
      JSON.stringify({ name: 'my-lib', version: '1.2.3' }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: 'my-lib', type: 'dependencies', spec: 'workspace:^1.0.0' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'my-lib',
        type: 'dependencies',
        spec: 'workspace:^1.0.0',
        installedVersion: '1.2.3',
        transitive: false,
      },
    ]);
    assert.deepEqual(result.skipped, []);
  });

  it('resolves bare workspace: spec (equivalent to workspace:*)', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'my-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'my-lib', 'package.json'),
      JSON.stringify({ name: 'my-lib', version: '2.0.0' }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: 'my-lib', type: 'dependencies', spec: 'workspace:' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'my-lib',
        type: 'dependencies',
        spec: 'workspace:',
        installedVersion: '2.0.0',
        transitive: false,
      },
    ]);
  });

  it('resolves workspace:~2.0.0 (tilde-pinned) spec', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'my-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'my-lib', 'package.json'),
      JSON.stringify({ name: 'my-lib', version: '2.1.0' }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: 'my-lib', type: 'dependencies', spec: 'workspace:~2.0.0' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'my-lib',
        type: 'dependencies',
        spec: 'workspace:~2.0.0',
        installedVersion: '2.1.0',
        transitive: false,
      },
    ]);
    assert.deepEqual(result.skipped, []);
  });

  it('resolves workspace:1.0.0 (exact-pinned) spec', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'my-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'my-lib', 'package.json'),
      JSON.stringify({ name: 'my-lib', version: '1.0.0' }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: 'my-lib', type: 'dependencies', spec: 'workspace:1.0.0' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'my-lib',
        type: 'dependencies',
        spec: 'workspace:1.0.0',
        installedVersion: '1.0.0',
        transitive: false,
      },
    ]);
    assert.deepEqual(result.skipped, []);
  });

  it('skips private dep regardless of workspace spec form', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'priv-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'priv-lib', 'package.json'),
      JSON.stringify({ name: 'priv-lib', version: '1.0.0', private: true }),
    );

    // All four new forms should skip with workspace-private.
    for (const spec of ['workspace:', 'workspace:^1.0.0', 'workspace:~2.0.0', 'workspace:1.0.0']) {
      const result = await resolveWorkspaceSpecs(
        [{ name: 'priv-lib', type: 'dependencies', spec }],
        projectDir,
      );
      assert.deepEqual(result.entries, [], `entries should be empty for ${spec}`);
      assert.equal(result.skipped.length, 1, `should have one skipped for ${spec}`);
      assert.equal(result.skipped[0].reason, 'workspace-private', `reason should be workspace-private for ${spec}`);
    }
  });

  it('skips a private workspace dep with workspace-private reason', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'internal-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'internal-lib', 'package.json'),
      JSON.stringify({ name: 'internal-lib', version: '0.1.0', private: true }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: 'internal-lib', type: 'dependencies', spec: 'workspace:^' }],
      projectDir,
    );
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.skipped, [
      { name: 'internal-lib', type: 'dependencies', reason: 'workspace-private' },
    ]);
  });

  it('skips with override-descriptor when package is not found anywhere', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');
    await mkdir(projectDir, { recursive: true });

    const result = await resolveWorkspaceSpecs(
      [{ name: 'ghost-pkg', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.skipped, [
      { name: 'ghost-pkg', type: 'dependencies', reason: 'override-descriptor' },
    ]);
  });

  it('skips all specs with override-descriptor when no workspace root is found', async () => {
    // dir has no workspace markers.
    const sub = join(dir, 'sub');
    await mkdir(sub);

    const result = await resolveWorkspaceSpecs(
      [
        { name: 'pkg-a', type: 'dependencies', spec: 'workspace:*' },
        { name: 'pkg-b', type: 'devDependencies', spec: 'workspace:^' },
      ],
      sub,
      0, // maxDepth=0: only check the dir itself
    );
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.skipped, [
      { name: 'pkg-a', type: 'dependencies', reason: 'override-descriptor' },
      { name: 'pkg-b', type: 'devDependencies', reason: 'override-descriptor' },
    ]);
  });

  it('falls back to workspace root node_modules when project node_modules misses the package', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    // Package installed only at workspace root level.
    await mkdir(join(dir, 'node_modules', 'shared-lib'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'shared-lib', 'package.json'),
      JSON.stringify({ name: 'shared-lib', version: '3.0.0' }),
    );

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(projectDir, { recursive: true });

    const result = await resolveWorkspaceSpecs(
      [{ name: 'shared-lib', type: 'dependencies', spec: 'workspace:~' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'shared-lib',
        type: 'dependencies',
        spec: 'workspace:~',
        installedVersion: '3.0.0',
        transitive: false,
      },
    ]);
  });

  it('uses glob fallback when node_modules is absent', async () => {
    // Set up workspace with a package on disk (no node_modules).
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const pkgDir = join(dir, 'packages', 'utils');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@myorg/utils', version: '2.0.0' }),
    );

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(projectDir, { recursive: true });

    const result = await resolveWorkspaceSpecs(
      [{ name: '@myorg/utils', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: '@myorg/utils',
        type: 'dependencies',
        spec: 'workspace:*',
        installedVersion: '2.0.0',
        transitive: false,
      },
    ]);
  });

  it('glob fallback detects private packages', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const pkgDir = join(dir, 'packages', 'internal');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'internal', version: '0.1.0', private: true }),
    );

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(projectDir, { recursive: true });

    const result = await resolveWorkspaceSpecs(
      [{ name: 'internal', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.skipped, [
      { name: 'internal', type: 'dependencies', reason: 'workspace-private' },
    ]);
  });

  it('resolves mixed public and private deps in a single call', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const projectDir = join(dir, 'packages', 'app');

    // Public dep
    await mkdir(join(projectDir, 'node_modules', 'public-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'public-lib', 'package.json'),
      JSON.stringify({ name: 'public-lib', version: '1.0.0' }),
    );

    // Private dep
    await mkdir(join(projectDir, 'node_modules', 'private-lib'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'private-lib', 'package.json'),
      JSON.stringify({ name: 'private-lib', version: '0.5.0', private: true }),
    );

    const result = await resolveWorkspaceSpecs(
      [
        { name: 'public-lib', type: 'dependencies', spec: 'workspace:*' },
        { name: 'private-lib', type: 'devDependencies', spec: 'workspace:^' },
      ],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'public-lib',
        type: 'dependencies',
        spec: 'workspace:*',
        installedVersion: '1.0.0',
        transitive: false,
      },
    ]);
    assert.deepEqual(result.skipped, [
      { name: 'private-lib', type: 'devDependencies', reason: 'workspace-private' },
    ]);
  });

  it('glob fallback ignores negation patterns', async () => {
    // Negation pattern appears BEFORE the real pattern so discoverWorkspacePackage
    // actually encounters and skips it.
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - "!packages/ignore"\n  - "packages/*"\n',
    );
    const pkgDir = join(dir, 'packages', 'utils');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'utils', version: '1.0.0' }),
    );

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(projectDir, { recursive: true });

    const result = await resolveWorkspaceSpecs(
      [{ name: 'utils', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'utils',
        type: 'dependencies',
        spec: 'workspace:*',
        installedVersion: '1.0.0',
        transitive: false,
      },
    ]);
  });

  it('glob fallback skips unreadable package.json files', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // Create a package dir with invalid JSON.
    const badDir = join(dir, 'packages', 'broken');
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, 'package.json'), '{{{not json');

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(projectDir, { recursive: true });

    const result = await resolveWorkspaceSpecs(
      [{ name: 'broken', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    // Package not found (bad JSON was skipped) → override-descriptor.
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.skipped, [
      { name: 'broken', type: 'dependencies', reason: 'override-descriptor' },
    ]);
  });

  it('works with npm workspaces (package.json workspaces array)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );

    const projectDir = join(dir, 'packages', 'app');
    await mkdir(join(projectDir, 'node_modules', 'utils'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'utils', 'package.json'),
      JSON.stringify({ name: 'utils', version: '4.0.0' }),
    );

    const result = await resolveWorkspaceSpecs(
      [{ name: 'utils', type: 'dependencies', spec: 'workspace:*' }],
      projectDir,
    );
    assert.deepEqual(result.entries, [
      {
        name: 'utils',
        type: 'dependencies',
        spec: 'workspace:*',
        installedVersion: '4.0.0',
        transitive: false,
      },
    ]);
  });
});
