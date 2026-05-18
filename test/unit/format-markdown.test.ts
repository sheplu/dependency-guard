import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatMarkdown } from '../../src/format/markdown.ts';
import type { AnalysisReport } from '../../src/types.ts';

describe('formatMarkdown', () => {
  it('produces a markdown table with summary', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 0, minorUpdates: 0, majorUpdates: 1 },
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
        },
      ],
      skipped: [],
    };
    const out = formatMarkdown(report);
    assert.match(out, /## Dependency Report/);
    assert.match(out, /\| Package \| Type \| Current \|/);
    assert.match(out, /\| express \| prod \| 4\.18\.2 \| 4\.21\.0 \| 5\.0\.1 \| 8mo \| 6mo \| ⬆ Major \|/);
  });

  it('renders a dash for null latest versions on up-to-date rows', () => {
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
        },
      ],
      skipped: [],
    };
    const out = formatMarkdown(report);
    assert.match(out, /\| lodash \| prod \| 4\.17\.21 \| - \| - \| 2y \| 2y \| ✓ Up to date \|/);
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
        },
      ],
      skipped: [],
    };
    const out = formatMarkdown(report);
    assert.match(out, /\| request ⚠ \|/);
  });

  it('omits the heading and bullet list when quiet: true', () => {
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
        },
      ],
      skipped: [],
    };
    const out = formatMarkdown(report, { quiet: true });
    assert.doesNotMatch(out, /## Dependency Report/);
    assert.doesNotMatch(out, /- Total:/);
    assert.match(out, /\| Package \|/);
    assert.match(out, /\| lodash \|/);
  });
});
