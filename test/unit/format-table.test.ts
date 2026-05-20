import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatTable } from '../../src/format/table.ts';
import type { AnalysisReport } from '../../src/types.ts';

describe('formatTable', () => {
  it('renders summary and table without colors when color: false', () => {
    const report: AnalysisReport = {
      summary: { total: 2, upToDate: 1, minorUpdates: 0, majorUpdates: 1 },
      dependencies: [
        {
          name: 'express',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: null },
          latestMinor: { version: '4.21.0', publishedAt: null },
          latestMajor: { version: '5.0.1', publishedAt: null },
          ageInDays: 245,
          latestAgeInDays: 199,
          updateType: 'major',
          deprecated: null,
          transitive: false,
        },
        {
          name: 'lodash',
          type: 'dependencies',
          current: { version: '4.17.21', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 730,
          latestAgeInDays: 730,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
        },
      ],
      skipped: [],
    };

    const out = formatTable(report, { color: false });
    assert.match(out, /Summary:/);
    assert.match(out, /Total: 2/);
    assert.match(out, /│ Package /);
    assert.match(out, /│ Latest Age │/);
    assert.match(out, /express/);
    assert.match(out, /lodash/);
    // Up-to-date row: Age and Latest Age are equal (signals an unmaintained but current dep)
    assert.match(out, /4\.17\.21\s+│\s+-\s+│\s+-\s+│\s+2y\s+│\s+2y\s+│/);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\x1b\[/);
  });

  it('emits ANSI color codes for major / minor / up-to-date when color: true', () => {
    const report: AnalysisReport = {
      summary: { total: 3, upToDate: 1, minorUpdates: 1, majorUpdates: 1 },
      dependencies: [
        {
          name: 'a-major',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: null },
          latestMinor: { version: '4.21.0', publishedAt: null },
          latestMajor: { version: '5.0.1', publishedAt: null },
          ageInDays: 245,
          latestAgeInDays: 199,
          updateType: 'major',
          deprecated: null,
          transitive: false,
        },
        {
          name: 'b-minor',
          type: 'devDependencies',
          current: { version: '5.2.2', publishedAt: null },
          latestMinor: { version: '5.3.3', publishedAt: null },
          latestMajor: null,
          ageInDays: 120,
          latestAgeInDays: 75,
          updateType: 'minor',
          deprecated: null,
          transitive: false,
        },
        {
          name: 'c-uptodate',
          type: 'dependencies',
          current: { version: '4.17.21', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 730,
          latestAgeInDays: 730,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
        },
      ],
      skipped: [],
    };
    const out = formatTable(report, { color: true });
    // eslint-disable-next-line no-control-regex
    assert.match(out, /\x1b\[31m/);
    // eslint-disable-next-line no-control-regex
    assert.match(out, /\x1b\[33m/);
    // eslint-disable-next-line no-control-regex
    assert.match(out, /\x1b\[32m/);
  });

  it('omits the Summary block when quiet: true', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 1, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'lodash',
          type: 'dependencies',
          current: { version: '4.17.21', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 730,
          latestAgeInDays: 730,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
        },
      ],
      skipped: [],
    };
    const out = formatTable(report, { color: false, quiet: true });
    assert.doesNotMatch(out, /Summary:/);
    assert.match(out, /│ Package /);
    assert.match(out, /lodash/);
  });

  it('prefixes transitive rows with ↳', () => {
    const report: AnalysisReport = {
      summary: { total: 2, upToDate: 2, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'express',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 30,
          latestAgeInDays: 30,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
        },
        {
          name: 'body-parser',
          type: 'dependencies',
          current: { version: '1.20.0', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 60,
          latestAgeInDays: 60,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: true,
        },
      ],
      skipped: [],
    };
    const out = formatTable(report, { color: false });
    assert.match(out, /│ express\s+│/);
    assert.match(out, /│ ↳ body-parser\s+│/);
  });

  it('appends a ⚠ marker after deprecated package names', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 1, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'request',
          type: 'dependencies',
          current: { version: '2.88.2', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 1500,
          latestAgeInDays: 1500,
          updateType: 'up-to-date',
          deprecated: 'request has been deprecated',
          transitive: false,
        },
      ],
      skipped: [],
    };
    const out = formatTable(report, { color: false });
    assert.match(out, /request ⚠/);
  });

  it('renders rows for the resolutions and pnpm.overrides types with their short labels', () => {
    const report: AnalysisReport = {
      summary: { total: 2, upToDate: 2, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [
        {
          name: 'yarn-pin',
          type: 'resolutions',
          current: { version: '1.0.0', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 10,
          latestAgeInDays: 10,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
        },
        {
          name: 'pnpm-pin',
          type: 'pnpm.overrides',
          current: { version: '2.0.0', publishedAt: null },
          latestMinor: null,
          latestMajor: null,
          ageInDays: 20,
          latestAgeInDays: 20,
          updateType: 'up-to-date',
          deprecated: null,
          transitive: false,
        },
      ],
      skipped: [],
    };
    const out = formatTable(report, { color: false });
    assert.match(out, /yarn-pin\s+│\s+resol\s+│/);
    assert.match(out, /pnpm-pin\s+│\s+pnpm\s+│/);
  });

  it('defaults color to TTY detection when option is omitted', () => {
    const report: AnalysisReport = {
      summary: { total: 0, upToDate: 0, minorUpdates: 0, majorUpdates: 0 },
      dependencies: [],
      skipped: [],
    };
    const out = formatTable(report);
    assert.match(out, /Summary:/);
  });
});
