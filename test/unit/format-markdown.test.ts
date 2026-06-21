import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatMarkdown } from '../../src/format/markdown.ts';
import type { AnalysisReport } from '../../src/types.ts';

describe('formatMarkdown', () => {
  it('produces a markdown table with summary', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 0, patchUpdates: 0, minorUpdates: 0, majorUpdates: 1 },
      dependencies: [
        {
          name: 'express',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: null },
          latestPatch: null,
          latestMinor: { version: '4.21.0', publishedAt: null },
          latestMajor: { version: '5.0.1', publishedAt: null },
          ageInDays: 245,
          latestAgeInDays: 199,
          updateType: 'major',
          deprecated: null,
          transitive: false,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report);
    assert.match(out, /## Dependency Report/);
    assert.match(out, /\| Package \| Type \| Current \|/);
    assert.match(out, /\| express \| prod \| 4\.18\.2 \| - \| 4\.21\.0 \| 5\.0\.1 \| 8mo \| 6mo \| ⬆ Major \|/);
  });

  it('renders the Patch column and the Patch updates summary bullet', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 0, patchUpdates: 1, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'express',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: null },
          latestPatch: { version: '4.18.9', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 245,
          latestAgeInDays: 100,
          updateType: 'patch',
          deprecated: null,
          transitive: false,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report);
    assert.match(out, /- Patch updates: 1/);
    assert.match(out, /\| Package \| Type \| Current \| Patch \| Minor \| Major \|/);
    assert.match(out, /\| express \| prod \| 4\.18\.2 \| 4\.18\.9 \| - \| - \|.*△ Patch \|/);
  });

  it('renders a dash for null latest versions on up-to-date rows', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 1, patchUpdates: 0, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'lodash',
          type: 'dependencies',
          current: { version: '4.17.21', publishedAt: null },
          latestPatch: null,
          latestMinor: null,
          latestMajor: null,
          ageInDays: 730,
          latestAgeInDays: 730,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report);
    assert.match(out, /\| lodash \| prod \| 4\.17\.21 \| - \| - \| - \| 2y \| 2y \| ✓ Up to date \|/);
  });

  it('prefixes transitive rows with ↳', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 1, patchUpdates: 0, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'body-parser',
          type: 'dependencies',
          current: { version: '1.20.0', publishedAt: null },
          latestPatch: null,
          latestMinor: null,
          latestMajor: null,
          ageInDays: 60,
          latestAgeInDays: 60,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: true,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report);
    assert.match(out, /\| ↳ body-parser \|/);
  });

  it('appends a ⚠ marker after deprecated package names', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 1, patchUpdates: 0, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'request',
          type: 'dependencies',
          current: { version: '2.88.2', publishedAt: null },
          latestPatch: null,
          latestMinor: null,
          latestMajor: null,
          ageInDays: 1500,
          latestAgeInDays: 1500,
          updateType: 'up-to-date',
          deprecated: 'request has been deprecated',
          transitive: false,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report);
    assert.match(out, /\| request ⚠ \|/);
  });

  it('renders rows for the resolutions and pnpm.overrides types with their short labels', () => {
    const report: AnalysisReport = {
      summary: { total: 2, upToDate: 2, patchUpdates: 0, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'yarn-pin',
          type: 'resolutions',
          current: { version: '1.0.0', publishedAt: null },
          latestPatch: null,
          latestMinor: null,
          latestMajor: null,
          ageInDays: 10,
          latestAgeInDays: 10,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
          heldBack: null,
        },
        {
          name: 'pnpm-pin',
          type: 'pnpm.overrides',
          current: { version: '2.0.0', publishedAt: null },
          latestPatch: null,
          latestMinor: null,
          latestMajor: null,
          ageInDays: 20,
          latestAgeInDays: 20,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report);
    assert.match(out, /\| yarn-pin \| resol \|/);
    assert.match(out, /\| pnpm-pin \| pnpm \|/);
  });

  it('omits the heading and bullet list when quiet: true', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 1, patchUpdates: 0, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'lodash',
          type: 'dependencies',
          current: { version: '4.17.21', publishedAt: null },
          latestPatch: null,
          latestMinor: null,
          latestMajor: null,
          ageInDays: 730,
          latestAgeInDays: 730,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
          heldBack: null,
        },
      ],
      skipped: [],
      releaseAge: null,
    };
      const out = formatMarkdown(report, { quiet: true });
    assert.doesNotMatch(out, /## Dependency Report/);
    assert.doesNotMatch(out, /- Total:/);
    assert.match(out, /\| Package \|/);
    assert.match(out, /\| lodash \|/);
  });

  it('marks held-back versions and notes the cooldown', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 0, patchUpdates: 0, minorUpdates: 1, majorUpdates: 0 },
      dependencies: [
        {
          name: 'express',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: null },
          latestPatch: null,
          latestMinor: { version: '4.20.0', publishedAt: null },
          latestMajor: null,
          ageInDays: 400,
          latestAgeInDays: 120,
          updateType: 'minor',
          deprecated: null,
          transitive: false,
          heldBack: { patch: null, minor: { version: '4.21.0', publishedAt: null, ageInDays: 2 }, major: null },
        },
      ],
      skipped: [],
      releaseAge: { days: 30, source: 'npm', file: '/tmp/.npmrc', exclude: [] },
    };
    // Without --show-true-latest: chosen minor shown with the ⏳ marker.
    const out = formatMarkdown(report);
    assert.match(out, /4\.20\.0 ⏳/);
    assert.match(out, /Minimum release age: 30 days/);
    // With --show-true-latest the withheld version is revealed in a held-back-only tier.
    const shown = formatMarkdown({
      ...report,
      dependencies: [{ ...report.dependencies[0], latestMinor: null }],
    }, { showTrueLatest: true });
    assert.match(shown, /4\.21\.0 ⏳/);
    // Held-back-only tier without --show-true-latest: a bare marker, no version.
    const bare = formatMarkdown({
      ...report,
      dependencies: [{ ...report.dependencies[0], latestMinor: null }],
    });
    assert.match(bare, /\| ⏳ \|/);
    assert.doesNotMatch(bare, /4\.21\.0/);
  });
});
