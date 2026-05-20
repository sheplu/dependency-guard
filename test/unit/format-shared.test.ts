import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { statusLabel, typeShort } from '../../src/format/shared.ts';

describe('typeShort', () => {
  it('returns the short label for each dependency type', () => {
    assert.equal(typeShort('dependencies'), 'prod');
    assert.equal(typeShort('devDependencies'), 'dev');
    assert.equal(typeShort('peerDependencies'), 'peer');
    assert.equal(typeShort('optionalDependencies'), 'opt');
    assert.equal(typeShort('overrides'), 'over');
    assert.equal(typeShort('resolutions'), 'resol');
    assert.equal(typeShort('pnpm.overrides'), 'pnpm');
  });
});

describe('statusLabel', () => {
  it('returns the label for each updateType', () => {
    assert.match(statusLabel('up-to-date'), /Up to date/);
    assert.match(statusLabel('minor'), /Minor/);
    assert.match(statusLabel('major'), /Major/);
  });
});
