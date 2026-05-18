# Future feature: `.npmrc` reading

## Why

Today, dependency-guard has no awareness of `.npmrc` files. Three real-world setups it can't handle:

1. **Authenticated public registries** — packages requiring `_authToken` (private packages on npmjs.org, GitHub Packages with PAT, etc.).
2. **Per-scope registries** — `@mycompany:registry=https://nexus.example.com/...` directing only some packages to a private mirror while the rest go to the public npm.
3. **Project-local default registry** — a `registry=https://...` line in `.npmrc` that overrides our `DEPENDENCY_GUARD_REGISTRY_URL` default.

Workarounds today: `--registry` (single global URL only), `--ignore-scope` (skip private packages entirely instead of authenticating). Neither covers a mixed setup where you want the private packages analyzed.

## Where we left it

When this came up during the `--ignore-scope` work, the deliberate decision was to ship the simpler skip-based approach first and defer authenticated/per-scope routing as a separate feature. The skip flag has now been used in anger; this would be the natural next step when a user reports needing it.

## Sketch of the work

Roughly four pieces, none individually large but they touch the registry/cli boundary carefully:

1. **`.npmrc` parser** — `key = value` line format, with support for:
   - `registry=<url>` (default registry)
   - `@<scope>:registry=<url>` (per-scope override)
   - `//<host>/:_authToken=<token>` (bearer token for that host)
   - `//<host>/:username=<u>` + `//<host>/:_password=<base64>` (basic auth)
   - `${ENV_VAR}` substitution in values
   - Project `.npmrc` (in `<projectDir>/.npmrc`) merged with `~/.npmrc` (project wins on conflicts).
   - Same line format as npm uses; ~80 lines of TS, no runtime deps.

2. **Resolver layer** — given a package name, return `{ url, headers }`:
   - Look up `@<scope>:registry` if scoped.
   - Fall back to default `registry`.
   - For the chosen registry's host, look up the matching `_authToken` / basic auth credentials.
   - Compose the `Authorization` header.

3. **`RegistryClient` extension** — accept a `resolver` callback instead of (or alongside) the static `baseUrl`. The current `getPackage(name)` becomes `resolver(name) → { url, headers }` then `fetch(url, { headers })`. Cache key needs to include the resolved URL since the same package name could legitimately resolve to different URLs across runs.

4. **CLI plumbing** — read project + home `.npmrc` once at startup, build the resolver, pass it to `RegistryClient`. `--registry` flag still works as a hard override (highest priority, no auth attached unless paired with a separate flag).

## Design questions to settle when picking this up

- **Auth flag for `--registry`?** Today the flag is unauthenticated. Pairing it with a `--registry-token` (or reading `NPM_CONFIG_AUTH_TOKEN` from env) would let one-off runs against an authenticated mirror work without writing `.npmrc`.
- **Should `--ignore-scope` and per-scope registries coexist?** Yes — but the precedence matters. Scope-ignored packages should be skipped *before* the resolver runs (cheaper, doesn't reveal package names to authenticated registries unnecessarily).
- **Cache poisoning concerns?** A cache hit currently keys on package name only. With per-scope registries, two runs with different `.npmrc` configs (e.g., laptop with auth vs CI without) would step on each other. Likely fix: include a hash of the resolved URL in the cache filename.

## Tests we'd need

- `.npmrc` parser unit tests: each directive shape, `${ENV}` substitution, comments, project-overrides-home merge.
- Resolver unit tests: scope hits, default fallback, auth header composition.
- Integration: spawn against the mock registry with a fake `.npmrc` providing per-scope routing + a token; assert the request hit the right URL with the right header.

## Out of scope (still)

- npm credential helpers (`_password` keychain stuff, Azure/Google federated auth).
- The `always-auth` flag — most modern registries don't need it.
- npm config command parity (we're not building `npm config`).

## References

- npm CLI's `.npmrc` docs: https://docs.npmjs.com/cli/v10/configuring-npm/npmrc
- The deferred-decision discussion: search this repo's history around the `--ignore-scope` flag introduction.
