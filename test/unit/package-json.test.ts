import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { collectDependencies, collectOverrides } from '../../src/package-json.ts';

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
    });
    const lodash = entries.find((e) => e.name === 'lodash');
    assert.equal(lodash?.installedVersion, '4.17.21');
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
});
