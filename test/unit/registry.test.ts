import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Cache } from '../../src/cache.ts';
import { RegistryClient } from '../../src/registry.ts';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('RegistryClient', () => {
  it('returns cached value without calling fetch', async () => {
    const cache = new Cache({ dir: '/tmp/dep-guard-test-' + Math.random() });
    await cache.set('demo', { name: 'demo', versions: ['1.0.0'], time: {} });

    let called = 0;
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() => {
        called++;
        return Promise.resolve(jsonResponse({}));
      }) as typeof fetch,
    });

    const meta = await client.getPackage('demo');
    assert.equal(called, 0);
    assert.deepEqual(meta.versions, ['1.0.0']);
  });

  it('throws when the registry returns a non-OK response', async () => {
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: (() =>
        Promise.resolve(
          new Response('not found', { status: 404, statusText: 'Not Found' }),
        )) as typeof fetch,
    });

    await assert.rejects(() => client.getPackage('missing'), /Registry request failed.*404/);
  });

  it('encodes scoped package names with the slash preserved', async () => {
    let calledUrl = '';
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: ((url: string) => {
        calledUrl = url;
        return Promise.resolve(
          jsonResponse({ name: '@scope/pkg', versions: { '1.0.0': {} }, time: {} }),
        );
      }) as unknown as typeof fetch,
    });

    await client.getPackage('@scope/pkg');
    assert.equal(calledUrl, 'http://example.invalid/@scope/pkg');
  });

  it('works without a cache configured', async () => {
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse({ name: 'demo', versions: { '1.0.0': {} }, time: {} }),
        )) as typeof fetch,
    });

    const meta = await client.getPackage('demo');
    assert.deepEqual(meta.versions, ['1.0.0']);
  });

  it('encodes unscoped package names', async () => {
    let calledUrl = '';
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: ((url: string) => {
        calledUrl = url;
        return Promise.resolve(jsonResponse({ name: 'lodash', versions: {}, time: {} }));
      }) as unknown as typeof fetch,
    });

    await client.getPackage('lodash');
    assert.equal(calledUrl, 'http://example.invalid/lodash');
  });

  it('handles malformed scoped name with no slash by URL-encoding', async () => {
    let calledUrl = '';
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: ((url: string) => {
        calledUrl = url;
        return Promise.resolve(jsonResponse({ name: '@oddball', versions: {}, time: {} }));
      }) as unknown as typeof fetch,
    });

    await client.getPackage('@oddball');
    assert.equal(calledUrl, 'http://example.invalid/%40oddball');
  });

  it('falls back to provided name when registry omits name', async () => {
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: (() =>
        Promise.resolve(jsonResponse({}))) as typeof fetch,
    });

    const meta = await client.getPackage('mystery');
    assert.equal(meta.name, 'mystery');
    assert.deepEqual(meta.versions, []);
    assert.deepEqual(meta.time, {});
  });

  it('extracts non-empty deprecated strings into the deprecations map', async () => {
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse({
            name: 'demo',
            versions: {
              '1.0.0': {},
              '2.0.0': { deprecated: 'use newer' },
              '2.1.0': { deprecated: '' }, // empty: ignored
              '2.2.0': { deprecated: 42 },  // non-string: ignored
            },
            time: {},
          }),
        )) as typeof fetch,
    });

    const meta = await client.getPackage('demo');
    assert.deepEqual(meta.deprecations, { '2.0.0': 'use newer' });
  });

  it('parses registry response into metadata shape', async () => {
    const client = new RegistryClient({
      baseUrl: 'http://example.invalid',
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse({
            name: 'demo',
            versions: { '1.0.0': {}, '2.0.0': {} },
            time: { '1.0.0': '2026-01-01T00:00:00Z' },
          }),
        )) as typeof fetch,
    });

    const meta = await client.getPackage('demo');
    assert.equal(meta.name, 'demo');
    assert.deepEqual(meta.versions.toSorted(), ['1.0.0', '2.0.0']);
    assert.equal(meta.time['1.0.0'], '2026-01-01T00:00:00Z');
  });
});
