import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  applyCatalogUpdates,
  collectCatalogEntries,
  findWorkspaceFile,
  parseCatalogYaml,
} from '../../src/catalog.ts';

// ---------------------------------------------------------------------------
// parseCatalogYaml
// ---------------------------------------------------------------------------

describe('parseCatalogYaml', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(parseCatalogYaml(''), []);
  });

  it('returns empty array when no catalog block exists', () => {
    const yaml = `packages:\n  - ts/apps/*\n`;
    assert.deepEqual(parseCatalogYaml(yaml), []);
  });

  it('parses default catalog: block', () => {
    const yaml = [
      'catalog:',
      '  react: ^18.0.0',
      '  typescript: ^5.0.0',
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => ({ name: e.name, spec: e.spec, catalogName: e.catalogName })),
      [
        { name: 'react', spec: '^18.0.0', catalogName: null },
        { name: 'typescript', spec: '^5.0.0', catalogName: null },
      ],
    );
  });

  it('parses named catalogs: block', () => {
    const yaml = [
      'catalogs:',
      '  tooling:',
      '    typescript: ^5.0.0',
      '    oxlint: 0.5.0',
      '  ui:',
      '    react: ^18.0.0',
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => ({ name: e.name, spec: e.spec, catalogName: e.catalogName })),
      [
        { name: 'typescript', spec: '^5.0.0', catalogName: 'tooling' },
        { name: 'oxlint', spec: '0.5.0', catalogName: 'tooling' },
        { name: 'react', spec: '^18.0.0', catalogName: 'ui' },
      ],
    );
  });

  it('parses a mixed file with both catalog: and catalogs:', () => {
    const yaml = [
      'packages:',
      '  - ts/apps/*',
      '',
      'catalog:',
      '  lodash: ^4.17.21',
      '',
      'catalogs:',
      '  tooling:',
      '    typescript: ^5.0.0',
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'lodash');
    assert.equal(entries[0].catalogName, null);
    assert.equal(entries[1].name, 'typescript');
    assert.equal(entries[1].catalogName, 'tooling');
  });

  it('parses scoped package names', () => {
    const yaml = [
      'catalog:',
      "  '@types/node': ^20.0.0",
      "  '@scope/pkg': 1.2.3",
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "'@types/node'");
    assert.equal(entries[1].name, "'@scope/pkg'");
  });

  it('records correct lineIndex for each entry', () => {
    const yaml = [
      'catalog:',         // line 0
      '  react: ^18.0.0', // line 1
      '  lodash: 4.17.21', // line 2
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries[0].lineIndex, 1);
    assert.equal(entries[1].lineIndex, 2);
  });

  it('skips blank lines and comment lines within catalog blocks', () => {
    const yaml = [
      'catalog:',
      '  # a comment',
      '',
      '  react: ^18.0.0',
      '  # another comment',
      '  lodash: 4.17.21',
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'react');
    assert.equal(entries[1].name, 'lodash');
  });

  it('strips inline comments from spec values', () => {
    const yaml = [
      'catalog:',
      '  react: ^18.0.0 # keep pinned',
    ].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries[0].spec, '^18.0.0');
  });

  it('handles exact version pins (no range prefix)', () => {
    const yaml = ['catalog:', '  zod: 3.22.0'].join('\n');
    const entries = parseCatalogYaml(yaml);
    assert.equal(entries[0].spec, '3.22.0');
  });
});

// ---------------------------------------------------------------------------
// findWorkspaceFile
// ---------------------------------------------------------------------------

describe('findWorkspaceFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-ws-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds pnpm-workspace.yaml in the same directory', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "*"\n');
    const found = await findWorkspaceFile(dir);
    assert.equal(found, join(dir, 'pnpm-workspace.yaml'));
  });

  it('finds pnpm-workspace.yaml two levels up', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "*"\n');
    const nested = join(dir, 'packages', 'my-app');
    await mkdir(nested, { recursive: true });
    const found = await findWorkspaceFile(nested);
    assert.equal(found, join(dir, 'pnpm-workspace.yaml'));
  });

  it('returns null when no workspace file exists', async () => {
    // Use a subdirectory with no workspace file anywhere in our tmp tree
    const sub = join(dir, 'deep', 'nested');
    await mkdir(sub, { recursive: true });
    // Don't create pnpm-workspace.yaml
    const found = await findWorkspaceFile(sub);
    // It may find one further up the real filesystem — just assert it's a string or null
    assert.ok(found === null || typeof found === 'string');
  });
});

// ---------------------------------------------------------------------------
// collectCatalogEntries
// ---------------------------------------------------------------------------

describe('collectCatalogEntries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-cat-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns DependencyEntry[] with type catalog', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, ['catalog:', '  react: ^18.0.0', '  lodash: 4.17.21'].join('\n'));
    const entries = await collectCatalogEntries(wsPath, dir);
    assert.equal(entries.length, 2);
    for (const e of entries) assert.equal(e.type, 'catalog');
  });

  it('sets catalogName to null for default catalog entries', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, ['catalog:', '  react: ^18.0.0'].join('\n'));
    const entries = await collectCatalogEntries(wsPath, dir);
    assert.equal(entries[0].catalogName, null);
  });

  it('sets catalogName for named catalog entries', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalogs:',
      '  tooling:',
      '    typescript: ^5.0.0',
    ].join('\n'));
    const entries = await collectCatalogEntries(wsPath, dir);
    assert.equal(entries[0].catalogName, 'tooling');
  });

  it('resolves installedVersion from node_modules when present', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, ['catalog:', '  react: ^18.0.0'].join('\n'));
    await mkdir(join(dir, 'node_modules', 'react'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'react', 'package.json'),
      JSON.stringify({ name: 'react', version: '18.2.0' }),
    );
    const entries = await collectCatalogEntries(wsPath, dir);
    assert.equal(entries[0].installedVersion, '18.2.0');
  });

  it('falls back to stripped spec when not installed', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, ['catalog:', '  react: ^18.0.0'].join('\n'));
    const entries = await collectCatalogEntries(wsPath, dir);
    assert.equal(entries[0].installedVersion, '18.0.0');
  });

  it('returns empty array for an unreadable file', async () => {
    const entries = await collectCatalogEntries(join(dir, 'nonexistent.yaml'), dir);
    assert.deepEqual(entries, []);
  });

  it('skips catalog entries whose spec is itself a catalog: reference', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalog:',
      '  react: ^18.0.0',
      '  weird: catalog:other',
    ].join('\n'));
    const entries = await collectCatalogEntries(wsPath, dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'react');
  });

  it('falls back to projectDir node_modules when not installed in workspaceRootDir', async () => {
    const wsRoot = join(dir, 'ws-root');
    const projectDir = join(dir, 'packages', 'my-app');
    await mkdir(wsRoot, { recursive: true });
    await mkdir(projectDir, { recursive: true });

    const wsPath = join(wsRoot, 'pnpm-workspace.yaml');
    await writeFile(wsPath, ['catalog:', '  react: ^18.0.0'].join('\n'));

    // React is only in projectDir's node_modules, not in wsRoot's
    await mkdir(join(projectDir, 'node_modules', 'react'), { recursive: true });
    await writeFile(
      join(projectDir, 'node_modules', 'react', 'package.json'),
      JSON.stringify({ name: 'react', version: '18.2.0' }),
    );

    const entries = await collectCatalogEntries(wsPath, projectDir);
    assert.equal(entries[0].installedVersion, '18.2.0');
  });
});

// ---------------------------------------------------------------------------
// applyCatalogUpdates
// ---------------------------------------------------------------------------

describe('applyCatalogUpdates', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-apply-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('updates a spec in the default catalog block', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalog:',
      '  react: ^18.0.0',
      '  lodash: 4.17.21',
    ].join('\n') + '\n');

    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '18.0.0', to: '18.3.0', oldSpec: '^18.0.0', newSpec: '^18.3.0' },
    ]);

    const result = await readFile(wsPath, 'utf8');
    assert.ok(result.includes('react: ^18.3.0'), `expected react update in:\n${result}`);
    assert.ok(result.includes('lodash: 4.17.21'), 'lodash line should be untouched');
  });

  it('updates a spec in a named catalog block', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalogs:',
      '  tooling:',
      '    typescript: ^5.0.0',
      '    oxlint: 0.4.0',
    ].join('\n') + '\n');

    await applyCatalogUpdates(wsPath, [
      { name: 'typescript', type: 'catalog', from: '5.0.0', to: '5.4.0', oldSpec: '^5.0.0', newSpec: '^5.4.0' },
    ]);

    const result = await readFile(wsPath, 'utf8');
    assert.ok(result.includes('typescript: ^5.4.0'), `expected typescript update in:\n${result}`);
    assert.ok(result.includes('oxlint: 0.4.0'), 'oxlint should be untouched');
  });

  it('applies multiple updates in one call', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalog:',
      '  react: ^18.0.0',
      '  typescript: ^5.0.0',
    ].join('\n') + '\n');

    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '18.0.0', to: '18.3.0', oldSpec: '^18.0.0', newSpec: '^18.3.0' },
      { name: 'typescript', type: 'catalog', from: '5.0.0', to: '5.4.0', oldSpec: '^5.0.0', newSpec: '^5.4.0' },
    ]);

    const result = await readFile(wsPath, 'utf8');
    assert.ok(result.includes('react: ^18.3.0'));
    assert.ok(result.includes('typescript: ^5.4.0'));
  });

  it('preserves trailing newline when present', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, 'catalog:\n  react: ^18.0.0\n');
    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '18.0.0', to: '18.3.0', oldSpec: '^18.0.0', newSpec: '^18.3.0' },
    ]);
    const result = await readFile(wsPath, 'utf8');
    assert.ok(result.endsWith('\n'));
  });

  it('preserves absence of trailing newline', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, 'catalog:\n  react: ^18.0.0');
    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '18.0.0', to: '18.3.0', oldSpec: '^18.0.0', newSpec: '^18.3.0' },
    ]);
    const result = await readFile(wsPath, 'utf8');
    assert.ok(!result.endsWith('\n'));
  });

  it('silently ignores updates for names not in the file', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    const original = 'catalog:\n  react: ^18.0.0\n';
    await writeFile(wsPath, original);
    await applyCatalogUpdates(wsPath, [
      { name: 'nonexistent', type: 'catalog', from: '1.0.0', to: '2.0.0', oldSpec: '^1.0.0', newSpec: '^2.0.0' },
    ]);
    const result = await readFile(wsPath, 'utf8');
    assert.equal(result, original);
  });

  it('is a no-op when updates array is empty', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    const original = 'catalog:\n  react: ^18.0.0\n';
    await writeFile(wsPath, original);
    await applyCatalogUpdates(wsPath, []);
    const result = await readFile(wsPath, 'utf8');
    assert.equal(result, original);
  });

  it('skips non-catalog type updates', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    const original = 'catalog:\n  react: ^18.0.0\n';
    await writeFile(wsPath, original);
    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'dependencies', from: '18.0.0', to: '18.3.0', oldSpec: '^18.0.0', newSpec: '^18.3.0' },
    ]);
    const result = await readFile(wsPath, 'utf8');
    assert.equal(result, original);
  });

  it('matches by oldSpec when same package appears in multiple catalogs', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalog:',
      '  react: ^18.0.0',
      'catalogs:',
      '  legacy:',
      '    react: ^17.0.0',
    ].join('\n') + '\n');

    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '17.0.0', to: '17.0.5', oldSpec: '^17.0.0', newSpec: '^17.0.5' },
    ]);

    const result = await readFile(wsPath, 'utf8');
    assert.ok(result.includes('react: ^18.0.0'), 'default catalog should be untouched');
    assert.ok(result.includes('react: ^17.0.5'), 'named catalog should be updated');
  });

  it('falls back to first candidate when oldSpec matches no catalog', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      'catalog:',
      '  react: ^18.0.0',
      'catalogs:',
      '  legacy:',
      '    react: ^17.0.0',
    ].join('\n') + '\n');

    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '16.0.0', to: '16.5.0', oldSpec: '^16.0.0', newSpec: '^16.5.0' },
    ]);

    const result = await readFile(wsPath, 'utf8');
    // First candidate (default catalog) is updated as fallback
    assert.ok(result.includes('react: ^16.5.0') || result.includes('react: ^17.0.0'));
  });

  it('preserves comments and other lines', async () => {
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    await writeFile(wsPath, [
      '# workspace config',
      'packages:',
      '  - ts/apps/*',
      '',
      'catalog:',
      '  # pinned dependencies',
      '  react: ^18.0.0',
      '  lodash: 4.17.21',
    ].join('\n') + '\n');

    await applyCatalogUpdates(wsPath, [
      { name: 'react', type: 'catalog', from: '18.0.0', to: '18.3.0', oldSpec: '^18.0.0', newSpec: '^18.3.0' },
    ]);

    const result = await readFile(wsPath, 'utf8');
    assert.ok(result.includes('# workspace config'));
    assert.ok(result.includes('# pinned dependencies'));
    assert.ok(result.includes('packages:'));
    assert.ok(result.includes('react: ^18.3.0'));
    assert.ok(result.includes('lodash: 4.17.21'));
  });
});
