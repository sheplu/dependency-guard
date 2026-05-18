import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { detectLockfiles, expandWithLockfile, parsePnpmLock, parseYarnLock } from '../../src/lockfile.ts';
import type { DependencyEntry } from '../../src/package-json.ts';

const directExpress: DependencyEntry = {
  name: 'express',
  type: 'dependencies',
  spec: '^4.18.0',
  installedVersion: '4.18.2',
  transitive: false,
};

describe('expandWithLockfile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-lock-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeLock(lock: unknown) {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
  }

  it('returns input unchanged when no lockfile is present', async () => {
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged when JSON is malformed', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{not json');
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged for lockfileVersion < 3', async () => {
    await writeLock({ lockfileVersion: 2, packages: {} });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged when lockfileVersion is missing', async () => {
    await writeLock({ packages: {} });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('walks a 2-level dependency tree', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          dependencies: { 'body-parser': '1.20.0' },
        },
        'node_modules/body-parser': {
          version: '1.20.0',
          dependencies: { qs: '6.10.0' },
        },
        'node_modules/qs': { version: '6.10.0' },
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.equal(out.length, 3);
    assert.equal(out[0], directExpress);
    assert.deepEqual(
      out.slice(1).map((d) => [d.name, d.transitive, d.installedVersion]),
      [
        ['body-parser', true, '1.20.0'],
        ['qs', true, '6.10.0'],
      ],
    );
  });

  it('dedupes when two direct deps share a transitive', async () => {
    const directA: DependencyEntry = {
      name: 'a',
      type: 'dependencies',
      spec: '1.0.0',
      installedVersion: '1.0.0',
      transitive: false,
    };
    const directB: DependencyEntry = {
      name: 'b',
      type: 'dependencies',
      spec: '1.0.0',
      installedVersion: '1.0.0',
      transitive: false,
    };
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/a': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
        'node_modules/b': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
        'node_modules/shared': { version: '2.0.0' },
      },
    });
    const out = await expandWithLockfile([directA, directB], dir);
    assert.equal(out.filter((d) => d.name === 'shared').length, 1);
  });

  it('honors optionalDependencies of intermediate nodes', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          optionalDependencies: { 'opt-helper': '1.0.0' },
        },
        'node_modules/opt-helper': { version: '1.0.0' },
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(
      out.map((d) => d.name),
      ['express', 'opt-helper'],
    );
  });

  it('skips a transitive that has no version entry in the lockfile', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          dependencies: { phantom: '1.0.0' },
        },
        // phantom is referenced but has no entry — skip it
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(
      out.map((d) => d.name),
      ['express'],
    );
  });

  it('skips a yarn child that has no lockfile entry of its own', async () => {
    // express references "phantom" as a child, but phantom has no top-level entry
    await writeFile(
      join(dir, 'yarn.lock'),
      `"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    phantom: "npm:^1.0.0"
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out.map((d) => d.name), ['express']);
  });

  it('handles a v3 lockfile with no packages field', async () => {
    await writeLock({ lockfileVersion: 3 });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('skips a direct dep with no lockfile entry (no expansion from it)', async () => {
    await writeLock({
      lockfileVersion: 3,
      packages: {
        // no node_modules/express entry — direct dep can't be expanded
        'node_modules/lodash': { version: '4.17.21' },
      },
    });
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(
      out.map((d) => d.name),
      ['express'],
    );
  });

  it('does not re-add a direct dep as a transitive', async () => {
    const directBodyParser: DependencyEntry = {
      name: 'body-parser',
      type: 'dependencies',
      spec: '1.20.0',
      installedVersion: '1.20.0',
      transitive: false,
    };
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/express': {
          version: '4.18.2',
          dependencies: { 'body-parser': '1.20.0' },
        },
        'node_modules/body-parser': { version: '1.20.0' },
      },
    });
    const out = await expandWithLockfile([directExpress, directBodyParser], dir);
    assert.equal(out.length, 2);
    assert.equal(out[1].transitive, false); // body-parser stays as direct
  });

  it('inherits parent direct dep type for transitives', async () => {
    const directDev: DependencyEntry = {
      name: 'typescript',
      type: 'devDependencies',
      spec: '5.0.0',
      installedVersion: '5.0.0',
      transitive: false,
    };
    await writeLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/typescript': {
          version: '5.0.0',
          dependencies: { 'ts-helper': '1.0.0' },
        },
        'node_modules/ts-helper': { version: '1.0.0' },
      },
    });
    const out = await expandWithLockfile([directDev], dir);
    const helper = out.find((d) => d.name === 'ts-helper');
    assert.equal(helper?.type, 'devDependencies');
  });
});

const YARN_FIXTURE = `# This file is generated by running "yarn install"
__metadata:
  version: 8
  cacheKey: 10c0

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    body-parser: "npm:1.20.0"
    qs: "npm:^6.10.3"
  checksum: 10c0/abc
  languageName: node
  linkType: hard

"body-parser@npm:1.20.0":
  version: 1.20.0
  resolution: "body-parser@npm:1.20.0"
  dependencies:
    qs: "npm:6.10.3"

"qs@npm:6.10.3, qs@npm:^6.10.3":
  version: 6.10.3
  resolution: "qs@npm:6.10.3"

"@types/node@npm:^20.0.0":
  version: 20.5.1
  resolution: "@types/node@npm:20.5.1"

"my-app@workspace:.":
  version: 0.0.0-use.local
  resolution: "my-app@workspace:."
`;

describe('parseYarnLock', () => {
  it('parses a multi-package fixture', () => {
    const entries = parseYarnLock(YARN_FIXTURE);
    const names = entries.map((e) => e.selectors[0]);
    assert.ok(names.includes('express@npm:^4.18.0'));
    assert.ok(names.includes('body-parser@npm:1.20.0'));
    const express = entries.find((e) => e.selectors[0] === 'express@npm:^4.18.0');
    assert.equal(express?.version, '4.18.2');
    assert.deepEqual(express?.childNames, ['body-parser', 'qs']);
  });

  it('skips the __metadata block', () => {
    const entries = parseYarnLock(YARN_FIXTURE);
    assert.ok(entries.every((e) => !e.selectors[0].startsWith('__metadata')));
  });

  it('skips workspace/patch/portal/file/git protocol entries', () => {
    const entries = parseYarnLock(YARN_FIXTURE);
    assert.ok(entries.every((e) => !e.selectors[0].includes('@workspace:')));
  });

  it('handles comma-separated selectors on a single header', () => {
    const entries = parseYarnLock(YARN_FIXTURE);
    const qs = entries.find((e) => e.selectors.includes('qs@npm:6.10.3'));
    assert.ok(qs);
    assert.deepEqual(qs?.selectors, ['qs@npm:6.10.3', 'qs@npm:^6.10.3']);
  });

  it('handles scoped package names', () => {
    const entries = parseYarnLock(YARN_FIXTURE);
    const types = entries.find((e) => e.selectors[0].startsWith('@types/node'));
    assert.equal(types?.version, '20.5.1');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseYarnLock(''), []);
  });

  it('skips comments and blank lines', () => {
    const entries = parseYarnLock(`# top comment

"foo@npm:1.0.0":
  version: 1.0.0
  resolution: "foo@npm:1.0.0"
`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, '1.0.0');
  });

  it('drops entries that have no resolved version', () => {
    const entries = parseYarnLock(`"broken@npm:1.0.0":
  resolution: "broken@npm:1.0.0"
`);
    assert.deepEqual(entries, []);
  });

  it('ignores 4-space-indented lines outside a dependencies block', () => {
    // The `bin:` block has 4-space-indented entries but they should not be picked up
    const entries = parseYarnLock(`"app@npm:1.0.0":
  version: 1.0.0
  resolution: "app@npm:1.0.0"
  bin:
    cli: "./bin/cli.js"
  dependencies:
    real-child: "npm:^1.0.0"
`);
    assert.deepEqual(entries[0].childNames, ['real-child']);
  });

  it('ignores malformed child lines that do not match the expected pattern', () => {
    const entries = parseYarnLock(`"app@npm:1.0.0":
  version: 1.0.0
  resolution: "app@npm:1.0.0"
  dependencies:
    !!malformed!!
    real-child: "npm:^1.0.0"
`);
    assert.deepEqual(entries[0].childNames, ['real-child']);
  });

  it('ignores child entries with non-npm protocols', () => {
    const entries = parseYarnLock(`"app@npm:1.0.0":
  version: 1.0.0
  resolution: "app@npm:1.0.0"
  dependencies:
    real-child: "npm:^1.0.0"
    portaled: "portal:../local"
    patched: "patch:foo@npm:1.0.0#./fix.patch"
`);
    assert.deepEqual(entries[0].childNames, ['real-child']);
  });
});

describe('expandWithLockfile (yarn)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-yarn-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('walks a yarn-only project', async () => {
    await writeFile(join(dir, 'yarn.lock'), YARN_FIXTURE);
    const out = await expandWithLockfile([directExpress], dir);
    const names = out.map((d) => d.name);
    assert.ok(names.includes('body-parser'));
    assert.ok(names.includes('qs'));
    const bp = out.find((d) => d.name === 'body-parser');
    assert.equal(bp?.transitive, true);
    assert.equal(bp?.installedVersion, '1.20.0');
  });

  it('inherits parent type for yarn transitives', async () => {
    await writeFile(join(dir, 'yarn.lock'), YARN_FIXTURE);
    const directDev: DependencyEntry = {
      name: 'express',
      type: 'devDependencies',
      spec: '^4.18.0',
      installedVersion: '4.18.2',
      transitive: false,
    };
    const out = await expandWithLockfile([directDev], dir);
    const bp = out.find((d) => d.name === 'body-parser');
    assert.equal(bp?.type, 'devDependencies');
  });

  it('prefers npm package-lock.json when both lockfiles exist', async () => {
    // npm lockfile says: express has child "lodash"
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '4.18.2',
            dependencies: { lodash: '4.17.21' },
          },
          'node_modules/lodash': { version: '4.17.21' },
        },
      }),
    );
    // yarn lockfile says: express has child "body-parser" (different!)
    await writeFile(join(dir, 'yarn.lock'), YARN_FIXTURE);
    const out = await expandWithLockfile([directExpress], dir);
    const names = out.map((d) => d.name);
    assert.ok(names.includes('lodash'), 'should follow npm lockfile (has lodash)');
    assert.ok(!names.includes('body-parser'), 'should NOT follow yarn lockfile (has body-parser)');
  });

  it('returns input unchanged when yarn.lock is empty', async () => {
    await writeFile(join(dir, 'yarn.lock'), '');
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns input unchanged when only __metadata block is present', async () => {
    await writeFile(join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n');
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('tolerates yarn classic v1 selector format (no npm: protocol)', async () => {
    // Yarn v1 selectors don't carry @npm: — we fall back to splitting on the last @
    await writeFile(
      join(dir, 'yarn.lock'),
      `"express@^4.18.0":
  version: 4.18.2
  resolution: "express@^4.18.0"
  dependencies:
    body-parser: "1.20.0"

"body-parser@1.20.0":
  version: 1.20.0
  resolution: "body-parser@1.20.0"
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    const names = out.map((d) => d.name);
    assert.ok(names.includes('body-parser'));
  });

  it('returns null from parseSelectorName for malformed selectors with no @', async () => {
    // A header line with just "weird:" produces a selector with no @ at all;
    // parseSelectorName should refuse to extract a name (safety net).
    // We exercise this via a lockfile that has such an entry alongside a real one;
    // the malformed one is silently dropped from the byName map.
    await writeFile(
      join(dir, 'yarn.lock'),
      `"weird":
  version: 0.0.0
  resolution: "weird"

"@only-scoped":
  version: 0.0.0
  resolution: "@only-scoped"

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    // Real entry still works; malformed ones don't crash.
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'express');
  });
});

const PNPM_FIXTURE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      express:
        specifier: ^4.18.0
        version: 4.18.2

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
    dependencies:
      body-parser: 1.20.0
      qs: 6.10.3

  body-parser@1.20.0:
    resolution: {integrity: sha512-y}
    dependencies:
      qs: 6.10.3
    optionalDependencies:
      iconv-lite: 0.4.24
    peerDependencies:
      should-be-ignored: '*'

  qs@6.10.3:
    resolution: {integrity: sha512-z}

  '@types/node@20.5.1':
    resolution: {integrity: sha512-q}

  'foo@1.0.0(react@18.2.0)':
    resolution: {integrity: sha512-r}
`;

describe('parsePnpmLock', () => {
  it('parses a multi-package fixture', () => {
    const entries = parsePnpmLock(PNPM_FIXTURE);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('express'));
    assert.ok(names.includes('body-parser'));
    assert.ok(names.includes('qs'));
    const express = entries.find((e) => e.name === 'express');
    assert.equal(express?.version, '4.18.2');
    assert.deepEqual(express?.childNames, ['body-parser', 'qs']);
  });

  it('walks dependencies + optionalDependencies but skips peerDependencies', () => {
    const entries = parsePnpmLock(PNPM_FIXTURE);
    const bp = entries.find((e) => e.name === 'body-parser');
    assert.deepEqual(bp?.childNames, ['qs', 'iconv-lite']);
    assert.ok(!bp?.childNames.includes('should-be-ignored'));
  });

  it('handles scoped names with quotes', () => {
    const entries = parsePnpmLock(PNPM_FIXTURE);
    const types = entries.find((e) => e.name === '@types/node');
    assert.equal(types?.version, '20.5.1');
  });

  it('strips peer-resolution suffix from keys', () => {
    const entries = parsePnpmLock(PNPM_FIXTURE);
    const foo = entries.find((e) => e.name === 'foo');
    assert.equal(foo?.version, '1.0.0');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parsePnpmLock(''), []);
  });

  it('returns empty array when no packages: block exists', () => {
    assert.deepEqual(
      parsePnpmLock(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express: 4.18.2
`),
      [],
    );
  });

  it('skips comments and stray top-level keys before packages:', () => {
    const entries = parsePnpmLock(`# top comment

settings:
  autoInstallPeers: true

packages:

  foo@1.0.0:
    resolution: {integrity: sha512-x}
`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'foo');
  });

  it('drops malformed package keys (no @)', () => {
    const entries = parsePnpmLock(`packages:

  weird:
    resolution: {integrity: sha512-x}

  express@4.18.2:
    resolution: {integrity: sha512-y}
`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'express');
  });

  it('drops package keys with empty version (e.g. "name@")', () => {
    const entries = parsePnpmLock(`packages:

  broken@:
    resolution: {integrity: sha512-x}

  express@4.18.2:
    resolution: {integrity: sha512-y}
`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'express');
  });

  it('skips 2-space-indented lines that do not end with ":"', () => {
    // Pathological input: a 2-space-indented line that's not a key. We tolerate it.
    const entries = parsePnpmLock(`packages:

  stray-line-without-colon
  express@4.18.2:
    resolution: {integrity: sha512-y}
`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'express');
  });

  it('skips 6-space-indented child lines that do not match the expected pattern', () => {
    // Pathological child line — the parser tolerates it without crashing.
    const entries = parsePnpmLock(`packages:

  app@1.0.0:
    resolution: {integrity: sha512-x}
    dependencies:
      ----not a valid line----
      real-child: 2.0.0
`);
    assert.deepEqual(entries[0].childNames, ['real-child']);
  });

  it('ignores child entries with flow-style values (e.g. resolution maps)', () => {
    // Defensive: if for some reason a flow-mapping appears at child indent,
    // we don't try to interpret it as a child package.
    const entries = parsePnpmLock(`packages:

  app@1.0.0:
    resolution: {integrity: sha512-x}
    dependencies:
      flow-mapped: {weird: yes}
      real-child: 2.0.0
`);
    assert.deepEqual(entries[0].childNames, ['real-child']);
  });

  it('ignores 6-space-indent lines outside a deps/optionalDeps block', () => {
    const entries = parsePnpmLock(`packages:

  app@1.0.0:
    resolution: {integrity: sha512-x}
    peerDependencies:
      ignored-peer: '*'
    dependencies:
      real-child: 2.0.0
`);
    assert.deepEqual(entries[0].childNames, ['real-child']);
  });
});

describe('expandWithLockfile (pnpm)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-pnpm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('walks a pnpm-only project', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_FIXTURE);
    const out = await expandWithLockfile([directExpress], dir);
    const names = out.map((d) => d.name);
    assert.ok(names.includes('body-parser'));
    assert.ok(names.includes('qs'));
    const bp = out.find((d) => d.name === 'body-parser');
    assert.equal(bp?.transitive, true);
    assert.equal(bp?.installedVersion, '1.20.0');
  });

  it('inherits parent type for pnpm transitives', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_FIXTURE);
    const directDev: DependencyEntry = {
      name: 'express',
      type: 'devDependencies',
      spec: '^4.18.0',
      installedVersion: '4.18.2',
      transitive: false,
    };
    const out = await expandWithLockfile([directDev], dir);
    const bp = out.find((d) => d.name === 'body-parser');
    assert.equal(bp?.type, 'devDependencies');
  });

  it('returns null lockfile for missing file', async () => {
    // No pnpm-lock.yaml written.
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns null lockfile when lockfileVersion < 6', async () => {
    await writeFile(
      join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: '5.4'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns null lockfile when lockfileVersion is missing', async () => {
    await writeFile(
      join(dir, 'pnpm-lock.yaml'),
      `packages:

  express@4.18.2:
    resolution: {integrity: sha512-x}
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('returns null lockfile when packages: block has no entries', async () => {
    await writeFile(
      join(dir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express: 4.18.2
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    assert.deepEqual(out, [directExpress]);
  });

  it('prefers npm package-lock.json over pnpm-lock.yaml when both exist', async () => {
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/express': {
            version: '4.18.2',
            dependencies: { lodash: '4.17.21' },
          },
          'node_modules/lodash': { version: '4.17.21' },
        },
      }),
    );
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_FIXTURE);
    const out = await expandWithLockfile([directExpress], dir);
    const names = out.map((d) => d.name);
    // npm path: lodash. pnpm path would have body-parser + qs.
    assert.ok(names.includes('lodash'));
    assert.ok(!names.includes('body-parser'));
  });

  it('prefers pnpm-lock.yaml over yarn.lock when both exist', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_FIXTURE);
    await writeFile(
      join(dir, 'yarn.lock'),
      `__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2
  resolution: "express@npm:4.18.2"
  dependencies:
    yarn-only-child: "npm:1.0.0"
`,
    );
    const out = await expandWithLockfile([directExpress], dir);
    const names = out.map((d) => d.name);
    // pnpm path wins → body-parser/qs
    assert.ok(names.includes('body-parser'));
    assert.ok(!names.includes('yarn-only-child'));
  });
});

describe('detectLockfiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-guard-detect-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns all-false when no lockfile exists', async () => {
    assert.deepEqual(await detectLockfiles(dir), { npm: false, pnpm: false, yarn: false });
  });

  it('detects only npm', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{}');
    assert.deepEqual(await detectLockfiles(dir), { npm: true, pnpm: false, yarn: false });
  });

  it('detects only pnpm', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    assert.deepEqual(await detectLockfiles(dir), { npm: false, pnpm: true, yarn: false });
  });

  it('detects only yarn', async () => {
    await writeFile(join(dir, 'yarn.lock'), '');
    assert.deepEqual(await detectLockfiles(dir), { npm: false, pnpm: false, yarn: true });
  });

  it('detects all three when present', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{}');
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    await writeFile(join(dir, 'yarn.lock'), '');
    assert.deepEqual(await detectLockfiles(dir), { npm: true, pnpm: true, yarn: true });
  });
});
