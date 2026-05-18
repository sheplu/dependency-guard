import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

  it('lists --ignore-scope in help text', async () => {
    const result = await run(['--help']);
    assert.match(result.stdout, /--ignore-scope/);
  });

  it('lists --quiet, --cache-clear, and --cache-ttl in help text', async () => {
    const result = await run(['--help']);
    assert.match(result.stdout, /-q, --quiet/);
    assert.match(result.stdout, /--cache-clear/);
    assert.match(result.stdout, /--cache-ttl/);
  });

  it('rejects --cache-ttl with non-integer value', async () => {
    const result = await run(['--cache-ttl', 'abc']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --cache-ttl/);
  });

  it('rejects --cache-ttl with zero', async () => {
    const result = await run(['--cache-ttl', '0']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --cache-ttl/);
  });

  it('rejects --cache-ttl with negative value', async () => {
    const result = await run(['--cache-ttl=-5']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --cache-ttl/);
  });

  it('rejects --cache-ttl with non-integer numeric value', async () => {
    const result = await run(['--cache-ttl', '1.5']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --cache-ttl/);
  });

  it('lists --fail-on and --max-age in help text', async () => {
    const result = await run(['--help']);
    assert.match(result.stdout, /--fail-on <level>/);
    assert.match(result.stdout, /--max-age <days>/);
  });

  it('rejects --fail-on with an unknown level', async () => {
    const result = await run(['--fail-on', 'patch']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --fail-on/);
  });

  it('rejects --max-age with non-integer value', async () => {
    const result = await run(['--max-age', 'abc']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --max-age/);
  });

  it('rejects --max-age with zero', async () => {
    const result = await run(['--max-age', '0']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --max-age/);
  });

  it('rejects --max-age with negative value', async () => {
    const result = await run(['--max-age=-5']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid --max-age/);
  });
});

describe('cli.run --cache-clear', () => {
  let cacheDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'dep-guard-clear-'));
    originalEnv = process.env.DEPENDENCY_GUARD_CACHE_DIR;
    process.env.DEPENDENCY_GUARD_CACHE_DIR = cacheDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.DEPENDENCY_GUARD_CACHE_DIR;
    else process.env.DEPENDENCY_GUARD_CACHE_DIR = originalEnv;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('clears the cache and exits 0 without analyzing', async () => {
    const result = await run(['--cache-clear']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Cache cleared:/);
    assert.match(result.stdout, new RegExp(cacheDir.replace(/[/.]/g, '\\$&')));
  });
});
