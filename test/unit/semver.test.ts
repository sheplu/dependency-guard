import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { compare, isStable, maxVersion, parse, stripRange } from '../../src/semver.ts';

describe('semver.parse', () => {
  it('parses major.minor.patch', () => {
    const v = parse('1.2.3');
    assert.equal(v?.major, 1);
    assert.equal(v?.minor, 2);
    assert.equal(v?.patch, 3);
    assert.deepEqual(v?.prerelease, []);
  });

  it('strips leading v and range markers', () => {
    assert.equal(parse('v1.2.3')?.raw, '1.2.3');
    assert.equal(parse('^1.2.3')?.raw, '1.2.3');
    assert.equal(parse('~1.2.3')?.raw, '1.2.3');
    assert.equal(parse('>=1.2.3')?.raw, '1.2.3');
  });

  it('parses prereleases', () => {
    const v = parse('1.0.0-beta.2');
    assert.deepEqual(v?.prerelease, ['beta', 2]);
  });

  it('parses build metadata', () => {
    const v = parse('1.0.0+build.1.2');
    assert.deepEqual(v?.build, ['build', '1', '2']);
  });

  it('returns null for invalid input', () => {
    assert.equal(parse('not-a-version'), null);
    assert.equal(parse(''), null);
    assert.equal(parse('1.2'), null);
  });

  it('resolves wildcard-only specs to 0.0.0', () => {
    assert.equal(parse('*')?.raw, '0.0.0');
    assert.equal(parse('x')?.raw, '0.0.0');
    assert.equal(parse('X')?.raw, '0.0.0');
  });

  it('resolves major-wildcard specs to MAJOR.0.0', () => {
    assert.equal(parse('1.x')?.raw, '1.0.0');
    assert.equal(parse('1.X')?.raw, '1.0.0');
    assert.equal(parse('1.*')?.raw, '1.0.0');
  });

  it('resolves minor-wildcard specs to MAJOR.MINOR.0', () => {
    assert.equal(parse('1.2.x')?.raw, '1.2.0');
    assert.equal(parse('1.2.X')?.raw, '1.2.0');
    assert.equal(parse('1.2.*')?.raw, '1.2.0');
  });

  it('resolves multi-segment wildcards to lower bound', () => {
    assert.equal(parse('1.x.x')?.raw, '1.0.0');
    assert.equal(parse('*.*.*')?.raw, '0.0.0');
  });

  it('strips range markers before resolving wildcards', () => {
    assert.equal(parse('^1.x')?.raw, '1.0.0');
    assert.equal(parse('~1.2.x')?.raw, '1.2.0');
  });

  it('still rejects malformed segments mixed with wildcards', () => {
    assert.equal(parse('1.x.foo'), null);
    assert.equal(parse('1.2x'), null);
  });
});

describe('semver.compare', () => {
  it('orders by major then minor then patch', () => {
    assert.equal(Math.sign(compare(parse('1.0.0')!, parse('2.0.0')!)), -1);
    assert.equal(Math.sign(compare(parse('1.2.0')!, parse('1.1.99')!)), 1);
    assert.equal(Math.sign(compare(parse('1.0.5')!, parse('1.0.5')!)), 0);
    assert.equal(Math.sign(compare(parse('1.0.1')!, parse('1.0.2')!)), -1);
    assert.equal(Math.sign(compare(parse('1.0.2')!, parse('1.0.1')!)), 1);
  });

  it('treats prereleases as lower than stable', () => {
    assert.equal(Math.sign(compare(parse('1.0.0-beta')!, parse('1.0.0')!)), -1);
  });

  it('orders prerelease identifiers numerically and lexically', () => {
    assert.equal(Math.sign(compare(parse('1.0.0-alpha.1')!, parse('1.0.0-alpha.2')!)), -1);
    assert.equal(Math.sign(compare(parse('1.0.0-alpha')!, parse('1.0.0-beta')!)), -1);
  });

  it('orders prereleases by length when shared prefix matches', () => {
    assert.equal(Math.sign(compare(parse('1.0.0-alpha')!, parse('1.0.0-alpha.1')!)), -1);
    assert.equal(Math.sign(compare(parse('1.0.0-alpha.1')!, parse('1.0.0-alpha')!)), 1);
  });

  it('treats numeric prerelease identifiers as lower than alphanumeric', () => {
    assert.equal(Math.sign(compare(parse('1.0.0-1')!, parse('1.0.0-alpha')!)), -1);
    assert.equal(Math.sign(compare(parse('1.0.0-alpha')!, parse('1.0.0-1')!)), 1);
  });

  it('orders stable above prerelease in both directions', () => {
    assert.equal(Math.sign(compare(parse('1.0.0')!, parse('1.0.0-alpha')!)), 1);
    assert.equal(Math.sign(compare(parse('1.0.0-alpha')!, parse('1.0.0')!)), -1);
  });

  it('orders alphanumeric prereleases in both directions', () => {
    assert.equal(Math.sign(compare(parse('1.0.0-gamma')!, parse('1.0.0-beta')!)), 1);
    assert.equal(Math.sign(compare(parse('1.0.0-beta')!, parse('1.0.0-gamma')!)), -1);
  });

  it('continues past equal prerelease identifiers when comparing', () => {
    // prereleases share "alpha" then differ on the second segment
    assert.equal(Math.sign(compare(parse('1.0.0-alpha.1')!, parse('1.0.0-alpha.1')!)), 0);
    assert.equal(Math.sign(compare(parse('1.0.0-alpha.beta')!, parse('1.0.0-alpha.gamma')!)), -1);
  });

  it('returns 0 when both versions are identical stable releases', () => {
    assert.equal(compare(parse('2.5.7')!, parse('2.5.7')!), 0);
  });
});

describe('semver.isStable', () => {
  it('returns true for stable versions', () => {
    assert.equal(isStable(parse('1.0.0')!), true);
  });
  it('returns false for prereleases', () => {
    assert.equal(isStable(parse('1.0.0-rc.1')!), false);
  });
});

describe('semver.maxVersion', () => {
  it('returns the highest version', () => {
    const versions = ['1.0.0', '1.2.3', '2.0.0', '1.5.0'].map((v) => parse(v)!);
    assert.equal(maxVersion(versions)?.raw, '2.0.0');
  });

  it('returns null on empty list', () => {
    assert.equal(maxVersion([]), null);
  });
});

describe('semver.stripRange', () => {
  it('strips common range markers', () => {
    assert.equal(stripRange('^1.2.3'), '1.2.3');
    assert.equal(stripRange('~1.2.3'), '1.2.3');
    assert.equal(stripRange('>=1.2.3'), '1.2.3');
    assert.equal(stripRange('1.2.3'), '1.2.3');
  });
});
