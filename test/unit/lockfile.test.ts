import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { expandWithLockfile } from '../../src/lockfile.ts';
import type { DependencyEntry } from '../../src/package-json.ts';

const directExpress: DependencyEntry = {
  name: 'express',
  type: 'dependencies',
  spec: '^4.18.0',
  installedVersion: '4.18.2',
  transitive: false,
};

describe('expandWithLockfile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-lock-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeLock(lock: unknown) {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
  }

  it('returns input unchanged when no lockfile is present', async () => {
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged when JSON is malformed', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{not json');
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged for lockfileVersion < 3', async () => {
    await writeLock({ lockfileVersion: 2, packages: {} });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged when lockfileVersion is missing', async () => {
    await writeLock({ packages: {} });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('walks a 2-level dependency tree', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          dependencies: { 'body-parser': '1.20.0' },
        },
        'node_modules/body-parser': {
          version: '1.20.0',
          dependencies: { qs: '6.10.0' },
        },
        'node_modules/qs': { version: '6.10.0' },
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.equal(out.length, 3);
    assert.equal(out[0], directExpress);
    assert.deepEqual(
      out.slice(1).map((d) => [d.name, d.transitive, d.installedVersion]),
      [
        ['body-parser', true, '1.20.0'],
        ['qs', true, '6.10.0'],
      ],
    );
  });

  it('dedupes when two direct deps share a transitive', async () => {
    const directA: DependencyEntry = {
      name: 'a',
      type: 'dependencies',
      spec: '1.0.0',
      installedVersion: '1.0.0',
      transitive: false,
    };
    const directB: DependencyEntry = {
      name: 'b',
      type: 'dependencies',
      spec: '1.0.0',
      installedVersion: '1.0.0',
      transitive: false,
    };
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/a': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
        'node_modules/b': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
        'node_modules/shared': { version: '2.0.0' },
      },
    });
    const out = await expandWithLockfile([directA, directB], dir);
    assert.equal(out.filter((d) => d.name === 'shared').length, 1);
  });

  it('honors optionalDependencies of intermediate nodes', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          optionalDependencies: { 'opt-helper': '1.0.0' },
        },
        'node_modules/opt-helper': { version: '1.0.0' },
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(
      out.map((d) => d.name),
      ['express', 'opt-helper'],
    );
  });

  it('skips a transitive that has no version entry in the lockfile', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          dependencies: { phantom: '1.0.0' },
        },
        // phantom is referenced but has no entry — skip it
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(
      out.map((d) => d.name),
      ['express'],
    );
  });

  it('skips a direct dep with no lockfile entry (no expansion from it)', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        // no node_modules/express entry — direct dep can't be expanded
        'node_modules/lodash': { version: '4.17.21' },
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(
      out.map((d) => d.name),
      ['express'],
    );
  });

  it('does not re-add a direct dep as a transitive', async () => {
    const directBodyParser: DependencyEntry = {
      name: 'body-parser',
      type: 'dependencies',
      spec: '1.20.0',
      installedVersion: '1.20.0',
      transitive: false,
    };
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          dependencies: { 'body-parser': '1.20.0' },
        },
        'node_modules/body-parser': { version: '1.20.0' },
      },
    });
    const out = await expandWithLockfile([directExpress, directBodyParser], dir);
    assert.equal(out.length, 2);
    assert.equal(out[1].transitive, false); // body-parser stays as direct
  });

  it('inherits parent direct dep type for transitives', async () => {
    const directDev: DependencyEntry = {
      name: 'typescript',
      type: 'devDependencies',
      spec: '5.0.0',
      installedVersion: '5.0.0',
      transitive: false,
    };
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/typescript': {
          version: '5.0.0',
          dependencies: { 'ts-helper': '1.0.0' },
        },
        'node_modules/ts-helper': { version: '1.0.0' },
      },
    });
    const out = await expandWithLockfile([directDev], dir);
    const helper = out.find((d) => d.name === 'ts-helper');
    assert.equal(helper?.type, 'devDependencies');
  });
});
