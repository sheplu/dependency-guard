import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockPackage {
  name: string;
  versions: Record<string, { version: string; deprecated?: string }>;
  time: Record<string, string>;
}

export interface MockRegistry {
  url: string;
  close: () => Promise<void>;
}

export async function startMockRegistry(packages: MockPackage[]): Promise<MockRegistry> {
  const byName = new Map(packages.map((p) => [p.name, p]));

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\//, ''));
    const pkg = byName.get(path);
    if (!pkg) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(pkg));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}
