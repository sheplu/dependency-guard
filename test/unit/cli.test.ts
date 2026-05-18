import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { run } from '../../src/cli.ts';

describe('cli.run', () => {
  it('returns exitCode 1 with help text on unknown flag', async () => {
    const result = await run(['--no-such-flag']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Usage: dependency-guard/);
  });

  it('returns exitCode 1 on invalid format value', async () => {
    const result = await run(['--format', 'xml']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --format/);
  });

  it('prints help with --help', async () => {
    const result = await run(['--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage: dependency-guard/);
  });

  it('prints version with --version', async () => {
    const result = await run(['--version']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });
});
