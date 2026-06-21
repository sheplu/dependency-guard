import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  isExcluded,
  parseDurationToDays,
  resolveReleaseAgeConfig,
} from '../../src/release-age.ts';

async function withDir(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dep-guard-relage-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('parseDurationToDays', () => {
  it('parses a bare number as seconds (yarn default unit)', () => {
    assert.equal(parseDurationToDays('86400'), 1);
  });

  it('parses unit-suffixed durations', () => {
    assert.equal(parseDurationToDays('7d'), 7);
    assert.equal(parseDurationToDays('1w'), 7);
    assert.equal(parseDurationToDays('12h'), 0.5);
    assert.equal(parseDurationToDays('30m'), 30 / 1440);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    assert.equal(parseDurationToDays(' 2W '), 14);
  });

  it('returns null for garbage', () => {
    assert.equal(parseDurationToDays('soon'), null);
    assert.equal(parseDurationToDays(''), null);
  });
});

describe('isExcluded', () => {
  it('matches exact names', () => {
    assert.equal(isExcluded('webpack', ['webpack']), true);
    assert.equal(isExcluded('webpack', ['rollup']), false);
  });

  it('matches glob patterns including scopes', () => {
    assert.equal(isExcluded('@myorg/utils', ['@myorg/*']), true);
    assert.equal(isExcluded('@other/utils', ['@myorg/*']), false);
  });

  it('ignores a version constraint in the pattern', () => {
    assert.equal(isExcluded('webpack', ['webpack@4.47.0 || 5.102.1']), true);
    assert.equal(isExcluded('@scope/pkg', ['@scope/pkg@1.0.0']), true);
  });
});

describe('resolveReleaseAgeConfig', () => {
  it('returns null when no config is present', async () => {
    await withDir({}, async (dir) => {
      const resolved = await resolveReleaseAgeConfig(dir);
      assert.equal(resolved.config, null);
    });
  });

  it('reads npm min-release-age (days) and exclude list from .npmrc', async () => {
    await withDir(
      { '.npmrc': 'min-release-age=7\nmin-release-age-exclude=webpack, @myorg/*\n' },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.equal(config.source, 'npm');
        assert.equal(config.days, 7);
        assert.deepEqual(config.exclude, ['webpack', '@myorg/*']);
      },
    );
  });

  it('reads pnpm minimumReleaseAge (minutes) and converts to days', async () => {
    await withDir(
      {
        'pnpm-workspace.yaml':
          'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - webpack\n  - "@myorg/*"\n',
      },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.equal(config.source, 'pnpm');
        assert.equal(config.days, 1);
        assert.deepEqual(config.exclude, ['webpack', '@myorg/*']);
      },
    );
  });

  it('reads pnpm inline-array exclude', async () => {
    await withDir(
      {
        'pnpm-workspace.yaml':
          'minimumReleaseAge: 2880\nminimumReleaseAgeExclude: [webpack, rollup]\n',
      },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.equal(config.days, 2);
        assert.deepEqual(config.exclude, ['webpack', 'rollup']);
      },
    );
  });

  it('reads yarn npmMinimalAgeGate duration string', async () => {
    await withDir({ '.yarnrc.yml': 'npmMinimalAgeGate: "1w"\n' }, async (dir) => {
      const { config } = await resolveReleaseAgeConfig(dir);
      assert.ok(config);
      assert.equal(config.source, 'yarn');
      assert.equal(config.days, 7);
    });
  });

  it('prefers the most conservative window when multiple configs coexist', async () => {
    await withDir(
      {
        '.npmrc': 'min-release-age=3\n',
        'pnpm-workspace.yaml': 'minimumReleaseAge: 14400\n', // 10 days
      },
      async (dir) => {
        const { config, conflicts } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.equal(config.source, 'pnpm');
        assert.equal(config.days, 10);
        assert.equal(conflicts.length, 1);
        assert.match(conflicts[0], /npm/);
      },
    );
  });

  it('walks up to a parent directory to find config', async () => {
    await withDir({ '.npmrc': 'min-release-age=5\n' }, async (dir) => {
      const child = join(dir, 'packages', 'app');
      await rm(child, { recursive: true, force: true }).catch(() => {});
      const { mkdir } = await import('node:fs/promises');
      await mkdir(child, { recursive: true });
      const { config } = await resolveReleaseAgeConfig(child);
      assert.ok(config);
      assert.equal(config.days, 5);
    });
  });

  it('ignores zero or negative values', async () => {
    await withDir({ '.npmrc': 'min-release-age=0\n' }, async (dir) => {
      const { config } = await resolveReleaseAgeConfig(dir);
      assert.equal(config, null);
    });
  });

  it('returns null for a .npmrc without the release-age key', async () => {
    await withDir({ '.npmrc': 'registry=https://example.com\n' }, async (dir) => {
      const { config } = await resolveReleaseAgeConfig(dir);
      assert.equal(config, null);
    });
  });

  it('parses .npmrc despite section headers and keyless lines', async () => {
    await withDir(
      { '.npmrc': '[scope]\nstandalone-flag\nmin-release-age=4\n' },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.equal(config.days, 4);
      },
    );
  });

  it('ignores a non-numeric pnpm minimumReleaseAge', async () => {
    await withDir(
      { 'pnpm-workspace.yaml': 'minimumReleaseAge: soon\n' },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.equal(config, null);
      },
    );
  });

  it('ignores a pnpm block scalar indicator as the value', async () => {
    await withDir(
      { 'pnpm-workspace.yaml': 'minimumReleaseAge: |\n  1440\n' },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.equal(config, null);
      },
    );
  });

  it('stops collecting a pnpm exclude block at the first non-item line', async () => {
    await withDir(
      {
        'pnpm-workspace.yaml':
          'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - webpack\npackages:\n  - "pkgs/*"\n',
      },
      async (dir) => {
        const { config } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.deepEqual(config.exclude, ['webpack']);
      },
    );
  });

  it('returns null for a .yarnrc.yml without the gate key', async () => {
    await withDir({ '.yarnrc.yml': 'nodeLinker: node-modules\n' }, async (dir) => {
      const { config } = await resolveReleaseAgeConfig(dir);
      assert.equal(config, null);
    });
  });

  it('ignores an unparseable yarn npmMinimalAgeGate', async () => {
    await withDir({ '.yarnrc.yml': 'npmMinimalAgeGate: "soon"\n' }, async (dir) => {
      const { config } = await resolveReleaseAgeConfig(dir);
      assert.equal(config, null);
    });
  });

  it('describes a one-day conflict window in the singular', async () => {
    // npm = 1 day, pnpm = 2 days → pnpm wins, npm (1 day) listed as a conflict.
    await withDir(
      {
        '.npmrc': 'min-release-age=1\n',
        'pnpm-workspace.yaml': 'minimumReleaseAge: 2880\n',
      },
      async (dir) => {
        const { config, conflicts } = await resolveReleaseAgeConfig(dir);
        assert.ok(config);
        assert.equal(config.source, 'pnpm');
        assert.equal(conflicts.length, 1);
        assert.match(conflicts[0], /1 day\b/);
      },
    );
  });
});
