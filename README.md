# dependency-guard

A Node.js CLI tool to review and analyze your project's dependencies. Get a clear overview of version differences, outdated packages, and dependency ages.

## Features

- **Version Comparison** - See current version vs latest minor vs latest major for each dependency
- **Dependency Age** - Know how old each installed version is
- **Multiple Output Formats** - Table, JSON, or Markdown output
- **Dependency Filtering** - Filter by production, dev, peer, or optional dependencies
- **Caching** - Fast repeated runs with built-in registry response caching
- **CI-Friendly** - Exit codes for automation and JSON output for parsing

## Installation

```bash
npm install -g @sheplu/dependency-guard
```

Or run directly with npx:

```bash
npx @sheplu/dependency-guard
```

## Usage

```bash
# Analyze dependencies in current directory
@sheplu/dependency-guard

# Analyze a specific project
@sheplu/dependency-guard --path /path/to/package.json

# Output as JSON
@sheplu/dependency-guard --format json

# Only check production dependencies
@sheplu/dependency-guard --prod

# Only check dev dependencies
@sheplu/dependency-guard --dev
```

## Output Example

``` text
Summary:
  Total: 12
  ✓ Up to date: 7
  ↑ Minor updates: 3
  ⬆ Major updates: 2

┌─────────────────┬──────┬─────────┬─────────┬─────────┬───────┬──────────────┐
│ Package         │ Type │ Current │ Minor   │ Major   │ Age   │ Status       │
├─────────────────┼──────┼─────────┼─────────┼─────────┼───────┼──────────────┤
│ express         │ prod │ 4.18.2  │ 4.21.0  │ 5.0.1   │ 8mo   │ ⬆ Major      │
│ lodash          │ prod │ 4.17.21 │ -       │ 4.17.21 │ 2y    │ ✓ Up to date │
│ typescript      │ dev  │ 5.2.2   │ 5.3.3   │ 5.3.3   │ 4mo   │ ↑ Minor      │
│ chalk           │ prod │ 5.3.0   │ -       │ 5.3.0   │ 6mo   │ ✓ Up to date │
│ commander       │ prod │ 11.1.0  │ 11.2.0  │ 12.0.0  │ 3mo   │ ↑ Minor      │
└─────────────────┴──────┴─────────┴─────────┴─────────┴───────┴──────────────┘
```

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--path <path>` | `-p` | Path to package.json | `./package.json` |
| `--format <format>` | `-f` | Output format: `table`, `json`, `markdown` | `table` |
| `--prod` | | Only check production dependencies | `false` |
| `--dev` | | Only check dev dependencies | `false` |
| `--peer` | | Only check peer dependencies | `false` |
| `--optional` | | Only check optional dependencies | `false` |
| `--no-cache` | | Disable caching of registry responses | `false` |
| `--registry <url>` | | Registry URL to query (also via `DEPENDENCY_GUARD_REGISTRY_URL` env var) | `https://registry.npmjs.org` |
| `--help` | `-h` | Show help | |
| `--version` | `-v` | Show version number | |

> Run `dependency-guard --help` for the full set of flags, including
> `--ignore-scope`, `--only`, `--quiet`, `--cache-clear`, `--cache-ttl`,
> `--fail-on`, `--max-age`, and `--sort`.

## Custom Registry

Point at a private mirror or proxy when the public npm registry isn't reachable:

```bash
# CLI flag (one-off)
dependency-guard --registry https://nexus.example.com/repository/npm-proxy

# Environment variable (persistent across runs)
export DEPENDENCY_GUARD_REGISTRY_URL=https://nexus.example.com/repository/npm-proxy
dependency-guard
```

The flag wins when both are set. Authenticated registries aren't supported
yet; for private packages on a registry that requires auth, use `--ignore-scope`
to skip them.

## Output Formats

### Table (default)

Human-readable table with colored status indicators.

### JSON

```bash
dependency-guard --format json
```

```json
{
  "summary": {
    "total": 12,
    "upToDate": 7,
    "minorUpdates": 3,
    "majorUpdates": 2
  },
  "dependencies": [
    {
      "name": "express",
      "type": "dependencies",
      "current": { "version": "4.18.2", "publishedAt": "2024-03-25" },
      "latestMinor": { "version": "4.21.0", "publishedAt": "2024-09-15" },
      "latestMajor": { "version": "5.0.1", "publishedAt": "2024-11-01" },
      "ageInDays": 245,
      "updateType": "major"
    }
  ]
}
```

### Markdown

```bash
dependency-guard --format markdown
```

Generates a markdown table suitable for documentation or GitHub issues.

## Exit Codes

| Code | Description |
|------|-------------|
| `0` | Success |
| `1` | Error (file not found, network error, etc.) |

## Caching

Registry responses are cached in `~/.cache/dependency-guard/` with a 60-minute TTL. Use `--no-cache` to bypass the cache.

## Requirements

- Node.js 24.0.0 or higher
