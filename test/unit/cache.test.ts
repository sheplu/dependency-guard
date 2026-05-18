import { strict as assert } from 'node:assert';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Cache } from '../../src/cache.ts';

describe('Cache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when key is missing', async () => {
    const cache = new Cache({ dir });
    assert.equal(await cache.get('missing'), null);
  });

  it('round-trips a value', async () => {
    const cache = new Cache({ dir });
    await cache.set('pkg', { hello: 'world' });
    assert.deepEqual(await cache.get('pkg'), { hello: 'world' });
  });

  it('expires entries past TTL', async () => {
    const cache = new Cache({ dir, ttlMs: 1000 });
    await cache.set('pkg', { hello: 'world' });
    const file = cache.fileFor('pkg');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(file, past, past);
    assert.equal(await cache.get('pkg'), null);
  });

  it('skips read and write when disabled', async () => {
    const cache = new Cache({ dir, enabled: false });
    await cache.set('pkg', { hello: 'world' });
    assert.equal(await cache.get('pkg'), null);
  });

  it('sanitizes unsafe key characters', () => {
    const cache = new Cache({ dir });
    assert.match(cache.fileFor('@scope/pkg'), /_scope_pkg\.json$/);
  });

  it('clear() removes the cache directory', async () => {
    const cache = new Cache({ dir });
    await cache.set('pkg', { hello: 'world' });
    await cache.clear();
    assert.equal(await cache.get('pkg'), null);
  });

  it('clear() is a no-op when the directory does not exist', async () => {
    const missing = join(dir, 'nope');
    const cache = new Cache({ dir: missing });
    await cache.clear();
    assert.equal(await cache.get('anything'), null);
  });

  it('honors DEPENDENCY_GUARD_CACHE_DIR when no dir option is given', () => {
    const original = process.env.DEPENDENCY_GUARD_CACHE_DIR;
    process.env.DEPENDENCY_GUARD_CACHE_DIR = '/tmp/from-env';
    try {
      const cache = new Cache();
      assert.equal(cache.dir, '/tmp/from-env');
    } finally {
      if (original === undefined) delete process.env.DEPENDENCY_GUARD_CACHE_DIR;
      else process.env.DEPENDENCY_GUARD_CACHE_DIR = original;
    }
  });
});
