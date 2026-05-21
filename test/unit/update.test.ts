import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  applyRange,
  applyUpdates,
  collectAllSpecs,
  detectIndent,
  planUpdates,
  type PlannedUpdate,
} from '../../src/update.ts';
import type { AnalysisReport, DependencyAnalysis } from '../../src/types.ts';

function dep(overrides: Partial<DependencyAnalysis>): DependencyAnalysis {
  return {
    name: 'demo',
    type: 'dependencies',
    current: { version: '1.0.0', publishedAt: null },
    latestPatch: null,
    latestMinor: null,
    latestMajor: null,
    ageInDays: null,
    latestAgeInDays: null,
    updateType: 'up-to-date',
    deprecated: null,
    transitive: false,
    ...overrides,
  };
}

function makeReport(deps: DependencyAnalysis[]): AnalysisReport {
  return {
    summary: { total: deps.length, upToDate: 0, patchUpdates: 0, minorUpdates: 0, majorUpdates: 0 },
    dependencies: deps,
    skipped: [],
  };
}

describe('planUpdates', () => {
  it('level "minor" picks latestMinor and skips up-to-date deps', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
      }),
      dep({
        name: 'b',
        current: { version: '2.0.0', publishedAt: null },
        latestMinor: null,
        updateType: 'up-to-date',
      }),
    ]);
    const specs = new Map([['a', '^1.0.0'], ['b', '2.0.0']]);
    const updates = planUpdates(report, 'minor', specs);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].name, 'a');
    assert.equal(updates[0].to, '1.5.0');
    assert.equal(updates[0].newSpec, '^1.5.0');
  });

  it('level "minor" leaves alone deps where only a major upgrade exists', () => {
    const report = makeReport([
      dep({
        name: 'express',
        current: { version: '4.0.0', publishedAt: null },
        latestMinor: null,
        latestMajor: { version: '5.0.0', publishedAt: null },
        updateType: 'major',
      }),
    ]);
    const specs = new Map([['express', '^4.0.0']]);
    const updates = planUpdates(report, 'minor', specs);
    assert.deepEqual(updates, []);
  });

  it('level "major" picks latestMajor when available', () => {
    const report = makeReport([
      dep({
        name: 'express',
        current: { version: '4.18.0', publishedAt: null },
        latestMinor: { version: '4.21.0', publishedAt: null },
        latestMajor: { version: '5.0.0', publishedAt: null },
        updateType: 'major',
      }),
    ]);
    const specs = new Map([['express', '^4.18.0']]);
    const updates = planUpdates(report, 'major', specs);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '5.0.0');
    assert.equal(updates[0].newSpec, '^5.0.0');
  });

  it('level "major" falls back to latestMinor when no major exists', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        latestMajor: null,
        updateType: 'minor',
      }),
    ]);
    const specs = new Map([['a', '^1.0.0']]);
    const updates = planUpdates(report, 'major', specs);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '1.5.0');
  });

  it('skips transitive deps even when an upgrade is available', () => {
    const report = makeReport([
      dep({
        name: 'transitive-dep',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
        transitive: true,
      }),
    ]);
    const updates = planUpdates(report, 'minor', new Map());
    assert.deepEqual(updates, []);
  });

  it('skips override entries even when an upgrade is available', () => {
    const report = makeReport([
      dep({
        name: 'pinned-override',
        type: 'overrides',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
      }),
    ]);
    const updates = planUpdates(report, 'minor', new Map([['pinned-override', '1.0.0']]));
    assert.deepEqual(updates, []);
  });

  it('skips yarn resolutions entries even when an upgrade is available', () => {
    const report = makeReport([
      dep({
        name: 'pinned-resol',
        type: 'resolutions',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
      }),
    ]);
    const updates = planUpdates(report, 'minor', new Map([['pinned-resol', '1.0.0']]));
    assert.deepEqual(updates, []);
  });

  it('skips pnpm.overrides entries even when an upgrade is available', () => {
    const report = makeReport([
      dep({
        name: 'pinned-pnpm',
        type: 'pnpm.overrides',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
      }),
    ]);
    const updates = planUpdates(report, 'minor', new Map([['pinned-pnpm', '1.0.0']]));
    assert.deepEqual(updates, []);
  });

  it('falls back to current.version when the dep is not in the original-spec map', () => {
    const report = makeReport([
      dep({
        name: 'orphan',
        current: { version: '1.0.0', publishedAt: null },
        latestMinor: { version: '1.2.0', publishedAt: null },
        updateType: 'minor',
      }),
    ]);
    const updates = planUpdates(report, 'minor', new Map());
    assert.equal(updates[0].oldSpec, '1.0.0');
    assert.equal(updates[0].newSpec, '1.2.0');
  });

  it('level "patch" picks latestPatch and skips deps with no patch update', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.2.3', publishedAt: null },
        latestPatch: { version: '1.2.9', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
      }),
      dep({
        name: 'b',
        current: { version: '2.0.0', publishedAt: null },
        latestPatch: null,
        updateType: 'up-to-date',
      }),
    ]);
    const specs = new Map([['a', '^1.2.3'], ['b', '2.0.0']]);
    const updates = planUpdates(report, 'patch', specs);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].name, 'a');
    assert.equal(updates[0].to, '1.2.9');
    assert.equal(updates[0].newSpec, '^1.2.9');
  });

  it('level "patch" leaves alone deps where only minor or major upgrades exist', () => {
    const report = makeReport([
      dep({
        name: 'minor-only',
        current: { version: '1.0.0', publishedAt: null },
        latestPatch: null,
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'minor',
      }),
      dep({
        name: 'major-only',
        current: { version: '4.0.0', publishedAt: null },
        latestPatch: null,
        latestMajor: { version: '5.0.0', publishedAt: null },
        updateType: 'major',
      }),
    ]);
    const specs = new Map([['minor-only', '^1.0.0'], ['major-only', '^4.0.0']]);
    const updates = planUpdates(report, 'patch', specs);
    assert.deepEqual(updates, []);
  });

  it('level "minor" falls back to latestPatch when no minor exists', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.2.3', publishedAt: null },
        latestPatch: { version: '1.2.9', publishedAt: null },
        latestMinor: null,
        updateType: 'patch',
      }),
    ]);
    const specs = new Map([['a', '^1.2.3']]);
    const updates = planUpdates(report, 'minor', specs);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '1.2.9');
  });

  it('level "major" falls back to latestPatch when no major or minor exists', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.2.3', publishedAt: null },
        latestPatch: { version: '1.2.9', publishedAt: null },
        latestMinor: null,
        latestMajor: null,
        updateType: 'patch',
      }),
    ]);
    const specs = new Map([['a', '^1.2.3']]);
    const updates = planUpdates(report, 'major', specs);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '1.2.9');
  });

  it('skips when the chosen target equals the current version', () => {
    const report = makeReport([
      dep({
        name: 'noop',
        current: { version: '1.5.0', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        updateType: 'up-to-date',
      }),
    ]);
    const updates = planUpdates(report, 'minor', new Map([['noop', '^1.5.0']]));
    assert.deepEqual(updates, []);
  });

  it('level "all" picks latestMajor when available (alias for major)', () => {
    const report = makeReport([
      dep({
        name: 'express',
        current: { version: '4.0.0', publishedAt: null },
        latestPatch: { version: '4.0.5', publishedAt: null },
        latestMinor: { version: '4.21.0', publishedAt: null },
        latestMajor: { version: '5.0.0', publishedAt: null },
        updateType: 'major',
      }),
    ]);
    const updates = planUpdates(report, 'all', new Map([['express', '^4.0.0']]));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '5.0.0');
    assert.equal(updates[0].newSpec, '^5.0.0');
  });

  it('level "all" falls back to latestMinor when no major exists', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.0.0', publishedAt: null },
        latestPatch: { version: '1.0.5', publishedAt: null },
        latestMinor: { version: '1.5.0', publishedAt: null },
        latestMajor: null,
        updateType: 'minor',
      }),
    ]);
    const updates = planUpdates(report, 'all', new Map([['a', '^1.0.0']]));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '1.5.0');
  });

  it('level "all" falls back to latestPatch when only patch exists', () => {
    const report = makeReport([
      dep({
        name: 'a',
        current: { version: '1.0.0', publishedAt: null },
        latestPatch: { version: '1.0.5', publishedAt: null },
        latestMinor: null,
        latestMajor: null,
        updateType: 'patch',
      }),
    ]);
    const updates = planUpdates(report, 'all', new Map([['a', '^1.0.0']]));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].to, '1.0.5');
  });
});

describe('applyRange', () => {
  it('preserves caret', () => {
    assert.equal(applyRange('^1.2.3', '1.5.0'), '^1.5.0');
  });
  it('preserves tilde', () => {
    assert.equal(applyRange('~1.2.3', '1.2.9'), '~1.2.9');
  });
  it('preserves >= operator', () => {
    assert.equal(applyRange('>=1.2.3', '1.5.0'), '>=1.5.0');
  });
  it('preserves exact pin (no marker)', () => {
    assert.equal(applyRange('1.2.3', '1.5.0'), '1.5.0');
  });
  it('strips a v prefix', () => {
    assert.equal(applyRange('v1.2.3', '1.5.0'), '1.5.0');
  });
});

describe('detectIndent', () => {
  it('detects 2-space indent', () => {
    assert.equal(detectIndent('{\n  "a": 1\n}'), 2);
  });
  it('detects 4-space indent', () => {
    assert.equal(detectIndent('{\n    "a": 1\n}'), 4);
  });
  it('detects tab indent', () => {
    assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
  });
  it('defaults to 2 spaces for minified JSON', () => {
    assert.equal(detectIndent('{"a":1}'), 2);
  });
});

describe('applyUpdates (file IO)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-update-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites the file with detected indent and trailing newline', async () => {
    const path = join(dir, 'package.json');
    await writeFile(
      path,
      JSON.stringify(
        { name: 'demo', dependencies: { lodash: '^4.17.0' } },
        null,
        2,
      ) + '\n',
    );
    const updates: PlannedUpdate[] = [
      {
        name: 'lodash',
        type: 'dependencies',
        from: '4.17.0',
        to: '4.21.0',
        oldSpec: '^4.17.0',
        newSpec: '^4.21.0',
      },
    ];
    await applyUpdates(path, updates);
    const written = await readFile(path, 'utf8');
    assert.match(written, /"lodash": "\^4\.21\.0"/);
    assert.ok(written.endsWith('\n'));
  });

  it('preserves 4-space indent', async () => {
    const path = join(dir, 'package.json');
    await writeFile(
      path,
      JSON.stringify(
        { name: 'demo', dependencies: { lodash: '^4.17.0' } },
        null,
        4,
      ),
    );
    await applyUpdates(path, [
      {
        name: 'lodash',
        type: 'dependencies',
        from: '4.17.0',
        to: '4.21.0',
        oldSpec: '^4.17.0',
        newSpec: '^4.21.0',
      },
    ]);
    const written = await readFile(path, 'utf8');
    assert.match(written, /\n {8}"lodash"/);
  });

  it('preserves the absence of a trailing newline', async () => {
    const path = join(dir, 'package.json');
    await writeFile(
      path,
      JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.17.0' } }, null, 2),
    );
    await applyUpdates(path, [
      {
        name: 'lodash',
        type: 'dependencies',
        from: '4.17.0',
        to: '4.21.0',
        oldSpec: '^4.17.0',
        newSpec: '^4.21.0',
      },
    ]);
    const written = await readFile(path, 'utf8');
    assert.ok(!written.endsWith('\n'));
  });

  it('silently skips updates whose target bucket no longer contains the dep', async () => {
    const path = join(dir, 'package.json');
    await writeFile(
      path,
      JSON.stringify({ name: 'demo', dependencies: { kept: '1.0.0' } }, null, 2),
    );
    await applyUpdates(path, [
      {
        name: 'gone',
        type: 'dependencies',
        from: '1.0.0',
        to: '2.0.0',
        oldSpec: '1.0.0',
        newSpec: '2.0.0',
      },
      {
        name: 'kept',
        type: 'dependencies',
        from: '1.0.0',
        to: '1.5.0',
        oldSpec: '1.0.0',
        newSpec: '1.5.0',
      },
    ]);
    const written = await readFile(path, 'utf8');
    assert.match(written, /"kept": "1\.5\.0"/);
    assert.doesNotMatch(written, /gone/);
  });

  it('silently skips updates whose target bucket does not exist on disk', async () => {
    const path = join(dir, 'package.json');
    // No devDependencies bucket — but we try to update one
    await writeFile(
      path,
      JSON.stringify({ name: 'demo', dependencies: { kept: '1.0.0' } }, null, 2),
    );
    await applyUpdates(path, [
      {
        name: 'absent',
        type: 'devDependencies',
        from: '1.0.0',
        to: '2.0.0',
        oldSpec: '1.0.0',
        newSpec: '2.0.0',
      },
    ]);
    const written = await readFile(path, 'utf8');
    assert.match(written, /"kept": "1\.0\.0"/);
  });
});

describe('collectAllSpecs', () => {
  it('walks all four dependency buckets', () => {
    const map = collectAllSpecs({
      dependencies: { a: '^1' },
      devDependencies: { b: '~2' },
      peerDependencies: { c: '>=3' },
      optionalDependencies: { d: '4' },
    });
    assert.equal(map.size, 4);
    assert.equal(map.get('a'), '^1');
    assert.equal(map.get('d'), '4');
  });

  it('handles missing buckets', () => {
    const map = collectAllSpecs({ dependencies: { a: '^1' } });
    assert.equal(map.size, 1);
    assert.equal(map.get('a'), '^1');
  });

  it('returns an empty map when no buckets exist', () => {
    assert.equal(collectAllSpecs({}).size, 0);
  });
});
