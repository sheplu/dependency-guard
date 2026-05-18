# Future feature: Python ecosystem port (Rust implementation)

## Why this doc exists

The npm-flavored dependency-guard fills a real niche: lockfile-aware staleness reporting + multi-gate CI behavior, in a single zero-dep binary. The Python ecosystem has the **same gap** but is more fragmented (pip / Poetry / PDM / uv all coexist, none have an equivalent CI-gate audit tool). uv ships writeback (`uv lock --upgrade`) but no staleness/deprecation gate.

This doc captures everything needed to port the project to Python — **implemented in Rust** so it ships as a single binary alongside uv/ruff and matches the modern Python tooling ethos. Treat this as a brief for "future-you starting from scratch on a Saturday," not as a finished design.

## Why Rust, not Python

- **Distribution**: a single static binary you `cargo install` or `pipx run` (via maturin-built wheels). No `venv` activation, no Python version constraints, fast cold-start.
- **Audience signal**: the Astral toolchain (uv, ruff, pyright-nightly) has trained PyPA-adjacent users to expect Rust-implemented tooling. A Python tool here would feel slower and less polished.
- **Concurrency**: PyPI metadata fetches benefit from parallelism. Rust's async story is mature; Python's `asyncio` works but adds runtime weight.
- **Lockfile parsing**: `Cargo.toml` + `serde_yaml` (or hand-rolled, mirroring our line walkers) handle every Python lockfile we'd target with less code than the Python equivalents.

The cost: a smaller pool of contributors compared to a Python implementation. Acceptable for a tool with a narrow scope.

## What to port directly (concept-level)

These translate cleanly because the npm and PyPI worlds have analogous shapes:

| dependency-guard concept | Python equivalent |
|---|---|
| `package.json` direct deps | `pyproject.toml` `[project.dependencies]` / `[project.optional-dependencies]` / Poetry's `[tool.poetry.dependencies]` / PDM's equivalent |
| `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` | `uv.lock` / `poetry.lock` / `Pipfile.lock` / `requirements.txt` (compiled) |
| npm registry `time` field | PyPI JSON API `releases[<v>].upload_time_iso_8601` |
| `deprecated` per-version | PyPI yanked-version status (PEP 592) — see below |
| `latestMinor` / `latestMajor` analyzer | Same logic; PEP 440 is more permissive than SemVer 2.0 but the distinction (minor vs major) carries over |
| `--fail-on <level>` | Direct port |
| `--max-age <days>` | Direct port |
| `--update <minor\|major>` (writeback) | Skip in v1 — uv/poetry already own this |
| `--include-transitive` | More important in Python; lockfile coverage is the main value-add |
| `--ignore-scope` | Map to Python's namespace packages or PEP 503 normalized prefixes; less common but exists |

## What's different in Python (and matters)

### 1. Multiple coexisting lockfile formats

uv is the future, but dropping support for Poetry/pip would slash adoption. Plan for at least four formats from day one:

- **`uv.lock`** (TOML; lockfile spec is stable) — top-level `[[package]]` arrays with `name`, `version`, `dependencies`. Cleanest format to parse.
- **`poetry.lock`** (TOML) — similar shape; `[[package]]` blocks with `name`, `version`, `dependencies` (sub-table). Mature.
- **`Pipfile.lock`** (JSON) — pipenv. Less common now but still seen.
- **`requirements.txt`** (compiled, e.g. by `pip-compile`) — line-based `name==version`. No transitive structure beyond top-level pins.

Priority order if multiple coexist (mirroring our npm > pnpm > yarn rule): **`uv.lock` > `poetry.lock` > `Pipfile.lock` > `requirements.txt`**. Same warning shape as today.

In Rust this is a clean `LockGraph` trait (mirroring our `LockGraph` interface):

```rust
trait LockGraph {
    fn resolve(&self, name: &str) -> Option<LockNode>;
}

struct LockNode {
    version: String,
    child_names: Vec<String>,
}
```

One `impl` per format. Loader chain returns the first successful one.

### 2. Yanked versions (PEP 592) — the killer feature

PyPI's JSON metadata exposes `releases[<v>][i].yanked: bool` and `yanked_reason: string | null`. A yanked version is **stronger signal than npm's `deprecated`** — it almost always means "use anything but this." Surface it the same way we surface deprecation: inline `⚠` marker, JSON field, and a `--fail-on yanked` level.

Most Python staleness tools don't surface this well. It would be the strongest differentiator.

### 3. PEP 440 vs SemVer 2.0

Python versions aren't strictly SemVer. Differences worth knowing:

- **Pre-releases**: `1.0.0a1`, `1.0.0b2`, `1.0.0rc1` (PEP 440) vs `1.0.0-alpha.1` / `1.0.0-rc.1` (SemVer).
- **Post-releases**: `1.0.0.post1` — no SemVer equivalent.
- **Dev releases**: `1.0.0.dev1`.
- **Local versions**: `1.0.0+local.1` — similar to SemVer build metadata.
- **Epoch**: `1!1.0.0` — explicit version-scheme reset, very rare.

Use the existing `pep440-rs` crate (Astral maintains it; same crate uv uses internally). Don't hand-roll the parser — PEP 440 is stricter than SemVer about subtle things and you'll regret it.

For "minor vs major" classification, the rule should be: same epoch + same major component → minor upgrade; different major → major upgrade. Pre-releases excluded by default when picking "latest."

### 4. Namespace packages and extras

PyPI has no scopes (no `@org/pkg`). Instead:
- **Extras**: `requests[security]` — install with optional sub-dep set. Surface the base name only; ignore extras for staleness reasons.
- **Distribution name vs import name**: `Pillow` (dist) vs `PIL` (import). Always use distribution name.
- **PEP 503 normalization**: `My_Package` and `my-package` are the same dep on PyPI. Normalize to lowercase + dashes when deduping.

### 5. Environment markers

A dep can be conditional: `numpy>=1.20; python_version >= "3.10"`. uv.lock and poetry.lock track these. For our purposes, **ignore markers**: report the latest version regardless of which environments it would install in. Adding marker awareness is a deep rabbit hole; defer indefinitely.

### 6. Workspaces / monorepos

uv has first-class workspace support. Our `--path` flag pointing at one `pyproject.toml` works fine for a single workspace member; whole-workspace mode would be a future feature, mirroring how `cargo` handles it.

## Suggested project shape

```
dep-audit/                          # crate name TBD; "dep-audit" / "pydrift" / "outpath" candidates
  Cargo.toml
  src/
    main.rs                         # CLI entry, mirrors our index.ts shape
    cli.rs                          # clap-based arg parsing
    analyze.rs                      # orchestrator: parse pyproject → resolve lockfile → fetch → analyze
    pypi.rs                         # PyPI JSON API client (reqwest + tokio)
    cache.rs                        # disk cache, TTL-based
    lockfile/
      mod.rs                        # LockGraph trait
      uv.rs                         # uv.lock (TOML)
      poetry.rs                     # poetry.lock (TOML)
      pipfile.rs                    # Pipfile.lock (JSON)
      requirements.rs               # requirements.txt (line-based)
    pyproject.rs                    # pyproject.toml direct-deps reader (PEP 621 + Poetry)
    analyzer.rs                     # picks latestMinor / latestMajor; pep440-rs comparisons
    policy.rs                       # --fail-on / --max-age gating
    format/
      table.rs
      json.rs
      markdown.rs
  tests/
    unit/                           # one per module
    integration/                    # tokio + spawning the binary against a mock PyPI
```

## Concrete crate choices

| Need | Crate | Notes |
|------|-------|-------|
| HTTP | `reqwest` | Async; rustls-tls feature for static linking |
| Async runtime | `tokio` | Standard choice; multi-threaded scheduler |
| TOML parsing | `toml` (or `toml_edit` if writeback later) | uv.lock/poetry.lock/pyproject |
| YAML parsing | None needed for v1 (Python lockfiles aren't YAML) | If we add pnpm-style support later: `serde_yaml` |
| JSON parsing | `serde_json` | Pipfile.lock, PyPI responses |
| Version parsing | `pep440-rs` | Astral's crate; the canonical choice |
| CLI args | `clap` v4 | Mature; mirrors our `--fail-on` enum cleanly with derive macros |
| Terminal colors | `anstyle` (std-friendly) or `owo-colors` | TTY-detection built in |
| Tables | `comfy-table` | If we want pretty rendering; could also hand-roll like we did |

## CLI surface (proposed v1)

Mirror dependency-guard exactly where it makes sense:

```
dep-audit [OPTIONS]

  -p, --path <PATH>            Path to pyproject.toml (default: ./pyproject.toml)
  -f, --format <FORMAT>        table | json | markdown (default: table)
      --prod                   Only check [project.dependencies]
      --dev                    Only check dev/test optional-dependency groups
      --include-transitive     Walk lockfile (uv.lock | poetry.lock | Pipfile.lock | requirements.txt)
      --fail-on <LEVEL>        major | minor | any | yanked | deprecated
      --max-age <DAYS>         Exit 2 if any installed version is older than N days
      --sort <FIELD>           age | status | name
      --only <NAMES>           Comma-separated or repeatable
      --ignore <NAMES>         Replaces --ignore-scope; PyPI has no scopes
      --quiet                  Drop summary block
      --no-cache               Skip the registry cache
      --cache-clear            Wipe cache and exit
      --cache-ttl <MIN>        Default 60
      --registry <URL>         Default https://pypi.org/pypi (env: PYPI_REGISTRY_URL)
      --dry-run                Reserved (writeback intentionally deferred)
  -h, --help
  -V, --version
```

**Differences from dependency-guard**:
- `--ignore-scope` becomes `--ignore <name>` (PyPI has no scope concept).
- `--fail-on yanked` is a new level — doesn't exist in npm.
- `--update` deliberately not in v1 (uv owns this).

## Output shape

Same JSON contract as dependency-guard, with three additions to `DependencyAnalysis`:

```jsonc
{
  "name": "requests",
  "type": "dependencies",
  "current": { "version": "2.31.0", "publishedAt": "..." },
  "latestMinor": { "version": "2.32.0", "publishedAt": "..." },
  "latestMajor": null,
  "ageInDays": 250,
  "latestAgeInDays": 100,
  "updateType": "minor",
  "deprecated": null,
  "yanked": null,                 // NEW: { reason: string } | null
  "transitive": false,
  "extras": ["security"],         // NEW: optional, surfaces requested extras
  "pythonRequires": ">=3.8"       // NEW: from PyPI metadata; informational
}
```

## Verification milestones

1. **Walking skeleton**: read `pyproject.toml`, fetch one package's metadata from PyPI, render it as JSON. End-to-end in ~200 LOC.
2. **uv.lock walker**: `--include-transitive` against an uv project. Validates the LockGraph trait.
3. **Yanked-version surfacing**: `⚠` marker in table; `yanked: { reason }` in JSON; `--fail-on yanked` exits 2.
4. **All four lockfile formats** covered.
5. **Same coverage discipline as the original**: `cargo test`, threshold-gated coverage via `cargo-llvm-cov` or `cargo-tarpaulin`.

## Things to NOT port (intentionally)

- **`--update` writeback**. uv (`uv lock --upgrade-package`) and Poetry (`poetry update`) own this well. Trying to write to `pyproject.toml` correctly across all four package managers is a tar pit; let the respective package manager handle it.
- **`--registry-token` / `.npmrc`-equivalent (.pypirc reading)**. Most users hit private registries through index URLs configured in pip/uv config; we'd parse `pip.conf` + `uv.toml` to be thorough. Defer; ship `--registry` as a single override.
- **Vulnerability advisories from OSV/GHSA**. `pip-audit` does this well. Don't duplicate; recommend it in the README.

## Naming

Strong contenders:
- `pyfreshness` — descriptive, slightly cute
- `dep-audit` — generic but clear (potential conflict with existing tools)
- `pyoutdated` — matches `cargo outdated`'s framing
- `pydrift` — emphasizes the "your deps drifted from pristine" framing
- `staletoml` — leans into the lockfile angle

I'd lean **`pydrift`** — it captures what the tool actually surfaces (drift since install / since release) and isn't already taken on crates.io or PyPI as of this writing. Verify before committing.

## Estimated effort

Rough breakdown for a v1 that matches dependency-guard's feature set minus writeback:

- Project scaffolding + CI: 0.5 day
- PyPI client + cache: 1 day
- pyproject + uv.lock readers: 1 day
- Analyzer (pep440-rs integration): 1 day
- poetry.lock + Pipfile.lock + requirements.txt: 1 day
- CLI args + formatters: 1 day
- Policy gates + yanked detection: 1 day
- Test suite (mirror existing coverage discipline): 2 days
- README + crates.io + GitHub release plumbing: 0.5 day

**~9 days of focused work** for v1. The lockfile parsers are the bulk; everything else is mostly translation from the TypeScript code in this repo.

## Reference points to keep open

- `cargo outdated`'s source: https://github.com/kbknapp/cargo-outdated
- uv's lockfile spec: https://docs.astral.sh/uv/concepts/projects/sync/
- `pep440-rs`: https://crates.io/crates/pep440-rs
- PyPI JSON API: https://warehouse.pypa.io/api-reference/json.html
- This repo's own `src/` — the algorithmic decisions (sort, dedupe, transitive walk, fail-on semantics, indent preservation) translate one-to-one.

## When to pick this up

When the npm tool has been used in anger by enough users to validate the feature set, AND when there's a specific Python team / project asking for the same gate. Don't build speculatively — Python tooling moves fast, and a year from now uv may have absorbed half this functionality natively.
