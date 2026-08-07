# OVERDARE Studio Windows smoke test

The Windows smoke test lists Studio builds in AWS S3, resolves the newest Windows Release/Shipping archive, launches
Studio in an isolated profile, waits for a loaded project through `level.browse`, starts the packaged agent sidecar,
checks `tools/list`, and calls `studiorpc_level_browse`.

## Fresh PC setup

`bun run setup:studio-smoke` prepares a new PC. It verifies Windows Sandbox and the required toolchain, creates the
ignored local environment file from the checked-in example, builds the artifacts mapped into the disposable guest,
and runs the one-time Studio authentication bootstrap when no credential exists yet.

Three steps still need a person: enabling Windows Sandbox from an elevated window, entering the AWS credentials, and
signing in to Studio once with the dedicated automation account. The setup command stops with a direct instruction
whenever it reaches one of them, so it is safe to re-run until it reports success.

Install Git, Bun, and the Rust MSVC toolchain first. Microsoft Edge or Google Chrome is required only for the
one-time authentication bootstrap. The host and Sandbox need network access to the configured S3 bucket, and the
host may access Microsoft's download server when XInput 1.3 is not already present.

### 1. Enable Windows Sandbox

Skip this step when `WindowsSandbox.exe` already exists. Otherwise run it once from an elevated PowerShell window:

```powershell
bun run setup:studio-smoke -- -EnableSandbox
```

The command exits with code `3010` when Windows must restart before the feature becomes usable.

### 2. Configure the Studio source

```powershell
bun run setup:studio-smoke
```

The first run copies `.env.example` to the ignored `.env.local` and exits with code `2`. Set the AWS access key and
secret key there, plus `AWS_SESSION_TOKEN` when using temporary AWS credentials. The checked-in example already
contains the fixed storage location:

```text
Bucket: ovdr-build-binary
Region: ap-northeast-2
Prefix: Sandbox/Windows/
```

The AWS identity needs permission to list that bucket prefix and download objects below it. As an alternative for
debugging, configure `OVERDARE_STUDIO_URL` and its required `OVERDARE_STUDIO_SHA256` instead of the S3 values.

### 3. Build and authenticate

```powershell
bun run setup:studio-smoke
```

With the environment complete, the same command installs dependencies from the frozen lockfile and builds the
outputs the smoke run requires:

- `packages/web/dist/client`
- `apps/overdare-ai-agent/target/release/overdare-ai-agent.exe`
- `apps/overdare-ai-agent/.diligent/diagnostics/diligent-web-server.exe`

It then opens Windows Sandbox for the one-time Studio login described below, unless `.credential.local` already
exists. Pass `-SkipBuild`, `-SkipAuthBootstrap`, or `-RunSmoke` to adjust that sequence, and `-EnvFile`,
`-CredentialFile`, or `-AuthBrowserExe` to point at non-default locations.

### 4. Run

```powershell
bun run test:studio-smoke
```

The first smoke run downloads the selected Studio ZIP. Validated archives are cached per PC under
`%LOCALAPPDATA%\OVERDARE\studio-smoke-cache`; later runs reuse the ZIP only while the S3 metadata and computed
SHA-256 still match.

The scripts automatically provide the signed VC and XInput runtime files app-local, configure disposable firewall
and URL-scheme state, create isolated profiles and projects, and clean up guest credentials. A new PC does not need
UE Prerequisites, .NET Framework 3.5, the full DirectX installer, or persistent firewall exceptions installed for
this smoke test.

## One-time Studio authentication bootstrap

The clean Sandbox has no Studio login state. Capture a credential only from a dedicated automation account:

```powershell
bun run test:studio-auth-bootstrap
```

The command opens Studio in Windows Sandbox. Sign in interactively with the automation account. The bootstrap polls
Windows Credential Manager for Studio's `OverdareLogintoken`, saves its exact credential blob to the ignored
`apps/overdare-ai-agent/test/studio-smoke/.credential.local` file, restricts the file ACL to the current Windows
user, and closes the Sandbox. It never prints the account ID or refresh token.

Recent Windows Sandbox images do not include a default web browser. During authentication bootstrap only, the
launcher maps the host's Microsoft Edge (preferred) or Google Chrome application directory read-only and registers
that executable as the disposable Sandbox user's HTTP/HTTPS handler. Browser profile data remains inside the
Sandbox. Use `-AuthBrowserExe <absolute-path>` when neither browser is installed in its standard location.

Subsequent `bun run test:studio-smoke` executions copy that file only into the per-run bridge, import it into the
fresh Sandbox credential store, remove the bridge copy immediately, and delete the imported credential during
cleanup. The local fixture remains outside diagnostics and is not committed because `**/.credential.local` is
ignored. Run the bootstrap again to replace an expired or revoked refresh token.

Use `-CredentialFile <absolute-path>` on `open-windows-sandbox.ps1` to read a credential file outside the repository.
Use `-EnvFile <absolute-path>` to read the smoke environment from another location. Process environment variables
override values from that environment file, which is useful for one-off overrides.

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
downloaded again through a partial file and replaces the cache only after validation.

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
`-OpenMap` argument so every Sandbox run uses the same project fixture contract.

The runner launches `Sandbox/Binaries/Win64/Sandbox-Win64-Shipping.exe` directly instead of the top-level Unreal
bootstrapper. The bootstrapper is the component that invokes the aggregate `UEPrereqSetup_x64.exe`; the Studio smoke
does not exercise that packaging launcher. Before opening the Sandbox, the host validates the required Microsoft
VC and XInput DLL signatures and copies those files into the per-run bridge. The runner stages that runtime app-local
beside Shipping and the isolated agent runtime. If the legacy XInput 1.3 DLL is absent, the host downloads the
hash-pinned, signed Microsoft DirectX redistributable and extracts only `xinput1_3.dll`; it does not run
`DXSETUP.exe`. Missing or unsigned runtime files
fail before the Studio download begins. The harness never installs Windows features, runs the aggregate prerequisite
installer, or writes a fake VC installation marker.

Before launching Studio, the runner adds inbound Windows Firewall allow rules for Shipping, the Studio-bundled AI
agent, the staged Rust agent, and the Bun-packaged web sidecar. This prevents interactive
Windows Security network-access prompts from blocking the smoke automation. The rules exist only inside the
disposable Windows Sandbox environment.

The runner also pre-registers the `ovdrstudio` login callback scheme in the disposable registry, pointing it at the
extracted Shipping executable. Registry presence alone does not stop every Studio build from showing its own
first-run confirmation, so non-interactive smoke runs also use Unreal's `-unattended` mode to suppress UI prompts.
Interactive authentication bootstrap deliberately omits that flag. The harness contains no dialog-clicking
automation and never accepts an unrelated prompt.

The fixed limits are 30 minutes for listing and download, 10 minutes for extraction, 30 seconds for fixture staging,
30 seconds for Studio process start, 3 minutes for project and RPC readiness, 1 minute for agent readiness, 30 seconds
for smoke calls, and 15 seconds for cleanup. The outer Sandbox limit is 60 minutes, leaving time for diagnostics and
cleanup. The runner uses
Studio's existing RPC default, port `13377`; set `OVERDARE_STUDIO_RPC_PORT` only when testing a Studio build
configured for another port.

## Isolation and diagnostics

The smoke harness receives the S3 credentials only long enough to sign the list and download requests. It removes
the AWS credential variables from its process environment after reading the contract. Studio and the agent receive
a newly constructed environment that does not include AWS credentials.

Studio and the agent receive a new `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, project directory, and
`.overdare` root on every run. Their `PATH` contains only the selected executable directory, Windows `System32`,
and the system Windows PowerShell directory required by packaged Studio tooling. The staged local agent runtime
uses `updateMode: disabled`, so a smoke run cannot replace it with a network-downloaded agent version. Only the
explicit, signed host runtime bundle is copied beside the disposable smoke executables.

On success the temporary root is deleted. On failure the harness, Studio stdout/stderr, sanitized logs from
`%LOCALAPPDATA%\Sandbox\Saved\Logs`, agent logs, readiness result, selected S3 object metadata, and tool list are
copied to `artifacts/studio-smoke/<run-id>` before cleanup. Authentication arguments, JSON token fields, and JWTs
are redacted from the preserved Studio diagnostics.

## Windows Sandbox

Windows Sandbox is enabled once per PC through `bun run setup:studio-smoke -- -EnableSandbox`, which wraps
`Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`. The `test:studio-smoke`
command compiles the harness with the explicitly selected Bun
executable and maps only one writable temporary bridge plus the dedicated archive cache. Source code and ignored
repository secrets are not mapped into the guest. The Sandbox performs the S3 list, conditional download, extraction,
Studio launch, and smoke checks. User data, projects, and extracted binaries are never reused.
If the outer timeout is reached, the host signals a running guest bootstrap to stop the runner and shut down Windows
Sandbox before returning the timeout failure. This is best-effort when the Sandbox logon command itself never starts.

Pass `-BunExe <absolute-path>` directly to `open-windows-sandbox.ps1` only when an explicit Bun binary is required.
Use `-StudioCacheDir <absolute-path>` to override the local cache location. Removing that directory safely forces
the next local run to download Studio again.

The launcher disables Sandbox vGPU so the same WSB configuration works from local and Remote Desktop sessions.
Studio uses Windows Advanced Rasterization Platform (WARP) inside the disposable environment.
