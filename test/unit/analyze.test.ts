import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isOverrideType, runAnalysis } from '../../src/analyze.ts';
import { Cache } from '../../src/cache.ts';
import { RegistryClient } from '../../src/registry.ts';
import type { CliOptions } from '../../src/types.ts';

function baseAnalyzeOptions(path: string): CliOptions {
  return {
    path,
    format: 'json',
    prod: false,
    dev: false,
    peer: false,
    optional: false,
    overrides: false,
    resolutions: false,
    pnpmOverrides: false,
    cache: false,
    cacheTtlMinutes: 60,
    ignoredScopes: [],
    quiet: false,
    failOnLevel: null,
    maxAgeDays: null,
    sortBy: null,
    registryUrl: null,
    includeTransitive: false,
    updateLevel: null,
    dryRun: false,
    allColumns: false,
    releaseAge: true,
    showTrueLatest: false,
    onlyNames: [],
  };
}

function fetchByName(
  responder: (name: string) => { status?: number; body?: unknown },
): typeof fetch {
  return ((url: string) => {
    const name = decodeURIComponent(url.split('/').pop() ?? '');
    const { status = 200, body = { name, versions: { '1.0.0': {} }, time: { '1.0.0': '2026-01-01T00:00:00Z' } } } =
      responder(name);
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        statusText: status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : 'OK',
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

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
            overrides: false,
            resolutions: false,
            pnpmOverrides: false,
            cache: false,
            cacheTtlMinutes: 60,
            ignoredScopes: [],
            quiet: false,
            failOnLevel: null,
            maxAgeDays: null,
            sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,            onlyNames: [],
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
            overrides: false,
            resolutions: false,
            pnpmOverrides: false,
            cache: false,
            cacheTtlMinutes: 60,
            ignoredScopes: [],
            quiet: false,
            failOnLevel: null,
            maxAgeDays: null,
            sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,            onlyNames: [],
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
        overrides: false,
        resolutions: false,
        pnpmOverrides: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: [],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,        onlyNames: [],
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
        overrides: false,
        resolutions: false,
        pnpmOverrides: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: ['@private'],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,        onlyNames: [],
      },
      { registry, cache },
    );

    assert.equal(fetchCalls, 1, 'only the non-ignored package should hit the registry');
    assert.equal(report.summary.total, 1);
    assert.equal(report.dependencies.length, 1);
    assert.equal(report.dependencies[0].name, '@other/baz');
    assert.deepEqual(report.skipped, [
      { name: '@private/bar', type: 'dependencies', reason: 'ignored-scope', scope: '@private' },
      { name: '@private/foo', type: 'dependencies', reason: 'ignored-scope', scope: '@private' },
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
        overrides: false,
        resolutions: false,
        pnpmOverrides: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: ['@a', '@b'],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,        onlyNames: [],
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
        overrides: false,
        resolutions: false,
        pnpmOverrides: false,
        cache: false,
        cacheTtlMinutes: 60,
        ignoredScopes: [],
        quiet: false,
        failOnLevel: null,
        maxAgeDays: null,
        sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,        onlyNames: [],
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
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
      cache: false,
      cacheTtlMinutes: 60,
      ignoredScopes: [],
      onlyNames: [],
      quiet: false,
      failOnLevel: null,
      maxAgeDays: null,
      sortBy,
      registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,    };
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

describe('runAnalysis --only filter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-only-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRegistry() {
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        return Promise.resolve(
          new Response(
            JSON.stringify({ name, versions: { '1.0.0': {} }, time: { '1.0.0': '2026-01-01T00:00:00Z' } }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });
    return { cache, registry };
  }

  function makeOptions(overrides: Partial<{
    prod: boolean;
    onlyNames: string[];
    ignoredScopes: string[];
    includeTransitive: boolean;
  }> = {}) {
    return {
      path: join(dir, 'package.json'),
      format: 'json' as const,
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
      cache: false,
      cacheTtlMinutes: 60,
      ignoredScopes: [],
      onlyNames: [],
      quiet: false,
      failOnLevel: null,
      maxAgeDays: null,
      sortBy: null,
            registryUrl: null,
            includeTransitive: false,
            updateLevel: null,
            dryRun: false,
            allColumns: false,
            releaseAge: true,
            showTrueLatest: false,      ...overrides,
    };
  }

  it('keeps only matching packages and drops the rest', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '1.0.0', lodash: '1.0.0' },
        devDependencies: { typescript: '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ onlyNames: ['express'] }),
      { registry, cache },
    );
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['express'],
    );
  });

  it('does not include unmatched names in the report (caller warns separately)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '1.0.0' } }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ onlyNames: ['express', 'nonexistent'] }),
      { registry, cache },
    );
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['express'],
    );
  });

  it('--ignore-scope wins over --only when both match (privacy first)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@private/foo': '1.0.0' } }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ ignoredScopes: ['@private'], onlyNames: ['@private/foo'] }),
      { registry, cache },
    );
    assert.deepEqual(report.dependencies, []);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].name, '@private/foo');
  });

  it('--only AND --prod: dev-only --only target is dropped', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '1.0.0' },
        devDependencies: { typescript: '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ prod: true, onlyNames: ['typescript'] }),
      { registry, cache },
    );
    // typescript is filtered out by --prod; express isn't in --only
    assert.deepEqual(report.dependencies, []);
  });

  it('empty onlyNames behaves as no-op', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '1.0.0', lodash: '1.0.0' } }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(makeOptions({ onlyNames: [] }), { registry, cache });
    assert.equal(report.dependencies.length, 2);
  });

  it('--include-transitive expands the dep graph from package-lock.json', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '1.0.0' } }),
    );
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '1.0.0',
            dependencies: { 'body-parser': '1.0.0' },
          },
          'node_modules/body-parser': { version: '1.0.0' },
        },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true }),
      { registry, cache },
    );
    assert.equal(report.dependencies.length, 2);
    const transitiveCount = report.dependencies.filter((d) => d.transitive).length;
    assert.equal(transitiveCount, 1);
    const bp = report.dependencies.find((d) => d.name === 'body-parser');
    assert.equal(bp?.transitive, true);
  });

  it('--ignore-scope still filters private transitives', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '1.0.0' } }),
    );
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '1.0.0',
            dependencies: { '@private/inner': '1.0.0' },
          },
          'node_modules/@private/inner': { version: '1.0.0' },
        },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true, ignoredScopes: ['@private'] }),
      { registry, cache },
    );
    assert.equal(report.dependencies.length, 1);
    assert.equal(report.dependencies[0].name, 'express');
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].name, '@private/inner');
  });

  it('--include-transitive falls back to yarn.lock when package-lock.json is absent', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.18.0' } }),
    );
    await writeFile(
      join(dir, 'yarn.lock'),
      `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    body-parser: "npm:1.20.0"

"body-parser@npm:1.20.0":
  version: 1.20.0
  resolution: "body-parser@npm:1.20.0"
`,
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true }),
      { registry, cache },
    );
    const names = report.dependencies.map((d) => d.name).toSorted();
    assert.deepEqual(names, ['body-parser', 'express']);
    const bp = report.dependencies.find((d) => d.name === 'body-parser');
    assert.equal(bp?.transitive, true);
  });

  it('--only express --include-transitive includes express subgraph', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '1.0.0', lodash: '1.0.0' },
      }),
    );
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '1.0.0',
            dependencies: { 'body-parser': '1.0.0' },
          },
          'node_modules/lodash': { version: '1.0.0' },
          'node_modules/body-parser': { version: '1.0.0' },
        },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true, onlyNames: ['express'] }),
      { registry, cache },
    );
    const names = report.dependencies.map((d) => d.name).toSorted();
    assert.deepEqual(names, ['body-parser', 'express']);
  });
});

describe('runAnalysis overrides composition', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-overrides-comp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRegistry(versions: Record<string, string[]> = {}) {
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const known = versions[name] ?? ['1.0.0'];
        const versionsObj: Record<string, unknown> = {};
        const timeObj: Record<string, string> = {};
        for (const v of known) {
          versionsObj[v] = {};
          timeObj[v] = '2026-01-01T00:00:00Z';
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ name, versions: versionsObj, time: timeObj }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });
    return { cache, registry };
  }

  function makeOptions(over: Partial<{
    onlyNames: string[];
    ignoredScopes: string[];
    includeTransitive: boolean;
    overrides: boolean;
  }> = {}) {
    return {
      path: join(dir, 'package.json'),
      format: 'json' as const,
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
      cache: false,
      cacheTtlMinutes: 60,
      ignoredScopes: [],
      onlyNames: [],
      quiet: false,
      failOnLevel: null,
      maxAgeDays: null,
      sortBy: null,
      registryUrl: null,
      includeTransitive: false,
      updateLevel: null,
      dryRun: false,
      allColumns: false,
      releaseAge: true,
      showTrueLatest: false,      ...over,
    };
  }

  it('--ignore-scope filters overrides into skipped with reason "ignored-scope"', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '1.0.0' },
        overrides: { '@private/pinned': '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ ignoredScopes: ['@private'] }),
      { registry, cache },
    );
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['lodash'],
    );
    assert.equal(report.skipped.length, 1);
    assert.deepEqual(report.skipped[0], {
      name: '@private/pinned',
      type: 'overrides',
      reason: 'ignored-scope',
      scope: '@private',
    });
  });

  it('--only filters overrides like any other bucket', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '1.0.0' },
        overrides: { 'pinned-dep': '1.0.0', 'other-pin': '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ onlyNames: ['pinned-dep'] }),
      { registry, cache },
    );
    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['pinned-dep'],
    );
    assert.equal(report.dependencies[0].type, 'overrides');
  });

  it('--include-transitive does not expand override entries via the lockfile', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '1.0.0' },
        overrides: { 'pinned-dep': '1.0.0' },
      }),
    );
    // Lockfile lists pinned-dep with its own transitive — but since overrides
    // are not expansion roots, that transitive must not appear.
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '1.0.0',
            dependencies: { 'body-parser': '1.0.0' },
          },
          'node_modules/body-parser': { version: '1.0.0' },
          'node_modules/pinned-dep': {
            version: '1.0.0',
            dependencies: { 'should-not-appear': '1.0.0' },
          },
          'node_modules/should-not-appear': { version: '1.0.0' },
        },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true }),
      { registry, cache },
    );
    const names = report.dependencies.map((d) => d.name).toSorted();
    assert.deepEqual(names, ['body-parser', 'express', 'pinned-dep']);
    const pinned = report.dependencies.find((d) => d.name === 'pinned-dep');
    assert.equal(pinned?.type, 'overrides');
    assert.equal(pinned?.transitive, false);
  });

  it('overrides participate in updateType so --fail-on can flag a stale pin', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        overrides: { 'stale-pin': '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry({ 'stale-pin': ['1.0.0', '1.5.0'] });
    const report = await runAnalysis(makeOptions(), { registry, cache });
    assert.equal(report.dependencies.length, 1);
    const pinned = report.dependencies[0];
    assert.equal(pinned.name, 'stale-pin');
    assert.equal(pinned.type, 'overrides');
    assert.equal(pinned.updateType, 'minor');
    assert.equal(pinned.latestMinor?.version, '1.5.0');
  });
});

describe('runAnalysis resolutions composition', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-resol-comp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRegistry(versions: Record<string, string[]> = {}) {
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const known = versions[name] ?? ['1.0.0'];
        const versionsObj: Record<string, unknown> = {};
        const timeObj: Record<string, string> = {};
        for (const v of known) {
          versionsObj[v] = {};
          timeObj[v] = '2026-01-01T00:00:00Z';
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ name, versions: versionsObj, time: timeObj }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });
    return { cache, registry };
  }

  function makeOptions(over: Partial<{
    onlyNames: string[];
    ignoredScopes: string[];
    includeTransitive: boolean;
    resolutions: boolean;
  }> = {}) {
    return {
      path: join(dir, 'package.json'),
      format: 'json' as const,
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
      cache: false,
      cacheTtlMinutes: 60,
      ignoredScopes: [],
      onlyNames: [],
      quiet: false,
      failOnLevel: null,
      maxAgeDays: null,
      sortBy: null,
      registryUrl: null,
      includeTransitive: false,
      updateLevel: null,
      dryRun: false,
      allColumns: false,
      releaseAge: true,
      showTrueLatest: false,      ...over,
    };
  }

  it('analyzes a top-level resolutions pin and tags it with type "resolutions"', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        resolutions: { 'yarn-pin': '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(makeOptions(), { registry, cache });
    assert.equal(report.dependencies.length, 1);
    assert.equal(report.dependencies[0].name, 'yarn-pin');
    assert.equal(report.dependencies[0].type, 'resolutions');
  });

  it('--ignore-scope filters resolutions into skipped with reason "ignored-scope"', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '1.0.0' },
        resolutions: { '@private/pinned': '1.0.0' },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ ignoredScopes: ['@private'] }),
      { registry, cache },
    );
    assert.deepEqual(report.dependencies.map((d) => d.name), ['lodash']);
    assert.equal(report.skipped.length, 1);
    assert.deepEqual(report.skipped[0], {
      name: '@private/pinned',
      type: 'resolutions',
      reason: 'ignored-scope',
      scope: '@private',
    });
  });

  it('--include-transitive does not expand resolutions entries via the lockfile', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '1.0.0' },
        resolutions: { 'pinned-dep': '1.0.0' },
      }),
    );
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '1.0.0',
            dependencies: { 'body-parser': '1.0.0' },
          },
          'node_modules/body-parser': { version: '1.0.0' },
          'node_modules/pinned-dep': {
            version: '1.0.0',
            dependencies: { 'should-not-appear': '1.0.0' },
          },
          'node_modules/should-not-appear': { version: '1.0.0' },
        },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true }),
      { registry, cache },
    );
    const names = report.dependencies.map((d) => d.name).toSorted();
    assert.deepEqual(names, ['body-parser', 'express', 'pinned-dep']);
    const pinned = report.dependencies.find((d) => d.name === 'pinned-dep');
    assert.equal(pinned?.type, 'resolutions');
    assert.equal(pinned?.transitive, false);
  });
});

describe('runAnalysis pnpm.overrides composition', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-pnpm-comp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRegistry(versions: Record<string, string[]> = {}) {
    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        const known = versions[name] ?? ['1.0.0'];
        const versionsObj: Record<string, unknown> = {};
        const timeObj: Record<string, string> = {};
        for (const v of known) {
          versionsObj[v] = {};
          timeObj[v] = '2026-01-01T00:00:00Z';
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ name, versions: versionsObj, time: timeObj }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });
    return { cache, registry };
  }

  function makeOptions(over: Partial<{
    onlyNames: string[];
    ignoredScopes: string[];
    includeTransitive: boolean;
    pnpmOverrides: boolean;
  }> = {}) {
    return {
      path: join(dir, 'package.json'),
      format: 'json' as const,
      prod: false,
      dev: false,
      peer: false,
      optional: false,
      overrides: false,
      resolutions: false,
      pnpmOverrides: false,
      cache: false,
      cacheTtlMinutes: 60,
      ignoredScopes: [],
      onlyNames: [],
      quiet: false,
      failOnLevel: null,
      maxAgeDays: null,
      sortBy: null,
      registryUrl: null,
      includeTransitive: false,
      updateLevel: null,
      dryRun: false,
      allColumns: false,
      releaseAge: true,
      showTrueLatest: false,      ...over,
    };
  }

  it('analyzes a top-level pnpm.overrides pin and tags it with type "pnpm.overrides"', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        pnpm: { overrides: { 'pnpm-pin': '1.0.0' } },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(makeOptions(), { registry, cache });
    assert.equal(report.dependencies.length, 1);
    assert.equal(report.dependencies[0].name, 'pnpm-pin');
    assert.equal(report.dependencies[0].type, 'pnpm.overrides');
  });

  it('--include-transitive does not expand pnpm.overrides entries via the lockfile', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '1.0.0' },
        pnpm: { overrides: { 'pinned-dep': '1.0.0' } },
      }),
    );
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '1.0.0',
            dependencies: { 'body-parser': '1.0.0' },
          },
          'node_modules/body-parser': { version: '1.0.0' },
          'node_modules/pinned-dep': {
            version: '1.0.0',
            dependencies: { 'should-not-appear': '1.0.0' },
          },
          'node_modules/should-not-appear': { version: '1.0.0' },
        },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(
      makeOptions({ includeTransitive: true }),
      { registry, cache },
    );
    const names = report.dependencies.map((d) => d.name).toSorted();
    assert.deepEqual(names, ['body-parser', 'express', 'pinned-dep']);
    const pinned = report.dependencies.find((d) => d.name === 'pinned-dep');
    assert.equal(pinned?.type, 'pnpm.overrides');
    assert.equal(pinned?.transitive, false);
  });

  it('mixed-source repo: dependencies + overrides + resolutions + pnpm.overrides all appear with correct types', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'plain-dep': '1.0.0' },
        overrides: { 'npm-pin': '1.0.0' },
        resolutions: { 'yarn-pin': '1.0.0' },
        pnpm: { overrides: { 'pnpm-pin': '1.0.0' } },
      }),
    );
    const { cache, registry } = makeRegistry();
    const report = await runAnalysis(makeOptions(), { registry, cache });
    const byName = new Map(report.dependencies.map((d) => [d.name, d]));
    assert.equal(byName.size, 4);
    assert.equal(byName.get('plain-dep')?.type, 'dependencies');
    assert.equal(byName.get('npm-pin')?.type, 'overrides');
    assert.equal(byName.get('yarn-pin')?.type, 'resolutions');
    assert.equal(byName.get('pnpm-pin')?.type, 'pnpm.overrides');
  });
});

describe('runAnalysis registry HTTP error handling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-http-err-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a 404 to skipped with reason "registry-not-found" and continues with other deps', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'gone-pkg': '1.0.0', 'live-pkg': '1.0.0' },
      }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: fetchByName((name) => (name === 'gone-pkg' ? { status: 404 } : {})),
    });

    const report = await runAnalysis(baseAnalyzeOptions(join(dir, 'package.json')), {
      registry,
      cache,
    });

    assert.deepEqual(
      report.dependencies.map((d) => d.name),
      ['live-pkg'],
    );
    assert.equal(report.skipped.length, 1);
    assert.deepEqual(report.skipped[0], {
      name: 'gone-pkg',
      type: 'dependencies',
      reason: 'registry-not-found',
      status: 404,
    });
  });

  it('routes a 401 to skipped with reason "registry-unauthorized" and status 401', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@private/foo': '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: fetchByName(() => ({ status: 401 })),
    });

    const report = await runAnalysis(baseAnalyzeOptions(join(dir, 'package.json')), {
      registry,
      cache,
    });

    assert.deepEqual(report.dependencies, []);
    assert.equal(report.skipped.length, 1);
    assert.deepEqual(report.skipped[0], {
      name: '@private/foo',
      type: 'dependencies',
      reason: 'registry-unauthorized',
      status: 401,
    });
  });

  it('routes a 403 to skipped with reason "registry-unauthorized" and status 403', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@private/foo': '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: fetchByName(() => ({ status: 403 })),
    });

    const report = await runAnalysis(baseAnalyzeOptions(join(dir, 'package.json')), {
      registry,
      cache,
    });

    assert.deepEqual(report.skipped, [
      {
        name: '@private/foo',
        type: 'dependencies',
        reason: 'registry-unauthorized',
        status: 403,
      },
    ]);
  });

  it('still propagates a 500 (not skippable) so the run fails loudly', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'flaky-pkg': '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: fetchByName(() => ({ status: 500 })),
    });

    await assert.rejects(
      () =>
        runAnalysis(baseAnalyzeOptions(join(dir, 'package.json')), {
          registry,
          cache,
        }),
      /Failed to analyze flaky-pkg: Registry request failed.*500/,
    );
  });

  it('still propagates a non-HTTP error (regression for the narrow catch)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { broken: '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() => Promise.reject(new Error('boom'))) as typeof fetch,
    });

    await assert.rejects(
      () =>
        runAnalysis(baseAnalyzeOptions(join(dir, 'package.json')), {
          registry,
          cache,
        }),
      /Failed to analyze broken: boom/,
    );
  });

  it('applies an injected release-age config (deps.releaseAgeConfig)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'demo-pkg': '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: fetchByName((name) => ({
        body: {
          name,
          versions: { '1.0.0': {}, '1.1.0': {} },
          // 1.1.0 published "today" so it is inside any non-trivial window.
          time: { '1.0.0': '2026-01-01T00:00:00Z', '1.1.0': new Date().toISOString() },
        },
      })),
    });

    const report = await runAnalysis(baseAnalyzeOptions(join(dir, 'package.json')), {
      registry,
      cache,
      releaseAgeConfig: { days: 30, exclude: [], source: 'npm', file: '/injected/.npmrc' },
    });

    assert.ok(report.releaseAge);
    assert.equal(report.releaseAge.days, 30);
    assert.equal(report.releaseAge.file, '/injected/.npmrc');
    const dep = report.dependencies[0];
    assert.ok(dep.heldBack);
    assert.equal(dep.heldBack.minor?.version, '1.1.0');
  });

  it('skips release-age resolution entirely when options.releaseAge is false', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'demo-pkg': '1.0.0' } }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: fetchByName(() => ({})),
    });

    const report = await runAnalysis(
      { ...baseAnalyzeOptions(join(dir, 'package.json')), releaseAge: false },
      // An injected config must be ignored when releaseAge is off.
      { registry, cache, releaseAgeConfig: { days: 30, exclude: [], source: 'npm', file: '/x' } },
    );

    assert.equal(report.releaseAge, null);
  });
});

describe('isOverrideType', () => {
  it('returns true for override types', () => {
    assert.equal(isOverrideType('overrides'), true);
    assert.equal(isOverrideType('resolutions'), true);
    assert.equal(isOverrideType('pnpm.overrides'), true);
  });

  it('returns false for non-override types including catalog', () => {
    assert.equal(isOverrideType('catalog'), false);
    assert.equal(isOverrideType('dependencies'), false);
    assert.equal(isOverrideType('devDependencies'), false);
  });
});

describe('runAnalysis with --catalog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-catalog-analyze-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('includes catalog entries in report.dependencies when workspace file is present', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.17.21' } }),
    );
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      'catalog:\n  react: ^18.0.0\n',
    );
    await mkdir(join(dir, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'lodash', 'package.json'),
      JSON.stringify({ name: 'lodash', version: '4.17.21' }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name,
              versions: { '4.17.21': {}, '18.0.0': {}, '18.2.0': {} },
              time: {
                '4.17.21': '2020-01-01T00:00:00Z',
                '18.0.0': '2022-01-01T00:00:00Z',
                '18.2.0': '2023-01-01T00:00:00Z',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      { ...baseAnalyzeOptions(join(dir, 'package.json')), catalog: true },
      { registry, cache },
    );

    const catalogDep = report.dependencies.find((d) => d.name === 'react');
    assert.ok(catalogDep, 'react catalog entry should appear in dependencies');
    assert.equal(catalogDep.type, 'catalog');
  });

  it('runs normally without error when no pnpm-workspace.yaml is found', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.17.21' } }),
    );
    await mkdir(join(dir, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'lodash', 'package.json'),
      JSON.stringify({ name: 'lodash', version: '4.17.21' }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: ((url: string) => {
        const name = decodeURIComponent(url.split('/').pop() ?? '');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name,
              versions: { '4.17.21': {} },
              time: { '4.17.21': '2020-01-01T00:00:00Z' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      { ...baseAnalyzeOptions(join(dir, 'package.json')), catalog: true },
      { registry, cache },
    );

    assert.ok(Array.isArray(report.dependencies));
    assert.equal(report.dependencies.find((d) => d.type === 'catalog'), undefined);
  });
});

// ---------------------------------------------------------------------------
// runAnalysis with workspace: deps
// ---------------------------------------------------------------------------

describe('runAnalysis with workspace: deps', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-ws-analyze-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves workspace: deps and includes them in report.dependencies', async () => {
    // Set up a monorepo with a pnpm workspace.
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const appDir = join(dir, 'packages', 'app');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { '@myorg/utils': 'workspace:*' },
      }),
    );
    // Simulate the workspace symlink in node_modules.
    await mkdir(join(appDir, 'node_modules', '@myorg', 'utils'), { recursive: true });
    await writeFile(
      join(appDir, 'node_modules', '@myorg', 'utils', 'package.json'),
      JSON.stringify({ name: '@myorg/utils', version: '1.2.0' }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              name: '@myorg/utils',
              versions: { '1.2.0': {}, '1.3.0': {} },
              time: {
                '1.2.0': '2024-01-01T00:00:00Z',
                '1.3.0': '2025-01-01T00:00:00Z',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      baseAnalyzeOptions(join(appDir, 'package.json')),
      { registry, cache },
    );

    const wsDep = report.dependencies.find((d) => d.name === '@myorg/utils');
    assert.ok(wsDep, 'workspace dep should appear in dependencies');
    assert.equal(wsDep.current.version, '1.2.0');
    assert.equal(wsDep.type, 'dependencies');
  });

  it('skips private workspace deps with workspace-private reason', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const appDir = join(dir, 'packages', 'app');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { 'internal-lib': 'workspace:^' },
      }),
    );
    await mkdir(join(appDir, 'node_modules', 'internal-lib'), { recursive: true });
    await writeFile(
      join(appDir, 'node_modules', 'internal-lib', 'package.json'),
      JSON.stringify({ name: 'internal-lib', version: '0.1.0', private: true }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() =>
        Promise.resolve(new Response('{}', { status: 404 }))) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      baseAnalyzeOptions(join(appDir, 'package.json')),
      { registry, cache },
    );

    assert.equal(report.dependencies.find((d) => d.name === 'internal-lib'), undefined);
    const skipped = report.skipped.find((s) => s.name === 'internal-lib');
    assert.ok(skipped, 'private workspace dep should appear in skipped');
    assert.equal(skipped.reason, 'workspace-private');
  });

  it('resolves version-pinned workspace:^1.0.0 through the full pipeline', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const appDir = join(dir, 'packages', 'app');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { 'shared-lib': 'workspace:^1.0.0' },
      }),
    );
    await mkdir(join(appDir, 'node_modules', 'shared-lib'), { recursive: true });
    await writeFile(
      join(appDir, 'node_modules', 'shared-lib', 'package.json'),
      JSON.stringify({ name: 'shared-lib', version: '1.4.0' }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              name: 'shared-lib',
              versions: { '1.4.0': {}, '1.5.0': {} },
              time: {
                '1.4.0': '2024-01-01T00:00:00Z',
                '1.5.0': '2025-01-01T00:00:00Z',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      baseAnalyzeOptions(join(appDir, 'package.json')),
      { registry, cache },
    );

    const wsDep = report.dependencies.find((d) => d.name === 'shared-lib');
    assert.ok(wsDep, 'version-pinned workspace dep should appear in dependencies');
    assert.equal(wsDep.current.version, '1.4.0');
    assert.equal(wsDep.updateType, 'minor');
  });

  it('skips private dep with version-pinned workspace:~2.0.0 spec', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const appDir = join(dir, 'packages', 'app');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { 'private-pkg': 'workspace:~2.0.0' },
      }),
    );
    await mkdir(join(appDir, 'node_modules', 'private-pkg'), { recursive: true });
    await writeFile(
      join(appDir, 'node_modules', 'private-pkg', 'package.json'),
      JSON.stringify({ name: 'private-pkg', version: '2.0.0', private: true }),
    );

    const cache = new Cache({ dir: join(dir, 'cache'), enabled: false });
    const registry = new RegistryClient({
      baseUrl: 'http://example.invalid',
      cache,
      fetchImpl: (() =>
        Promise.resolve(new Response('{}', { status: 404 }))) as unknown as typeof fetch,
    });

    const report = await runAnalysis(
      baseAnalyzeOptions(join(appDir, 'package.json')),
      { registry, cache },
    );

    assert.equal(report.dependencies.find((d) => d.name === 'private-pkg'), undefined);
    const skipped = report.skipped.find((s) => s.name === 'private-pkg');
    assert.ok(skipped, 'private workspace dep should appear in skipped');
    assert.equal(skipped.reason, 'workspace-private');
  });
});
