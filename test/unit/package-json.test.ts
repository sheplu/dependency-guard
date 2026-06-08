import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  TYPE_ORDER,
  collectDependencies,
  collectOverrides,
  collectPnpmOverrides,
  collectResolutions,
  isCatalogSpec,
} from '../../src/package-json.ts';

describe('collectDependencies', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-pj-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { express: '^4.18.0', lodash: '4.17.21' },
        devDependencies: { typescript: '^5.0.0' },
        peerDependencies: { react: '^18.0.0' },
      }),
    );
    await mkdir(join(dir, 'node_modules', 'express'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'express', 'package.json'),
      JSON.stringify({ name: 'express', version: '4.18.2' }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns all buckets when no filter is set', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    const names = entries.map((e) => e.name).toSorted();
    assert.deepEqual(names, ['express', 'lodash', 'react', 'typescript']);
  });

  it('groups by dependency type, alphabetical within each group', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    assert.deepEqual(
      entries.map((e) => [e.type, e.name]),
      [
        ['dependencies', 'express'],
        ['dependencies', 'lodash'],
        ['devDependencies', 'typescript'],
        ['peerDependencies', 'react'],
      ],
    );
  });

  it('filters to prod only when --prod is set', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: true,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    assert.deepEqual(
      entries.map((e) => e.name).toSorted(),
      ['express', 'lodash'],
    );
  });

  it('uses installed version from node_modules when present', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: true,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    const express = entries.find((e) => e.name === 'express');
    assert.equal(express?.installedVersion, '4.18.2');
  });

  it('filters to dev only when --dev is set', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: false,
      dev: true,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    assert.deepEqual(entries.map((e) => e.name), ['typescript']);
  });

  it('filters to peer only when --peer is set', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: false,
      dev: false,
      peer: true,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    assert.deepEqual(entries.map((e) => e.name), ['react']);
  });

  it('skips empty buckets without error when --optional is set but none defined', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: false,
      dev: false,
      peer: false,
      optional: true,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    assert.deepEqual(entries, []);
  });

  it('falls back to spec when installed package.json is corrupt', async () => {
    await mkdir(join(dir, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'lodash', 'package.json'), '{not-json');
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: true,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    const lodash = entries.find((e) => e.name === 'lodash');
    assert.equal(lodash?.installedVersion, '4.17.21');
  });

  it('falls back to spec when installed package.json has no version field', async () => {
    await mkdir(join(dir, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'lodash', 'package.json'),
      JSON.stringify({ name: 'lodash' }),
    );
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: true,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    const lodash = entries.find((e) => e.name === 'lodash');
    assert.equal(lodash?.installedVersion, '4.17.21');
  });

  it('falls back to spec stripped of range when not installed', async () => {
    const { entries } = await collectDependencies(join(dir, 'package.json'), {
      prod: true,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
    });
    const lodash = entries.find((e) => e.name === 'lodash');
    assert.equal(lodash?.installedVersion, '4.17.21');
  });

  it('skips catalog: deps and surfaces them in skipped', async () => {
    const catalogDir = await mkdtemp(join(tmpdir(), 'dep-guard-catalog-'));
    try {
      await writeFile(
        join(catalogDir, 'package.json'),
        JSON.stringify({
          name: 'fixture-catalog',
          dependencies: { react: '^18.0.0' },
          devDependencies: { typescript: 'catalog:', '@types/node': 'catalog:tooling' },
        }),
      );
      const { entries, skipped } = await collectDependencies(
        join(catalogDir, 'package.json'),
        { prod: false, dev: false, peer: false, optional: false, overrides: false, resolutions: false, pnpmOverrides: false },
      );
      assert.deepEqual(entries.map((e) => e.name), ['react']);
      assert.deepEqual(
        skipped.toSorted((a, b) => a.name.localeCompare(b.name)),
        [
          { name: '@types/node', type: 'devDependencies', reason: 'catalog' },
          { name: 'typescript', type: 'devDependencies', reason: 'catalog' },
        ],
      );
    } finally {
      await rm(catalogDir, { recursive: true, force: true });
    }
  });
});

describe('collectOverrides', () => {
  it('returns empty for undefined input', () => {
    assert.deepEqual(collectOverrides(undefined), { entries: [], skipped: [] });
  });

  it('returns empty for empty object', () => {
    assert.deepEqual(collectOverrides({}), { entries: [], skipped: [] });
  });

  it('analyzes top-level string pin', () => {
    const { entries, skipped } = collectOverrides({ lodash: '4.17.21' });
    assert.deepEqual(entries, [{ name: 'lodash', version: '4.17.21' }]);
    assert.deepEqual(skipped, []);
  });

  it('analyzes the "." key when present', () => {
    const { entries, skipped } = collectOverrides({
      foo: { '.': '2.0.0' },
    });
    assert.deepEqual(entries, [{ name: 'foo', version: '2.0.0' }]);
    assert.deepEqual(skipped, []);
  });

  it('skips reference syntax ($name) at the top level', () => {
    const { entries, skipped } = collectOverrides({ baz: '$lodash' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'baz', reason: 'override-reference' }]);
  });

  it('skips reference syntax inside the "." key', () => {
    const { entries, skipped } = collectOverrides({
      baz: { '.': '$lodash' },
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'baz', reason: 'override-reference' }]);
  });

  it('skips path-specific overrides (object without ".")', () => {
    const { entries, skipped } = collectOverrides({
      foo: { bar: '1.0.0' },
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'foo', reason: 'override-path-specific' }]);
  });

  it('analyzes "." even when path-specific siblings exist', () => {
    const { entries, skipped } = collectOverrides({
      foo: { '.': '2.0.0', bar: '1.0.0' },
    });
    assert.deepEqual(entries, [{ name: 'foo', version: '2.0.0' }]);
    assert.deepEqual(skipped, []);
  });

  it('skips non-semver descriptor values at the top level (npm:, file:, etc.)', () => {
    const { entries, skipped } = collectOverrides({
      tarballed: 'file:./vendor/tarball.tgz',
      aliased: 'npm:@myorg/lodash@^4.0.0',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'tarballed', reason: 'override-descriptor' },
      { name: 'aliased', reason: 'override-descriptor' },
    ]);
  });

  it('skips non-semver descriptor values inside the "." key', () => {
    const { entries, skipped } = collectOverrides({
      foo: { '.': 'file:./vendor/tarball.tgz' },
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'foo', reason: 'override-descriptor' }]);
  });

  it('skips catalog: default reference', () => {
    const { entries, skipped } = collectOverrides({ typescript: 'catalog:' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'typescript', reason: 'catalog' }]);
  });

  it('skips catalog:name named reference', () => {
    const { entries, skipped } = collectOverrides({ zod: 'catalog:react18' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'zod', reason: 'catalog' }]);
  });

  it('skips catalog: inside the "." key', () => {
    const { entries, skipped } = collectOverrides({ foo: { '.': 'catalog:' } });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'foo', reason: 'catalog' }]);
  });
});

describe('collectResolutions', () => {
  it('returns empty for undefined input', () => {
    assert.deepEqual(collectResolutions(undefined), { entries: [], skipped: [] });
  });

  it('returns empty for empty object', () => {
    assert.deepEqual(collectResolutions({}), { entries: [], skipped: [] });
  });

  it('analyzes a top-level string pin', () => {
    const { entries, skipped } = collectResolutions({ lodash: '4.17.21' });
    assert.deepEqual(entries, [{ name: 'lodash', version: '4.17.21' }]);
    assert.deepEqual(skipped, []);
  });

  it('analyzes a scoped pin', () => {
    const { entries, skipped } = collectResolutions({ '@babel/core': '7.22.0' });
    assert.deepEqual(entries, [{ name: '@babel/core', version: '7.22.0' }]);
    assert.deepEqual(skipped, []);
  });

  it('skips parent/child path-specific keys', () => {
    const { entries, skipped } = collectResolutions({
      'webpack/memory-fs': '0.4.1',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'webpack/memory-fs', reason: 'override-path-specific' },
    ]);
  });

  it('skips glob keys', () => {
    const { entries, skipped } = collectResolutions({
      'c/**/left-pad': '^1.1.2',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'c/**/left-pad', reason: 'override-path-specific' },
    ]);
  });

  it('skips pkg@range/child descriptor keys', () => {
    const { entries, skipped } = collectResolutions({
      '@babel/core@npm:7.0.0/@babel/generator': '7.20.0',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      {
        name: '@babel/core@npm:7.0.0/@babel/generator',
        reason: 'override-path-specific',
      },
    ]);
  });

  it('skips npm: aliased descriptor values', () => {
    const { entries, skipped } = collectResolutions({
      pinned: 'npm:foo@1.0.0',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'pinned', reason: 'override-descriptor' },
    ]);
  });

  it('skips file: descriptor values', () => {
    const { entries, skipped } = collectResolutions({
      tarballed: 'file:./vendor/tarball.tgz',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'tarballed', reason: 'override-descriptor' },
    ]);
  });

  it('skips non-string values defensively (path-specific)', () => {
    const { entries, skipped } = collectResolutions({
      // @ts-expect-error simulating a malformed manifest
      bad: 42,
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'bad', reason: 'override-path-specific' }]);
  });

  it('skips empty-string values as descriptor (defensive)', () => {
    const { entries, skipped } = collectResolutions({ empty: '' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'empty', reason: 'override-descriptor' }]);
  });

  it('skips a "-" value as descriptor (yarn ignores pnpm syntax)', () => {
    const { entries, skipped } = collectResolutions({ dash: '-' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'dash', reason: 'override-descriptor' }]);
  });

  it('skips a "$name" value as descriptor (yarn ignores pnpm syntax)', () => {
    const { entries, skipped } = collectResolutions({ ref: '$lodash' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'ref', reason: 'override-descriptor' }]);
  });

  it('skips catalog: default reference', () => {
    const { entries, skipped } = collectResolutions({ typescript: 'catalog:' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'typescript', reason: 'catalog' }]);
  });

  it('skips catalog:name named reference', () => {
    const { entries, skipped } = collectResolutions({ zod: 'catalog:react18' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'zod', reason: 'catalog' }]);
  });
});

describe('collectPnpmOverrides', () => {
  it('returns empty for undefined input', () => {
    assert.deepEqual(collectPnpmOverrides(undefined), { entries: [], skipped: [] });
  });

  it('returns empty for empty object', () => {
    assert.deepEqual(collectPnpmOverrides({}), { entries: [], skipped: [] });
  });

  it('analyzes a top-level string pin', () => {
    const { entries, skipped } = collectPnpmOverrides({ axios: '1.5.0' });
    assert.deepEqual(entries, [{ name: 'axios', version: '1.5.0' }]);
    assert.deepEqual(skipped, []);
  });

  it('analyzes a scoped pin', () => {
    const { entries, skipped } = collectPnpmOverrides({ '@scope/foo': '1.0.0' });
    assert.deepEqual(entries, [{ name: '@scope/foo', version: '1.0.0' }]);
    assert.deepEqual(skipped, []);
  });

  it('skips parent>child path-specific keys', () => {
    const { entries, skipped } = collectPnpmOverrides({
      'qar>zoo': '2.0.0',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'qar>zoo', reason: 'override-path-specific' }]);
  });

  it('skips pkg@range version-qualified keys', () => {
    const { entries, skipped } = collectPnpmOverrides({
      'bar@^2.1.0': '3.0.0',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'bar@^2.1.0', reason: 'override-path-specific' },
    ]);
  });

  it('skips $name reference values', () => {
    const { entries, skipped } = collectPnpmOverrides({ ref: '$lodash' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'ref', reason: 'override-reference' }]);
  });

  it('skips "-" removal values', () => {
    const { entries, skipped } = collectPnpmOverrides({ removed: '-' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'removed', reason: 'override-removal' }]);
  });

  it('skips npm: descriptor values', () => {
    const { entries, skipped } = collectPnpmOverrides({
      aliased: 'npm:@myorg/quux@^1.0.0',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { name: 'aliased', reason: 'override-descriptor' },
    ]);
  });

  it('skips workspace: descriptor values', () => {
    const { entries, skipped } = collectPnpmOverrides({
      ws: 'workspace:*',
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'ws', reason: 'override-descriptor' }]);
  });

  it('skips non-string values defensively', () => {
    const { entries, skipped } = collectPnpmOverrides({
      // @ts-expect-error simulating a malformed manifest
      bad: 42,
    });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'bad', reason: 'override-descriptor' }]);
  });

  it('skips catalog: default reference', () => {
    const { entries, skipped } = collectPnpmOverrides({ typescript: 'catalog:' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'typescript', reason: 'catalog' }]);
  });

  it('skips catalog:name named reference', () => {
    const { entries, skipped } = collectPnpmOverrides({ zod: 'catalog:react18' });
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [{ name: 'zod', reason: 'catalog' }]);
  });
});

describe('TYPE_ORDER', () => {
  it('includes catalog at position 7', () => {
    assert.equal(TYPE_ORDER['catalog'], 7);
  });

  it('catalog sorts after pnpm.overrides', () => {
    assert.ok(TYPE_ORDER['catalog'] > TYPE_ORDER['pnpm.overrides']);
  });
});

describe('isCatalogSpec', () => {
  it('returns true for catalog: (default)', () => {
    assert.equal(isCatalogSpec('catalog:'), true);
  });

  it('returns true for catalog:name (named)', () => {
    assert.equal(isCatalogSpec('catalog:tooling'), true);
  });

  it('returns false for regular semver specs', () => {
    assert.equal(isCatalogSpec('^1.0.0'), false);
    assert.equal(isCatalogSpec('1.0.0'), false);
    assert.equal(isCatalogSpec('workspace:*'), false);
  });
});
