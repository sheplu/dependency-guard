import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ageInDays, formatAge } from '../../src/age.ts';

describe('age.ageInDays', () => {
  it('returns null for null input', () => {
    assert.equal(ageInDays(null), null);
  });

  it('returns null for invalid date', () => {
    assert.equal(ageInDays('not-a-date'), null);
  });

  it('returns 0 for future dates', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal(ageInDays(future), 0);
  });

  it('computes day difference', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const tenDaysAgo = '2026-05-08T12:00:00Z';
    assert.equal(ageInDays(tenDaysAgo, now), 10);
  });
});

describe('age.formatAge', () => {
  it('formats null as dash', () => {
    assert.equal(formatAge(null), '-');
  });

  it('formats <30 days as days', () => {
    assert.equal(formatAge(0), '0d');
    assert.equal(formatAge(15), '15d');
    assert.equal(formatAge(29), '29d');
  });

  it('formats <365 days as months', () => {
    assert.equal(formatAge(60), '2mo');
    assert.equal(formatAge(364), '12mo');
  });

  it('formats >=365 days as years', () => {
    assert.equal(formatAge(365), '1y');
    assert.equal(formatAge(800), '2y');
  });
});
