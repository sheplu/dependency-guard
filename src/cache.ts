import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function defaultDir(): string {
  return process.env.DEPENDENCY_GUARD_CACHE_DIR ?? join(homedir(), '.cache', 'dependency-guard');
}

export interface CacheOptions {
  dir?: string;
  ttlMs?: number;
  enabled?: boolean;
}

export class Cache {
  readonly dir: string;
  readonly ttlMs: number;
  readonly enabled: boolean;

  constructor(opts: CacheOptions = {}) {
    this.dir = opts.dir ?? defaultDir();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.enabled = opts.enabled ?? true;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.enabled) return null;
    const file = this.fileFor(key);
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > this.ttlMs) return null;
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.enabled) return;
    const file = this.fileFor(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), 'utf8');
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  fileFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }
}
