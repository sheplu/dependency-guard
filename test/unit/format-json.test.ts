import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatJson } from '../../src/format/json.ts';
import type { AnalysisReport } from '../../src/types.ts';

describe('formatJson', () => {
  it('emits the report shape from the README', () => {
    const report: AnalysisReport = {
      summary: { total: 1, upToDate: 0, minorUpdates: 0, majorUpdates: 1 },
      dependencies: [
        {
          name: 'express',
          type: 'dependencies',
          current: { version: '4.18.2', publishedAt: '2024-03-25' },
          latestMinor: { version: '4.21.0', publishedAt: '2024-09-15' },
          latestMajor: { version: '5.0.1', publishedAt: '2024-11-01' },
          ageInDays: 245,
          latestAgeInDays: 199,
          updateType: 'major',
          deprecated: null,
          transitive: false,
        },
      ],
      skipped: [],
    };

    const out = JSON.parse(formatJson(report));
    assert.deepEqual(out, report);
  });
});
