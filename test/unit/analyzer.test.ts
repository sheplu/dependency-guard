import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { analyzeDependency, summarize } from '../../src/analyzer.ts';
import type { DependencyEntry } from '../../src/package-json.ts';
import type { RegistryPackageMetadata } from '../../src/types.ts';

const NOW = new Date('2026-05-18T00:00:00Z');

function makeEntry(installed: string): DependencyEntry {
  return {
    name: 'demo',
    type: 'dependencies',
    spec: `^${installed}`,
    installedVersion: installed,
    transitive: false,
  };
}

function makeMetadata(versions: Record<string, string>): RegistryPackageMetadata {
  return {
    name: 'demo',
    versions: Object.keys(versions),
    time: versions,
    deprecations: {},
  };
}

describe('analyzeDependency', () => {
  it('classifies as up-to-date when current === latest stable', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.2.3': '2026-01-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.updateType, 'up-to-date');
    assert.equal(result.latestMajor, null);
    assert.equal(result.latestMinor, null);
    assert.equal(result.latestPatch, null);
  });

  it('classifies as patch when only a newer patch in same major.minor exists', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.2.3': '2026-01-01T00:00:00Z',
        '1.2.9': '2026-02-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.updateType, 'patch');
    assert.equal(result.latestPatch?.version, '1.2.9');
    assert.equal(result.latestMinor, null);
    assert.equal(result.latestMajor, null);
  });

  it('classifies as minor when newer minor exists in same major (minor wins over patch)', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.2.3': '2026-01-01T00:00:00Z',
        '1.2.9': '2026-02-01T00:00:00Z',
        '1.5.0': '2026-03-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.updateType, 'minor');
    assert.equal(result.latestPatch?.version, '1.2.9');
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.latestMajor, null);
  });

  it('classifies as major when newer major exists (all three latest fields populated)', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.2.3': '2026-01-01T00:00:00Z',
        '1.2.9': '2026-02-01T00:00:00Z',
        '1.5.0': '2026-03-01T00:00:00Z',
        '2.0.0': '2026-04-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.updateType, 'major');
    assert.equal(result.latestPatch?.version, '1.2.9');
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.latestMajor?.version, '2.0.0');
  });

  it('ignores prereleases when picking latest', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: makeMetadata({
        '1.0.0': '2026-01-01T00:00:00Z',
        '2.0.0': '2026-02-01T00:00:00Z',
        '3.0.0-beta.1': '2026-03-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.latestMajor?.version, '2.0.0');
  });

  it('returns null latestMajor when registry has no stable versions', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: makeMetadata({
        '2.0.0-beta.1': '2026-03-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.updateType, 'up-to-date');
    assert.equal(result.latestMajor, null);
    assert.equal(result.latestMinor, null);
    assert.equal(result.latestPatch, null);
  });

  it('falls back to 0.0.0 when installed version is unparseable', () => {
    const result = analyzeDependency({
      entry: {
        name: 'demo',
        type: 'dependencies',
        spec: 'garbage',
        installedVersion: 'not-a-version',
        transitive: false,
      },
      metadata: makeMetadata({ '1.0.0': '2026-01-01T00:00:00Z' }),
      now: NOW,
    });
    assert.equal(result.updateType, 'major');
    assert.equal(result.current.version, '0.0.0');
  });

  it('falls back to 0.0.0 when installed version is null', () => {
    const result = analyzeDependency({
      entry: {
        name: 'demo',
        type: 'dependencies',
        spec: '',
        installedVersion: null,
        transitive: false,
      },
      metadata: makeMetadata({ '1.0.0': '2026-01-01T00:00:00Z' }),
      now: NOW,
    });
    assert.equal(result.current.version, '0.0.0');
    assert.equal(result.updateType, 'major');
  });

  it('computes age from registry time', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: makeMetadata({
        '1.0.0': '2026-04-18T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.ageInDays, 30);
  });

  it('computes latestAgeInDays from the latest stable version', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: makeMetadata({
        '1.0.0': '2026-01-01T00:00:00Z',
        '2.0.0': '2026-04-18T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.ageInDays, 137);
    assert.equal(result.latestAgeInDays, 30);
  });

  it('exposes deprecation message for the installed version', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: {
        name: 'demo',
        versions: ['1.0.0'],
        time: { '1.0.0': '2026-01-01T00:00:00Z' },
        deprecations: { '1.0.0': 'use newer' },
      },
      now: NOW,
    });
    assert.equal(result.deprecated, 'use newer');
  });

  it('returns deprecated: null when no deprecation entry exists', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: {
        name: 'demo',
        versions: ['1.0.0'],
        time: { '1.0.0': '2026-01-01T00:00:00Z' },
        deprecations: {},
      },
      now: NOW,
    });
    assert.equal(result.deprecated, null);
  });

  it('returns null latestAgeInDays when registry has no time entry for the latest', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: {
        name: 'demo',
        versions: ['1.0.0', '2.0.0'],
        time: { '1.0.0': '2026-01-01T00:00:00Z' },
        deprecations: {},
      },
      now: NOW,
    });
    assert.equal(result.latestAgeInDays, null);
  });

  it('mirrors ageInDays into latestAgeInDays when no stable versions exist', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.0.0'),
      metadata: makeMetadata({
        '1.0.0': '2026-04-18T00:00:00Z',
        '2.0.0-rc.1': '2026-05-01T00:00:00Z',
      }),
      now: NOW,
    });
    assert.equal(result.ageInDays, 30);
    assert.equal(result.latestAgeInDays, 30);
  });
});

describe('summarize', () => {
  it('counts each updateType bucket', () => {
    const summary = summarize([
      { updateType: 'up-to-date' } as never,
      { updateType: 'patch' } as never,
      { updateType: 'patch' } as never,
      { updateType: 'minor' } as never,
      { updateType: 'major' } as never,
      { updateType: 'major' } as never,
    ]);
    assert.deepEqual(summary, {
      total: 6,
      upToDate: 1,
      patchUpdates: 2,
      minorUpdates: 1,
      majorUpdates: 2,
    });
  });
});
