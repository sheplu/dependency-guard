import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpProjectOptions {
  packageJson: Record<string, unknown>;
  installed?: Record<string, string>;
  packageLock?: Record<string, unknown>;
  yarnLock?: string;
  pnpmLock?: string;
  pnpmWorkspace?: string;
}

export interface TmpProject {
  dir: string;
  packageJsonPath: string;
  cleanup: () => Promise<void>;
}

export async function createTmpProject(options: TmpProjectOptions): Promise<TmpProject> {
  const dir = await mkdtemp(join(tmpdir(), 'dep-guard-proj-'));
  const packageJsonPath = join(dir, 'package.json');
  await writeFile(packageJsonPath, JSON.stringify(options.packageJson, null, 2));

  for (const [name, version] of Object.entries(options.installed ?? {})) {
    const pkgDir = join(dir, 'node_modules', name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name, version }),
    );
  }

  if (options.packageLock !== undefined) {
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify(options.packageLock, null, 2),
    );
  }

  if (options.yarnLock !== undefined) {
    await writeFile(join(dir, 'yarn.lock'), options.yarnLock);
  }

  if (options.pnpmLock !== undefined) {
    await writeFile(join(dir, 'pnpm-lock.yaml'), options.pnpmLock);
  }

  if (options.pnpmWorkspace !== undefined) {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), options.pnpmWorkspace);
  }

  return {
    dir,
    packageJsonPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
