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

describe('analyzeDependency with minimum-release-age cooldown', () => {
  // NOW is 2026-05-18. 1.5.0 published 2026-05-10 is 8 days old; 1.4.0 is older.
  const metadata = makeMetadata({
    '1.2.3': '2026-01-01T00:00:00Z',
    '1.4.0': '2026-03-01T00:00:00Z',
    '1.5.0': '2026-05-10T00:00:00Z',
  });

  it('holds back a version younger than the cooldown and picks the older eligible one', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata,
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    // 1.5.0 (8 days old) is withheld; 1.4.0 becomes the chosen minor.
    assert.equal(result.latestMinor?.version, '1.4.0');
    assert.equal(result.updateType, 'minor');
    assert.ok(result.heldBack);
    assert.equal(result.heldBack.minor?.version, '1.5.0');
    assert.equal(result.heldBack.minor?.ageInDays, 8);
    // The withheld 1.5.0 is the newest in this major, so it shows up under minor only.
    assert.equal(result.heldBack.patch, null);
  });

  it('does not hold back when the true latest is already older than the cooldown', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata,
      now: NOW,
      cooldown: { days: 3, excluded: false },
    });
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.heldBack, null);
  });

  it('ignores the cooldown for excluded packages', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata,
      now: NOW,
      cooldown: { days: 14, excluded: true },
    });
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.heldBack, null);
  });

  it('leaves heldBack null when no cooldown is configured', () => {
    const result = analyzeDependency({ entry: makeEntry('1.2.3'), metadata, now: NOW });
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.heldBack, null);
  });

  it('reports up-to-date with a held-back version when every upgrade is inside the window', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.4.0'),
      metadata,
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    assert.equal(result.updateType, 'up-to-date');
    assert.equal(result.latestMinor, null);
    assert.ok(result.heldBack);
    assert.equal(result.heldBack.minor?.version, '1.5.0');
  });

  it('treats versions with unknown publish time as eligible', () => {
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({ '1.2.3': '2026-01-01T00:00:00Z', '1.5.0': '' }),
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.heldBack, null);
  });

  it('holds back a fresh minor even when a newer major is eligible', () => {
    // 1.6.0 is fresh (held back in the minor tier); 2.0.0 is old (eligible major).
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.2.3': '2026-01-01T00:00:00Z',
        '1.5.0': '2026-03-01T00:00:00Z',
        '1.6.0': '2026-05-15T00:00:00Z', // 3 days old → withheld
        '2.0.0': '2026-03-15T00:00:00Z', // old → eligible
      }),
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    assert.equal(result.updateType, 'major');
    assert.equal(result.latestMajor?.version, '2.0.0');
    // The eligible minor is 1.5.0, but 1.6.0 was suppressed in that tier.
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.ok(result.heldBack);
    assert.equal(result.heldBack.minor?.version, '1.6.0');
    assert.equal(result.heldBack.major, null); // 2.0.0 is eligible — nothing held in major
  });

  it('holds back only the patch tier when the fresh version is a patch', () => {
    // 1.2.9 is fresh and a patch-level bump; no minor/major exists.
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.2.3': '2026-01-01T00:00:00Z',
        '1.2.9': '2026-05-15T00:00:00Z', // 3 days old → withheld
      }),
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    assert.equal(result.updateType, 'up-to-date');
    assert.ok(result.heldBack);
    assert.equal(result.heldBack.patch?.version, '1.2.9');
    assert.equal(result.heldBack.minor, null);
    assert.equal(result.heldBack.major, null);
  });

  it('reports no held-back patch when the installed minor line has no other release', () => {
    // No 1.2.x exists besides the (unpublished) installed version, so the patch
    // tier has nothing to hold back even though a fresh minor is withheld.
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: makeMetadata({
        '1.3.0': '2026-03-01T00:00:00Z',
        '1.5.0': '2026-05-15T00:00:00Z', // fresh → withheld minor
      }),
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    assert.ok(result.heldBack);
    assert.equal(result.heldBack.patch, null);
    assert.equal(result.heldBack.minor?.version, '1.5.0');
  });

  it('treats a version missing from the time map as eligible (no held-back)', () => {
    // 1.5.0 is listed in versions but absent from time → undated → eligible.
    const metadataNoTime: RegistryPackageMetadata = {
      name: 'demo',
      versions: ['1.2.3', '1.5.0'],
      time: { '1.2.3': '2026-01-01T00:00:00Z' },
      deprecations: {},
    };
    const result = analyzeDependency({
      entry: makeEntry('1.2.3'),
      metadata: metadataNoTime,
      now: NOW,
      cooldown: { days: 14, excluded: false },
    });
    assert.equal(result.latestMinor?.version, '1.5.0');
    assert.equal(result.heldBack, null);
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
