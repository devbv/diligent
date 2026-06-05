---
id: P067
status: backlog
created: 2026-05-28
---

# P067: overdare-ai-agent dev/prod env split with optional version pinning

## Goal

Split overdare-ai-agent builds and GitHub Releases into two environments — `prod` and `dev` — and let the agent select which one to download via a single `--agent-env` argument. The same argument also supports pinning a specific version with `env@version` syntax so any release (latest or a named one) can be installed deterministically.

End state:

- `overdare-ai-agent --agent-env=prod` (or no arg) downloads the latest **prod** release
- `overdare-ai-agent --agent-env=dev` downloads the latest **dev** release
- `overdare-ai-agent --agent-env=prod@1.2.3` downloads exactly **prod v1.2.3**
- `overdare-ai-agent --agent-env=dev@1.4.0-beta.2` downloads exactly **dev v1.4.0-beta.2**
- prod and dev installs are isolated on disk: prod under `~/.overdare/`, dev under `~/.overdare-dev/` (independent runtime, plugins, config, logs)
- GitHub Release tags carry an env prefix: `prod-v1.2.3` / `dev-v1.2.3`; dev releases are marked `prerelease=true`
- All release artifacts encode the env in their filename so the two channels never cross-contaminate

## Decisions

| Topic | Decision |
|---|---|
| User-facing flag name | `--agent-env` (not `--channel`) |
| Default env when arg omitted | `prod` |
| Env values | `prod`, `dev` (closed set; unknown values fail fast) |
| Version pin syntax | `--agent-env=<env>@<version>`, atomic single flag |
| Tag scheme | `prod-v<semver>`, `dev-v<semver>` |
| GitHub Release pre-release flag | `true` for dev, `false` for prod |
| Storage isolation | `~/.overdare` (prod) vs `~/.overdare-dev` (dev) — both download/state fully separated |
| Binary shape | Single `overdare-ai-agent` binary; env is a runtime arg |
| Manifest schema addition | Add `"env"` field; agent rejects manifest where `env` does not match the requested env |
| Pin persistence | None. CLI is the source of truth each invocation; pinning is stateless |
| Auto-update when pinned | Pinned version disables drift — agent only ensures the installed version equals the pinned version (no comparison against "latest") |

## Argument grammar

```
--agent-env=<env>[@<version>]
```

- `<env>` ∈ `{prod, dev}`
- `<version>` is a SemVer string matching the release tag suffix (without the leading `v`)
- Parsing rules:
  - `--agent-env=prod` → env=prod, version=latest
  - `--agent-env=dev@1.4.0` → env=dev, version=1.4.0 (pinned)
  - `--agent-env=prod@` → invalid (empty version)
  - `--agent-env=staging` → invalid (unknown env)

Equivalent inputs (lower priority than the CLI flag, same grammar):

1. CLI flag: `--agent-env=<env>[@<version>]`
2. Env var: `DILIGENT_ENV=<env>[@<version>]`
3. Compile-time: `option_env!("DILIGENT_ENV")` (so a packaged build can ship with a baked-in default)
4. Fallback default: `prod`

Escape hatch (already exists, kept as-is): `DILIGENT_UPDATE_URL` env fully overrides the manifest URL for diagnostics / local mirroring. When set, env+version resolution is skipped, but manifest `env` validation still runs and must match the resolved env.

## Release artifact naming

| Artifact | Filename pattern |
|---|---|
| Runtime bundle | `overdare-ai-agent-runtime-{env}-{version}-{platform}.zip` |
| Agent launcher (Windows) | `overdare-ai-agent-{env}-{version}-{platform}.exe` |
| Update manifest | `update-manifest-{env}.json` |
| Release metadata | `release-meta-{env}.json` |
| Checksums | `checksums-{env}.sha256` |

Each GitHub Release contains only one env's artifacts. Cross-env contamination within a release is structurally impossible.

## Manifest URL resolution

Given resolved env and optional pinned version:

| Input | Manifest URL |
|---|---|
| `prod` (latest) | `https://github.com/overdare/diligent/releases/latest/download/update-manifest-prod.json` |
| `dev` (latest) | `https://github.com/overdare/diligent/releases/download/dev-latest/update-manifest-dev.json` |
| `prod@<v>` | `https://github.com/overdare/diligent/releases/download/prod-v<v>/update-manifest-prod.json` |
| `dev@<v>` | `https://github.com/overdare/diligent/releases/download/dev-v<v>/update-manifest-dev.json` |

Notes:

- GitHub's `releases/latest` redirect skips releases marked `prerelease=true`, so the prod "latest" URL is never accidentally served a dev build.
- `dev-latest` is a **rolling release** maintained by the release workflow: on every dev publish, the workflow deletes the old `dev-latest` release/tag and re-creates it pointing at the same artifacts as the new `dev-v<version>` release. The bundle URL inside the manifest still points at the immutable `dev-v<version>` tag, so concurrent agents either get the old or new immutable bundle — never a half-replaced one.
- Pinned URLs use the immutable release tag directly, so they bypass the rolling-pointer logic entirely.

## Manifest schema change

```jsonc
{
  "version": "1.2.3",
  "env": "dev",              // NEW — must match the requesting agent's env
  "releaseDate": "2026-05-28T...",
  "platforms": {
    "windows-x64": { "url": "...", "sha256": "...", "size": 12345 }
  }
}
```

- Backwards-compatible: `env` is `Option<String>` in the Rust struct. Missing field = legacy release; agent treats `None` as "matches whatever requested" only for the prod channel during the migration window.
- After the migration window, missing `env` becomes a hard error to prevent silent regressions.

## Update flow

When pinned:
1. Resolve env + pinned version from CLI/env/compile-time
2. Fetch `update-manifest-{env}.json` from the per-tag URL
3. Verify `manifest.env == requested_env`
4. Verify `manifest.version == requested_version`
5. If installed version already equals pinned version AND sha256 matches, no-op
6. Otherwise download → sha256 verify → extract → swap → write `version.json`
7. **Skip** any "newer version available" check (pinning means pinning)

When not pinned (latest):
1. Resolve env from CLI/env/compile-time
2. Fetch `update-manifest-{env}.json` from the latest URL (`releases/latest/...` for prod, `dev-latest` for dev)
3. Verify `manifest.env == requested_env`
4. Compare `manifest.version` to installed `version.json` → download if different (existing logic)

In both flows, `~/.{namespace}/updates/runtime/version.json` is updated with the installed version. A sibling `env.json` records the env (and pinned-version, if any) used for the install so subsequent runs can warn on env mismatch.

## Storage layout

| Env | Global storage root |
|---|---|
| prod | `~/.overdare/` |
| dev | `~/.overdare-dev/` |

The agent passes `DILIGENT_STORAGE_NAMESPACE=overdare` (prod) or `DILIGENT_STORAGE_NAMESPACE=overdare-dev` (dev) to the runtime child process, so the runtime's namespace-aware path helpers (P060) automatically place per-env config/plugins/sessions/logs under the right root. Project-local storage (`<cwd>/.overdare`, `<cwd>/.overdare-dev`) follows the same rule.

Both envs can coexist on one machine. Switching envs in one terminal session does not corrupt the other env's state because they share no files.

## Per-env environment isolation (`DILIGENT_ENV`)

In addition to splitting storage and download paths, the agent forwards `DILIGENT_ENV=prod|dev` to the runtime child process so downstream code can react to the release channel.

After surveying actual hardcoded backing-service URLs in the runtime and plugins, we deliberately narrowed PR3's scope:

- The analytics destination (`bubo`) is **data-plane**: it should follow the hub the user is connected to (`HUB_DOMAIN`), not the agent binary's release channel. A prod-channel agent connected to a QA hub must still report to the QA analytics ingest. The existing `HUB_DOMAIN`-based routing in `plugin-analytics` is kept as-is.
- The RAG search endpoint (`aiguide.overdare.com`) is a single deployment-agnostic service; there is no dev RAG to route to.
- Hub domain defaults are intentionally explicit (`--hub-domain` CLI arg); no env-derived default is desirable.

That leaves no concrete backing service that the runtime should re-route based on `DILIGENT_ENV` today.

End state for the runtime in this plan:

- `packages/plugin-sdk` exposes a single `currentEnv()` helper that reads `DILIGENT_ENV` and returns `"prod"` / `"dev"`, defaulting to `"prod"` when the variable is missing (legacy launcher) or unrecognized. This is the plumbing that future env-conditional behavior should key off of.
- No existing call site is migrated in PR3. The helper is purely available for future use — e.g. dev-only diagnostics, pre-release telemetry flags, or future feature gates that genuinely scale with the build channel.

A bundled `env-config.json` file and `getEnvConfig()` loader were considered and dropped: with no current consumer, the JSON file would carry only placeholder values and the loader would add disk I/O on every plugin boot for no benefit. If a real env-keyed config dataset emerges later, the helper can grow into one.

What is **not** in scope for P067: actually provisioning a separate dev analytics ingestion endpoint, or building the env-config.json + loader pair. Those become operational work tracked separately and can plug into `currentEnv()` when their values are real.

## Scope

### What changes

| Area | What changes |
|---|---|
| `apps/overdare-ai-agent/src/cli.rs` | Add `--agent-env=<env>[@<version>]` parsing; route resolved `EnvSelection` into `init` / `start` |
| `apps/overdare-ai-agent/src/update.rs` | Introduce `EnvSelection { env: Env, pinned_version: Option<String> }`; env-aware manifest URL resolver; pinned-mode update path; manifest `env` validation |
| `apps/overdare-ai-agent/src/storage.rs` | `storage_namespace(env)` returns `"overdare"` for prod, `"overdare-dev"` for dev; `option_env!("DILIGENT_STORAGE_NAMESPACE")` override retained for non-env special builds |
| `apps/overdare-ai-agent/src/webserver.rs` | Carry env through `WebServerOptions`; forward `DILIGENT_STORAGE_NAMESPACE` and `DILIGENT_ENV` to child runtime |
| `apps/overdare-ai-agent/src/init.rs` | Use env-aware global storage dir for bootstrap deployment |
| `packages/plugin-sdk/src/env.ts` (NEW) | `currentEnv()` helper that reads `DILIGENT_ENV`, defaults to `prod` when missing or unrecognized |
| `packages/plugin-sdk/src/index.ts` | Re-export `currentEnv` and the `Env` type for plugin consumers |
| `packages/plugin-sdk/test/env.test.ts` (NEW) | Cover default-prod, dev, trimming, case, unrecognized, empty/whitespace inputs |
| ~~`apps/overdare-ai-agent/bootstrap/env-config.json`~~ | Dropped from PR3 — no concrete consumer; revisit when a real env-keyed dataset appears |
| ~~Runtime call sites that currently hard-code service URLs~~ | Not migrated. Analytics intentionally follows `HUB_DOMAIN` (data plane); RAG has no dev endpoint |
| `scripts/build-overdare-runtime-bundle.ts` | New required arg `--agent-env=<env>`; output filename uses env-prefixed pattern; bundle content unchanged across envs |
| `.github/workflows/release.yml` | Add `inputs.env: { type: choice, options: [prod, dev] }`; build with env-prefixed filenames; tag as `{env}-v{version}`; `--prerelease` for dev; rolling `dev-latest` release maintenance; legacy alias upload for prod migration window |
| `apps/overdare-ai-agent/README.md` | Document `--agent-env`, pinning syntax, storage paths, dev/prod coexistence |
| `docs/guide/packaging.md` | Document the env-prefixed release artifact contract and rolling `dev-latest` semantics |
| `ARCHITECTURE.md` | Brief mention of dual-env release model in the overdare-ai-agent section |

### What does NOT change

- Linux/macOS CLI (`packages/cli`) release flow; this plan only changes the OVERDARE CLI flow built around `apps/overdare-ai-agent`
- Storage namespace abstraction itself (P060) — env splitting is a thin layer on top
- Runtime project-local storage layout under `<cwd>/.<namespace>/`
- Internal Rust module names, TypeScript symbols, or binary protocol names
- Bun-target / Rust-target matrix; envs share the same compilation targets
- Plugin contract or bootstrap layout
- Provisioning of an actual separate dev analytics ingestion endpoint (operational, out of scope)

## File Manifest

### apps/overdare-ai-agent/src/

| File | Action | Description |
|---|---|---|
| `cli.rs` | MODIFY | Parse `--agent-env=<env>[@<version>]` once at the top of `run()`; thread resolved selection into all subcommands; update `print_help` |
| `update.rs` | MODIFY | Add `Env`, `EnvSelection`; replace `resolve_manifest_url()` with env+pin-aware variant; add pinned-mode short-circuit in `run_with_progress`; validate `manifest.env`; write `env.json` alongside `version.json` |
| `storage.rs` | MODIFY | Take `Env` in `storage_namespace`; derive `~/.overdare-dev` for dev; keep `option_env!` override for special builds |
| `webserver.rs` | MODIFY | Plumb `env` through `WebServerOptions`; export `DILIGENT_ENV` and env-correct `DILIGENT_STORAGE_NAMESPACE` to child |
| `init.rs` | MODIFY | Accept env to locate the correct global storage root for bootstrap deployment |

### scripts/

| File | Action | Description |
|---|---|---|
| `build-overdare-runtime-bundle.ts` | MODIFY | Require `--agent-env`; encode env into output filename |
| `build-overdare-sidecar.ts` | NO CHANGE | Sidecar binary is env-agnostic; env is supplied via runtime env vars |

### packages/runtime/

| File | Action | Description |
|---|---|---|
| `src/config/env.ts` | NEW | Load `bootstrap/env-config.json`; `getEnvConfig(env)`; `currentEnv()` reads `DILIGENT_ENV`, defaults to `prod` |
| Existing call sites with hard-coded analytics/hub URLs | MODIFY | Switch to `getEnvConfig(currentEnv()).<field>` |
| `test/**` | ADD | Unit test that env-config resolves correctly for prod/dev, defaults to prod when unset |

### apps/overdare-ai-agent/

| File | Action | Description |
|---|---|---|
| `bootstrap/env-config.json` | NEW | Source-of-truth map of env → backing service identifiers |
| `README.md` | MODIFY | Document `--agent-env`, pinning, storage paths, dev/prod coexistence |

### .github/workflows/

| File | Action | Description |
|---|---|---|
| `release.yml` | MODIFY | Env input; env-prefixed filenames; `{env}-v{version}` tag; conditional `--prerelease`; `dev-latest` rolling release maintenance; prod legacy alias artifact upload during migration |

### docs/

| File | Action | Description |
|---|---|---|
| `guide/packaging.md` | MODIFY | Document env-prefixed artifact contract and rolling `dev-latest` semantics |
| `plan/decisions.md` | MAYBE ADD | Decision entry capturing the env-split contract if worth preserving |

### apps/overdare-ai-agent/test/ (Rust)

| File | Action | Description |
|---|---|---|
| `env_parse.rs` | NEW | `--agent-env=prod`, `--agent-env=dev`, `--agent-env=prod@1.2.3`, malformed inputs, env var precedence, compile-time fallback |
| `manifest_url.rs` | NEW | URL composition matrix for latest/pinned × prod/dev |
| `storage_namespace.rs` | NEW | `storage_namespace(Env::Prod)` == `"overdare"`, `(Env::Dev)` == `"overdare-dev"`, override behavior |
| `manifest_env_validation.rs` | NEW | Manifest with mismatching `env` rejected; missing `env` permitted only in compatibility mode |

## Migration / compatibility

1. **Existing prod agents** point at `releases/latest/download/update-manifest.json` (no env suffix). For one to two release cycles the prod release workflow uploads alias files `update-manifest.json`, `release-meta.json`, `checksums.sha256` as copies of the env-suffixed files. Old agents see no break; new agents prefer the env-suffixed file.
2. **Storage**: prod keeps `~/.overdare/`. Dev gets a brand-new `~/.overdare-dev/`. No data migration needed; no risk of corrupting prod state.
3. **Manifest `env` field**: introduced as optional. After the alias-upload window, the agent treats missing `env` as a hard error so we cannot silently regress.
4. **Cleanup PR** (post-stabilization): remove legacy alias uploads from the workflow and tighten the agent to require `env` in every manifest.

## Risks

- **`dev-latest` mismarked as `prerelease=false`** would surface dev to the prod `latest` URL. Mitigation: workflow includes a verification step (`gh release view dev-latest --json isPrerelease` checked to be `true`) before completing.
- **`DILIGENT_UPDATE_URL` override** can silently point either env at the wrong artifact. The manifest `env` validation catches this on the agent side; we document the override clearly in README.
- **Dev release proliferation** — every push will accumulate. Out of scope here, but worth a follow-up retention job (keep N most recent dev releases).
- **Pinned version typo** — `--agent-env=prod@1.2.4` for a non-existent tag → agent gets a 404 on manifest. Mitigation: agent surfaces "version 1.2.4 not found for prod" with the constructed URL, not a raw HTTP error.

## Implementation order (PR breakdown)

### PR1 — agent: env + pinning, behavior preserved for default

- `Env`, `EnvSelection`, CLI parsing, manifest URL resolver, manifest `env` validation
- Storage namespace becomes env-aware
- `webserver` forwards `DILIGENT_ENV` and correct `DILIGENT_STORAGE_NAMESPACE`
- Default `prod` keeps existing behavior (still fetches legacy alias URL via compile-time default to ease transition)
- All new Rust unit tests

### PR2 — build/release: env split

- `build-overdare-runtime-bundle.ts --agent-env`
- `release.yml`: env input, env-prefixed filenames, `{env}-v{version}` tag, conditional `--prerelease`, `dev-latest` rolling release
- Prod releases also upload legacy alias filenames during migration window
- Verify-prerelease guard step

### PR3 — runtime: minimal env helper

- `packages/plugin-sdk/src/env.ts` with `currentEnv()` only
- Re-export from plugin-sdk's `index.ts`
- Default-to-prod fallback when `DILIGENT_ENV` missing or unrecognized
- Plugin-sdk unit tests
- **Intentionally** does not migrate any call site. Bubo analytics stays `HUB_DOMAIN`-driven (data plane), RAG stays single-URL. Future env-keyed values plug into `currentEnv()` when they exist.

### PR4 — cleanup (after one or two release cycles)

- Drop legacy alias uploads from the workflow
- Tighten agent: require `env` in manifests (no more `Option<String>` permissiveness)
- Drop legacy compile-time default URL in favor of env-resolved default

## Verification

- **Unit (Rust)**: `cargo test --manifest-path apps/overdare-ai-agent/Cargo.toml` covers env parsing, manifest URL composition, namespace derivation, manifest validation.
- **Unit (TS)**: `bun test packages/runtime/` covers env-config resolution and the `DILIGENT_ENV` default.
- **Integration (manual)**:
  - On one workstation: `overdare-ai-agent --agent-env=prod init` then `overdare-ai-agent --agent-env=dev init` — confirm `~/.overdare/` and `~/.overdare-dev/` populated independently, no cross-writes.
  - `overdare-ai-agent --agent-env=prod@1.2.3 init` while a newer prod release exists — confirm 1.2.3 installed, no drift to latest.
  - Trigger the workflow with `env=dev` — confirm `dev-v<version>` and `dev-latest` releases both created, both `prerelease=true`, prod `latest` URL still serves the previous prod release.
  - Old prod agent build (pre-P067) against post-P067 prod release — confirm successful update via legacy alias URL.

## Out of scope

- Provisioning a real dev analytics ingestion endpoint or dev hub domain (operational follow-up)
- Retention/cleanup of accumulating dev releases (separate housekeeping plan)
- Self-update of the `overdare-ai-agent` binary itself (currently agent only updates the runtime bundle; binary updates remain manual)
- Channel switching that preserves shared state (intentional: envs are isolated)
- Per-env signing keys / hardened distribution (current trust model is unchanged)
