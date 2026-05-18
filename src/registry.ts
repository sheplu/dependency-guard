import type { Cache } from './cache.ts';
import type { RegistryPackageMetadata } from './types.ts';

const DEFAULT_BASE_URL = 'https://registry.npmjs.org';

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
      throw new Error(`Registry request failed for "${name}": ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      name?: string;
      versions?: Record<string, unknown>;
      time?: Record<string, string>;
    };
    const meta: RegistryPackageMetadata = {
      name: body.name ?? name,
      versions: Object.keys(body.versions ?? {}),
      time: body.time ?? {},
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
