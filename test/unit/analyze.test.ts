import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runAnalysis } from '../../src/analyze.ts';
import { Cache } from '../../src/cache.ts';
import { RegistryClient } from '../../src/registry.ts';

describe('runAnalysis', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-analyze-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('wraps registry errors with the offending package name', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { broken: '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() => Promise.reject(new Error('network down'))) as typeof fetch,
    });

    await assert.rejects(
      () =>
        runAnalysis(
          {
            path: join(dir, 'package.json'),
            format: 'json',
            prod: false,
            dev: false,
            peer: false,
            optional: false,
            cache: false,
            cacheTtlMinutes: 60,
            ignoredScopes: [],
            quiet: false,
            failOnLevel: null,
            maxAgeDays: null,
            sortBy: null,
          },
          { registry, cache },
        ),
      /Failed to analyze broken: network down/,
    );
  });

  it('wraps non-Error rejections from the registry', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { broken: '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      // Reject with a non-Error value to exercise the String(err) branch
      fetchImpl: (() => Promise.reject('boom')) as typeof fetch,
    });

    await assert.rejects(
      () =>
        runAnalysis(
          {
            path: join(dir, 'package.json'),
            format: 'json',
            prod: false,
            dev: false,
            peer: false,
            optional: false,
            cache: false,
            cacheTtlMinutes: 60,
            ignoredScopes: [],
            quiet: false,
            failOnLevel: null,
            maxAgeDays: null,
            sortBy: null,
          },
          { registry, cache },
        ),
      /Failed to analyze broken: boom/,
    );
  });

  it('handles a registry response with no stable versions', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'pre-only': '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              name: 'pre-only',
              versions: { '1.0.0-beta.1': {} },
              time: { '1.0.0-beta.1': '2026-01-01T00:00:00Z' },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof fetch,
    });

    const report = await runAnalysis(
      {
        path: join(dir, 'package.json'),
        format: 'json',
        prod: false,
        dev: false,
        peer: false,
        optional: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: [],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
      },
      { registry, cache },
    );

    assert.equal(report.dependencies.length, 1);
    const dep = report.dependencies[0];
    assert.equal(dep.updateType, 'up-to-date');
    assert.equal(dep.latestMinor, null);
    assert.equal(dep.latestMajor, null);
    // ageInDays and latestAgeInDays mirror each other when no stable upgrade exists
    assert.equal(dep.ageInDays, dep.latestAgeInDays);
  });

  it('skips packages matching --ignore-scope and reports them in skipped', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { '@private/foo': '1.0.0', '@private/bar': '2.0.0' },
        devDependencies: { '@other/baz': '3.0.0' },
      }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    let fetchCalls = 0;
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((_url: string) => {
        fetchCalls++;
        return Promise.resolve(
          new Response(
            JSON.stringify({ name: '@other/baz', versions: { '3.0.0': {} }, time: { '3.0.0': '2026-01-01T00:00:00Z' } }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      {
        path: join(dir, 'package.json'),
        format: 'json',
        prod: false,
        dev: false,
        peer: false,
        optional: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: ['@private'],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
      },
      { registry, cache },
    );

    assert.equal(fetchCalls, 1, 'only the non-ignored package should hit the registry');
    assert.equal(report.summary.total, 1);
    assert.equal(report.dependencies.length, 1);
    assert.equal(report.dependencies[0].name, '@other/baz');
    assert.deepEqual(report.skipped, [
      { name: '@private/bar', type: 'dependencies', scope: '@private' },
      { name: '@private/foo', type: 'dependencies', scope: '@private' },
    ]);
  });

  it('tags each skipped entry with the matching scope, not the first', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { '@a/x': '1.0.0', '@b/y': '1.0.0' },
      }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() => Promise.reject(new Error('should not be called'))) as typeof fetch,
    });

    const report = await runAnalysis(
      {
        path: join(dir, 'package.json'),
        format: 'json',
        prod: false,
        dev: false,
        peer: false,
        optional: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: ['@a', '@b'],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
      },
      { registry, cache },
    );

    const byName = new Map(report.skipped.map((s) => [s.name, s.scope]));
    assert.equal(byName.get('@a/x'), '@a');
    assert.equal(byName.get('@b/y'), '@b');
  });

  it('returns empty skipped when no scopes ignored', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.17.21' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ name: 'lodash', versions: { '4.17.21': {} }, time: { '4.17.21': '2024-01-01T00:00:00Z' } }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof fetch,
    });

    const report = await runAnalysis(
      {
        path: join(dir, 'package.json'),
        format: 'json',
        prod: false,
        dev: false,
        peer: false,
        optional: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: [],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
      },
      { registry, cache },
    );

    assert.deepEqual(report.skipped, []);
    assert.equal(report.dependencies.length, 1);
  });
});

describe('runAnalysis sorting', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-sort-'));
    // Fixture: 3 deps spanning prod/dev/peer with varied updateType + age.
    //   beta-prod    (dependencies)        major upgrade, 60d old
    //   alpha-dev    (devDependencies)     minor upgrade, 200d old
    //   gamma-peer   (peerDependencies)    up-to-date,    10d old
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'beta-prod': '1.0.0' },
        devDependencies: { 'alpha-dev': '2.0.0' },
        peerDependencies: { 'gamma-peer': '3.0.0' },
      }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRegistry(now: Date) {
    const sub = (days: number) =>
      new Date(now.getTime() - days * 86_400_000).toISOString();
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const payload =
          name === 'beta-prod'
            ? {
                name,
                versions: { '1.0.0': {}, '2.0.0': {} },
                time: { '1.0.0': sub(60), '2.0.0': sub(5) },
              }
            : name === 'alpha-dev'
              ? {
                  name,
                  versions: { '2.0.0': {}, '2.5.0': {} },
                  time: { '2.0.0': sub(200), '2.5.0': sub(15) },
                }
              : {
                  name,
                  versions: { '3.0.0': {} },
                  time: { '3.0.0': sub(10) },
                };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof fetch,
    });
    return { cache, registry };
  }

  function baseOptions(sortBy: 'age' | 'status' | 'name' | null) {
    return {
      path: join(dir, 'package.json'),
      format: 'json' as const,
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      cache: false,
      cacheTtlMinutes: 60,
      ignoredScopes: [],
      quiet: false,
      failOnLevel: null,
      maxAgeDays: null,
      sortBy,
    };
  }

  it('sortBy null preserves the type-then-name order from collectDependencies', async () => {
    const now = new Date('2026-05-18T00:00:00Z');
    const { cache, registry } = makeRegistry(now);
    const report = await runAnalysis(baseOptions(null), { registry, cache, now });
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['beta-prod', 'alpha-dev', 'gamma-peer'],
    );
  });

  it('sortBy "name" produces strict alphabetical, ignoring type', async () => {
    const now = new Date('2026-05-18T00:00:00Z');
    const { cache, registry } = makeRegistry(now);
    const report = await runAnalysis(baseOptions('name'), { registry, cache, now });
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['alpha-dev', 'beta-prod', 'gamma-peer'],
    );
  });

  it('sortBy "status" orders major → minor → up-to-date with name tiebreak', async () => {
    const now = new Date('2026-05-18T00:00:00Z');
    const { cache, registry } = makeRegistry(now);
    const report = await runAnalysis(baseOptions('status'), { registry, cache, now });
    assert.deepEqual(
      report.dependencies.map((d) => [d.name, d.updateType]),
      [
        ['beta-prod', 'major'],
        ['alpha-dev', 'minor'],
        ['gamma-peer', 'up-to-date'],
      ],
    );
  });

  it('sortBy "age" orders oldest installed first', async () => {
    const now = new Date('2026-05-18T00:00:00Z');
    const { cache, registry } = makeRegistry(now);
    const report = await runAnalysis(baseOptions('age'), { registry, cache, now });
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['alpha-dev', 'beta-prod', 'gamma-peer'],
    );
  });

  it('sortBy "age" keeps a dated dep above a null-age dep (bAge=null branch)', async () => {
    // Alphabetically-first has a non-null age → comparator's `aAge` is non-null
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'a-dated': '1.0.0', 'z-null': '2.0.0' },
      }),
    );
    const now = new Date('2026-05-18T00:00:00Z');
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const payload =
          name === 'a-dated'
            ? {
                name,
                versions: { '1.0.0': {} },
                time: { '1.0.0': new Date(now.getTime() - 50 * 86_400_000).toISOString() },
              }
            : { name, versions: { '2.0.0': {} }, time: {} };
        return Promise.resolve(
          new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
        );
      }) as unknown as typeof fetch,
    });
    const report = await runAnalysis(baseOptions('age'), { registry, cache, now });
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['a-dated', 'z-null'],
    );
  });

  it('sortBy "age" pushes a null-age dep below a dated one (aAge=null branch)', async () => {
    // Two prod deps; alphabetically-first has null age → comparator sees aAge=null first
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'a-null': '1.0.0', 'z-dated': '2.0.0' },
      }),
    );
    const now = new Date('2026-05-18T00:00:00Z');
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const payload =
          name === 'a-null'
            ? { name, versions: { '1.0.0': {} }, time: {} }
            : {
                name,
                versions: { '2.0.0': {} },
                time: { '2.0.0': new Date(now.getTime() - 100 * 86_400_000).toISOString() },
              };
        return Promise.resolve(
          new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
        );
      }) as unknown as typeof fetch,
    });
    const report = await runAnalysis(baseOptions('age'), { registry, cache, now });
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['z-dated', 'a-null'],
    );
  });

  it('sortBy "age" handles two deps with null ageInDays (stable, name tiebreak)', async () => {
    const now = new Date('2026-05-18T00:00:00Z');
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      // Empty time map for ALL packages → every ageInDays is null
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const versionMap: Record<string, Record<string, unknown>> = {
          'beta-prod': { '1.0.0': {} },
          'alpha-dev': { '2.0.0': {} },
          'gamma-peer': { '3.0.0': {} },
        };
        return Promise.resolve(
          new Response(
            JSON.stringify({ name, versions: versionMap[name] ?? {}, time: {} }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });
    const report = await runAnalysis(baseOptions('age'), { registry, cache, now });
    // All ages are null → name tiebreak alone
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['alpha-dev', 'beta-prod', 'gamma-peer'],
    );
  });

  it('sortBy "age" sorts deps with null ageInDays to the bottom', async () => {
    const now = new Date('2026-05-18T00:00:00Z');
    // override one package to have no time entry for its current version
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        if (name === 'beta-prod') {
          // No `time` entries → ageInDays will be null
          return Promise.resolve(
            new Response(
              JSON.stringify({ name, versions: { '1.0.0': {} }, time: {} }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        const sub = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
        const payload =
          name === 'alpha-dev'
            ? { name, versions: { '2.0.0': {} }, time: { '2.0.0': sub(200) } }
            : { name, versions: { '3.0.0': {} }, time: { '3.0.0': sub(10) } };
        return Promise.resolve(
          new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
        );
      }) as unknown as typeof fetch,
    });
    const report = await runAnalysis(baseOptions('age'), { registry, cache, now });
    const names = report.dependencies.map((d) => d.name);
    // alpha-dev (200d) first, gamma-peer (10d) second, beta-prod (null) last
    assert.deepEqual(names, ['alpha-dev', 'gamma-peer', 'beta-prod']);
  });
});
