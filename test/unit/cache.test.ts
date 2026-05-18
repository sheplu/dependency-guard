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
});
