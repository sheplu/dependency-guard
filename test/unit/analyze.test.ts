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
});
