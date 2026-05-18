import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { evaluatePolicy } from '../../src/policy.ts';
import type { AnalysisReport, DependencyAnalysis } from '../../src/types.ts';

function dep(overrides: Partial<DependencyAnalysis>): DependencyAnalysis {
  return {
    name: 'demo',
    type: 'dependencies',
    current: { version: '1.0.0', publishedAt: null },
    latestMinor: null,
    latestMajor: null,
    ageInDays: 30,
    latestAgeInDays: 30,
    updateType: 'up-to-date',
    ...overrides,
  };
}

function makeReport(deps: DependencyAnalysis[]): AnalysisReport {
  return {
    summary: { total: deps.length, upToDate: 0, minorUpdates: 0, majorUpdates: 0 },
    dependencies: deps,
    skipped: [],
  };
}

describe('evaluatePolicy', () => {
  it('passes when no flags are set', () => {
    const report = makeReport([dep({ updateType: 'major' })]);
    const result = evaluatePolicy(report, { failOnLevel: null, maxAgeDays: null });
    assert.equal(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it('passes when nothing violates the policy', () => {
    const report = makeReport([dep({ updateType: 'up-to-date', ageInDays: 5 })]);
    const result = evaluatePolicy(report, { failOnLevel: 'major', maxAgeDays: 30 });
    assert.equal(result.passed, true);
  });

  describe('--fail-on', () => {
    it('major: fails on major upgrades only', () => {
      const report = makeReport([
        dep({ name: 'a', updateType: 'major' }),
        dep({ name: 'b', updateType: 'minor' }),
      ]);
      const result = evaluatePolicy(report, { failOnLevel: 'major', maxAgeDays: null });
      assert.equal(result.passed, false);
      assert.equal(result.reasons.length, 1);
      assert.match(result.reasons[0], /a@1\.0\.0/);
      assert.doesNotMatch(result.reasons[0], /b@/);
    });

    it('minor: fails on minor or major upgrades', () => {
      const report = makeReport([
        dep({ name: 'a', updateType: 'major' }),
        dep({ name: 'b', updateType: 'minor' }),
        dep({ name: 'c', updateType: 'up-to-date' }),
      ]);
      const result = evaluatePolicy(report, { failOnLevel: 'minor', maxAgeDays: null });
      assert.equal(result.passed, false);
      assert.match(result.reasons[0], /a@1\.0\.0/);
      assert.match(result.reasons[0], /b@1\.0\.0/);
      assert.doesNotMatch(result.reasons[0], /c@/);
    });

    it('any: aliased to minor (catches major + minor)', () => {
      const report = makeReport([
        dep({ name: 'a', updateType: 'major' }),
        dep({ name: 'b', updateType: 'minor' }),
      ]);
      const result = evaluatePolicy(report, { failOnLevel: 'any', maxAgeDays: null });
      assert.equal(result.passed, false);
      assert.equal(result.reasons.length, 1);
    });

    it('uses singular phrasing for one offender', () => {
      const report = makeReport([dep({ updateType: 'major' })]);
      const result = evaluatePolicy(report, { failOnLevel: 'major', maxAgeDays: null });
      assert.match(result.reasons[0], /1 dependency need/);
    });
  });

  describe('--max-age', () => {
    it('fails when any installed version exceeds the threshold', () => {
      const report = makeReport([
        dep({ name: 'fresh', ageInDays: 5 }),
        dep({ name: 'stale', ageInDays: 400 }),
      ]);
      const result = evaluatePolicy(report, { failOnLevel: null, maxAgeDays: 365 });
      assert.equal(result.passed, false);
      assert.match(result.reasons[0], /stale \(400d\)/);
      assert.doesNotMatch(result.reasons[0], /fresh/);
    });

    it('ignores deps with null ageInDays', () => {
      const report = makeReport([dep({ name: 'unknown', ageInDays: null })]);
      const result = evaluatePolicy(report, { failOnLevel: null, maxAgeDays: 30 });
      assert.equal(result.passed, true);
    });

    it('uses singular phrasing for one offender', () => {
      const report = makeReport([dep({ ageInDays: 400 })]);
      const result = evaluatePolicy(report, { failOnLevel: null, maxAgeDays: 30 });
      assert.match(result.reasons[0], /1 dependency is/);
    });
  });

  describe('combined', () => {
    it('reports both reasons when both flags trip (OR semantics)', () => {
      const report = makeReport([
        dep({ name: 'a', updateType: 'major', ageInDays: 10 }),
        dep({ name: 'b', updateType: 'up-to-date', ageInDays: 500 }),
      ]);
      const result = evaluatePolicy(report, { failOnLevel: 'major', maxAgeDays: 365 });
      assert.equal(result.passed, false);
      assert.equal(result.reasons.length, 2);
      assert.match(result.reasons[0], /--fail-on major/);
      assert.match(result.reasons[1], /--max-age 365/);
    });
  });
});
