import type { Cache } from './cache.ts';
import type { RegistryPackageMetadata } from './types.ts';

const DEFAULT_BASE_URL = 'https://registry.npmjs.org';

export class RegistryHttpError extends Error {
  readonly status: number;
  constructor(name: string, status: number, statusText: string) {
    super(`Registry request failed for "${name}": ${status} ${statusText}`);
    this.name = 'RegistryHttpError';
    this.status = status;
  }
}

export interface RegistryClientOptions {
  baseUrl?: string;
  cache?: Cache;
  fetchImpl?: typeof fetch;
}

export class RegistryClient {
  readonly baseUrl: string;
  readonly cache?: Cache;
  readonly fetchImpl: typeof fetch;

  constructor(opts: RegistryClientOptions = {}) {
    this.baseUrl =
      opts.baseUrl ??
      process.env.DEPENDENCY_GUARD_REGISTRY_URL ??
      DEFAULT_BASE_URL;
    this.cache = opts.cache;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getPackage(name: string): Promise<RegistryPackageMetadata> {
    const cached = await this.cache?.get<RegistryPackageMetadata>(name);
    if (cached) return cached;

    const url = `${this.baseUrl}/${encodePackageName(name)}`;
    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new RegistryHttpError(name, res.status, res.statusText);
    }
    const body = (await res.json()) as {
      name?: string;
      versions?: Record<string, { deprecated?: unknown } | undefined>;
      time?: Record<string, string>;
    };
    const versions = body.versions ?? {};
    const deprecations: Record<string, string> = {};
    for (const [version, info] of Object.entries(versions)) {
      if (info && typeof info.deprecated === 'string' && info.deprecated.length > 0) {
        deprecations[version] = info.deprecated;
      }
    }
    const meta: RegistryPackageMetadata = {
      name: body.name ?? name,
      versions: Object.keys(versions),
      time: body.time ?? {},
      deprecations,
    };
    await this.cache?.set(name, meta);
    return meta;
  }
}

function encodePackageName(name: string): string {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash > 0) {
      return `${name.slice(0, slash)}/${encodeURIComponent(name.slice(slash + 1))}`;
    }
  }
  return encodeURIComponent(name);
}
