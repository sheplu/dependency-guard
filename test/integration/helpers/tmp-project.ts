import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpProjectOptions {
  packageJson: Record<string, unknown>;
  installed?: Record<string, string>;
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

  return {
    dir,
    packageJsonPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
