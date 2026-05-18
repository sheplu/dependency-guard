# Future feature: `--diff` against a baseline

## Why

The current report answers "what is the state of my deps right now?" — useful, but a CI gate built on absolute state ("any major upgrade fails") forces you to either keep up with every release or carry permanent allowlists.

A diff-based gate answers a more interesting question: **"what changed since last time?"** Two scenarios this unlocks:

1. **CI gate on regressions** — fail if a previously-clean dep just gained a major upgrade, or if a transitive that wasn't there yesterday is already 2 years old. Catches "your install drifted" without requiring you to be at the absolute latest.
2. **Audit trail** — "since our last security review, which deps moved? Which got new majors? Which got deprecated?" Cheap, low-noise way to drive a periodic dependency-hygiene review.

## Sketch of the work

The hardest part is design, not implementation. The actual code is small once the shape is settled.

### CLI shape

Two flags, working as a pair:

```
--snapshot <path>      Write the current report to <path> (no diff, exit 0)
--diff <path>          Compare current report against <path>; exit 2 if regressions
```

Or a single `--baseline <path>` flag that writes when the file doesn't exist and diffs when it does (cleaner UX, but trickier to test edge cases). My instinct: separate flags are clearer.

### Snapshot format

Reuse the existing JSON output as the snapshot format. It's already stable, parseable, and includes everything (`updateType`, `deprecated`, `transitive`, `ageInDays`, etc.). No new schema needed; the snapshot file is just a saved `--format json` run.

### Diff semantics

For each package present in either snapshot, classify:

- **Added** — in current, not in baseline (typically a new direct dep or a new transitive).
- **Removed** — in baseline, not in current.
- **Status changed** — `updateType` or `deprecated` differs.
- **Version changed** — `current.version` differs.
- **Drifted-stale** — `ageInDays` jumped by more than N days (indicates the upstream package has stopped releasing).

Emit a structured diff section in the report (table mode) and a `diff: { added, removed, changed }` block in JSON mode.

### Gate behavior

A `--fail-on-regression` flag (or `--fail-on regression` extending the existing enum) fails when any of these are true:

- A package was up-to-date in baseline but isn't anymore.
- A new deprecation appeared.
- A previously-not-present transitive entered the graph at major-upgrade-needed.

Pass-by-default for "moved forward" changes (e.g., baseline at v1, current at v2 with no pending major).

## Open design questions

- **Snapshot pinning** — when do you regenerate the baseline? On every successful CI? Only on releases? Probably the user's choice — we just provide the flag, they wire it into their workflow.
- **Granularity** — diff at the package level (today's sketch) or at the version level (track every version transition)? Package-level is enough for a CI gate. Version-level might be useful for the audit-trail use case but adds a lot of noise.
- **What about deletions?** A package removed from `package.json` between runs — emit it under `removed`, but is that ever a fail condition? Probably not; treat as informational.
- **Skipped/ignored deps** — do they appear in the diff? Argument either way: yes (visibility) or no (the user explicitly told us to ignore them).
- **Transitive-graph diffs** — the most powerful but most complex. With `--include-transitive`, baseline and current may have wildly different transitive sets just because of unrelated upstream changes. Probably needs its own `--diff-transitives` toggle; the basic diff stays direct-only.

## Reuse from existing modules

- Snapshot writing: `src/format/json.ts` already produces the right shape.
- Snapshot reading: trivial; just `JSON.parse(readFile(path))` plus a version/shape check (`{ summary, dependencies, skipped }`).
- Comparison: pure-function module `src/diff.ts` taking two `AnalysisReport` objects, returning a `DiffResult`. Mirrors `src/policy.ts` in structure.
- CLI plumbing: same pattern as `--cache-clear` (short-circuit when `--snapshot` is set; bypass policy check) and `--fail-on` (extend the policy enum).

## Tests we'd need

- Unit: `diff()` with paired report fixtures covering each diff category.
- Unit: snapshot round-trip (write → parse → diff against itself produces empty diff).
- Integration: `--snapshot` writes the file, exits 0, doesn't pollute stdout in a way that breaks json piping.
- Integration: `--diff` against a fixture, exit codes, stdout/stderr shape.

## Out of scope (intentionally)

- Storing snapshots in git, S3, or anywhere remote. The file path is the user's responsibility.
- A "history" mode (diff against multiple baselines). Single-baseline is enough; users can chain `--diff` calls if they want trends.
- Visual diff rendering (HTML, GitHub-action annotations). The structured JSON output is enough for downstream tools to render however they want.

## When to pick this up

After we have real users running dependency-guard in CI. The gate behavior decisions (what counts as a regression?) are best made with concrete examples in hand, not designed in a vacuum.
