import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { RegistryClient } from '../../src/registry.ts';

describe('RegistryClient env defaults', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DEPENDENCY_GUARD_REGISTRY_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEPENDENCY_GUARD_REGISTRY_URL;
    else process.env.DEPENDENCY_GUARD_REGISTRY_URL = originalEnv;
  });

  it('uses DEPENDENCY_GUARD_REGISTRY_URL when set and no baseUrl provided', () => {
    process.env.DEPENDENCY_GUARD_REGISTRY_URL = 'http://from-env.example';
    const client = new RegistryClient();
    assert.equal(client.baseUrl, 'http://from-env.example');
  });

  it('falls back to the default registry when env is unset and no baseUrl provided', () => {
    delete process.env.DEPENDENCY_GUARD_REGISTRY_URL;
    const client = new RegistryClient();
    assert.equal(client.baseUrl, 'https://registry.npmjs.org');
  });

  it('uses default fetch when fetchImpl is omitted', () => {
    const client = new RegistryClient({ baseUrl: 'http://example.invalid' });
    assert.equal(client.fetchImpl, fetch);
  });
});
