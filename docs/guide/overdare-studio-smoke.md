# OVERDARE Studio Windows smoke test

The Windows smoke test lists Studio builds in AWS S3, resolves the newest Windows Release/Shipping archive, launches
Studio in an isolated profile, waits for a loaded project through `level.browse`, starts the packaged agent sidecar,
checks `tools/list`, and calls `studiorpc_level_browse`.

## Build and run

Build the fixed local artifacts:

```powershell
bun install
bun run --cwd packages/web build
bun run overdare-ai-agent:build-sidecar
cargo build --manifest-path apps/overdare-ai-agent/Cargo.toml --release
```

Create the ignored local environment file:

```powershell
$smokeDir = "apps/overdare-ai-agent/test/studio-smoke"
Copy-Item "$smokeDir/.env.example" "$smokeDir/.env.local"
notepad "$smokeDir/.env.local"
```

Set the AWS access key, secret key, and optional STS session token in `.env.local`. The checked-in example already
contains the fixed storage location:

```text
Bucket: ovdr-build-binary
Region: ap-northeast-2
Prefix: Sandbox/Windows/
```

Run the public command:

```powershell
bun run test:studio-smoke
```

## One-time Studio authentication bootstrap

The clean Sandbox has no Studio login state. Capture a credential only from a dedicated automation account:

```powershell
bun run test:studio-auth-bootstrap
```

The command opens Studio in Windows Sandbox. Sign in interactively with the automation account. The bootstrap polls
Windows Credential Manager for Studio's `OverdareLogintoken`, saves its exact credential blob to the ignored
`apps/overdare-ai-agent/test/studio-smoke/.credential.local` file, restricts the file ACL to the current Windows
user, and closes the Sandbox. It never prints the account ID or refresh token.

Subsequent `bun run test:studio-smoke` executions copy that file only into the per-run bridge, import it into the
fresh Sandbox credential store, remove the bridge copy immediately, and delete the imported credential during
cleanup. The local fixture remains outside diagnostics and is not committed because `**/.credential.local` is
ignored. Run the bootstrap again to replace an expired or revoked refresh token.

For GitHub Actions, configure `OVERDARE_STUDIO_CREDENTIAL_B64` as an Environment or repository secret containing
only the second line of `.credential.local`. This command uploads it without echoing it to the terminal:

```powershell
(Get-Content "apps/overdare-ai-agent/test/studio-smoke/.credential.local")[1] |
  gh secret set OVERDARE_STUDIO_CREDENTIAL_B64
```

The workflow reconstructs the credential fixture in the runner's temporary directory. The direct harness imports
it only when `OverdareLogintoken` is absent, removes the temporary fixture, and deletes the Windows credential in
cleanup. GitHub-hosted jobs and Windows Sandbox instances remain disposable; authentication is recreated rather
than preserving a VM profile.

Use `-EnvFile <absolute-path>` on `open-windows-sandbox.ps1` to read a credential file outside the repository.
Process environment variables override values from the file, which is useful for CI and one-off overrides.

The launcher reads only an explicit allowlist from `.env.local`, writes those values to a per-run
`sandbox-env.json` in the temporary Sandbox bridge, and deletes the bridge after the Sandbox exits. The credential
file and bridge configuration are never copied to diagnostic artifacts.

## S3 release selection and integrity

The harness signs AWS S3 requests itself with Signature Version 4, so neither AWS CLI nor MinIO Client is installed
inside the Sandbox. It paginates `ListObjectsV2`, keeps objects under the configured prefix whose names contain
`-release-` and end with `_Sandbox_Shipping.zip`, and selects the newest valid object by `LastModified`.

The archive SHA-256 is always computed and written to `studio-archive.json`. `OVERDARE_STUDIO_SHA256` is optional for
the S3 source; when set, a mismatch fails before extraction. Direct URL mode remains available for debugging and
requires `OVERDARE_STUDIO_URL` plus `OVERDARE_STUDIO_SHA256`.

Local Windows Sandbox runs keep only the validated ZIP in
`%LOCALAPPDATA%\OVERDARE\studio-smoke-cache`. The Sandbox still lists S3 on every run, but it reuses the cache when
the bucket, region, key, modification time, size, and computed SHA-256 all match. A changed or corrupt object is
downloaded again through a partial file and replaces the cache only after validation. CI direct runs do not use
this host cache.

The runner copies Studio's version-matched
`Sandbox/EditorResource/Sandbox/WorldTemplate/Baseplate` into the disposable project directory and launches Studio
with its supported `-OpenMap=<project.umap>` argument. Studio's `OpenMap` path mounts the fixture directory as
`/User/`, loads the map, and enables the MCP service without UI automation. Readiness succeeds only after Studio
returns a non-empty `level.browse` tree.

An unattended Studio build must evaluate `LoadMapAndPIEFromCommandline()` before presenting its login, endpoint, or
home dialog. Release 37.1 parses and preserves `-OpenMap`, but only calls that handler from
`CreateAndShowHomeDialog()`. A clean Sandbox has no login state and can therefore remain on `Untitled` without
reaching the handler. Studio builds used by this smoke test must route all three initial dialog entry points through
the command-line map handler first; otherwise the harness fails explicitly at `project-ready`.

`OVERDARE_STUDIO_ARGS_JSON` contains optional extra Studio launch arguments; an empty array is valid. The available
substitutions are `{projectDir}`, `{projectMap}`, `{rpcPort}`, `{logDir}`, and `{userDataDir}`. The runner owns the
`-OpenMap` argument so local and CI runs use the same project fixture contract.

The runner starts Studio directly on the standard Windows Sandbox and GitHub runner images. It invokes the bundled
Unreal prerequisite installer only when Studio immediately exits with the Windows `STATUS_DLL_NOT_FOUND` loader
code, then retries Studio once. This avoids a slow prerequisite installation and unsupported Windows-feature popup
on every disposable run while retaining a deterministic fallback for a genuinely missing runtime.

The fixed limits are 10 minutes for listing and download, 10 minutes for extraction, 30 seconds for fixture staging,
15 minutes for a prerequisite fallback, 30 seconds for each Studio process start, 3 minutes for project and RPC
readiness, 1 minute for agent readiness, 30 seconds for smoke calls, and 15 seconds for cleanup. The runner uses
Studio's existing RPC default, port `13377`; set
`OVERDARE_STUDIO_RPC_PORT` only when testing a Studio build configured for another port.

## Isolation and diagnostics

The smoke harness receives the S3 credentials only long enough to sign the list and download requests. It removes
the AWS credential variables from its process environment after reading the contract. Studio and the agent receive
a newly constructed environment that does not include AWS credentials.

Studio and the agent receive a new `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, project directory, and
`.overdare` root on every run. Their `PATH` contains only the selected executable directory, Windows `System32`,
and the system Windows PowerShell directory required by packaged Studio tooling. The staged local agent runtime
uses `updateMode: disabled`, so a smoke run cannot replace it with a network-downloaded agent version.

When the missing-runtime fallback is needed, the archive's bundled `UEPrereqSetup_x64.exe` runs with
`/quiet /norestart`. This installs runtime dependencies inside the disposable Sandbox; it does not install Unreal
Editor.

On success the temporary root is deleted. On failure the harness, Studio stdout/stderr, sanitized logs from
`%LOCALAPPDATA%\Sandbox\Saved\Logs`, agent logs, readiness result, selected S3 object metadata, and tool list are
copied to `artifacts/studio-smoke/<run-id>` before cleanup. Authentication arguments, JSON token fields, and JWTs
are redacted from the preserved Studio diagnostics.

## Windows Sandbox

Enable Windows Sandbox once from an elevated PowerShell window:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

Restart Windows if requested. The `test:studio-smoke` command maps the repository read-only, compiles the harness
with the explicitly selected Bun executable, provides one writable temporary bridge for runtime inputs and
diagnostics, and maps the dedicated archive cache. The Sandbox performs the S3 list, conditional download,
extraction, Studio launch, and smoke checks. User data, projects, and extracted binaries are never reused.

Pass `-BunExe <absolute-path>` directly to `open-windows-sandbox.ps1` only when an explicit Bun binary is required.
Use `-StudioCacheDir <absolute-path>` to override the local cache location. Removing that directory safely forces
the next local run to download Studio again.

## GitHub Actions

The workflow uses the fixed bucket, region, and prefix above. Configure repository variables
`OVERDARE_STUDIO_SHA256` (optional), `OVERDARE_STUDIO_EXE_RELATIVE_PATH`, and `OVERDARE_STUDIO_ARGS_JSON`. Configure
`OVERDARE_STUDIO_AWS_ROLE_ARN` as a secret with GitHub OIDC trust.

The role needs `s3:ListBucket` limited to the `Sandbox/Windows/` prefix and `s3:GetObject` limited to
`arn:aws:s3:::ovdr-build-binary/Sandbox/Windows/*`.

GitHub-hosted runners do not provide Windows Sandbox as a stable nested-virtualization contract, so CI invokes the
same compiled harness directly on its disposable `windows-latest` VM. If Studio requires an interactive desktop or
GPU, change `runs-on` to a controlled `self-hosted, windows, overdare-studio` runner without changing the harness
contract.
