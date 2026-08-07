# @summary Launch the OVERDARE Studio smoke test in Windows Sandbox with explicit mapped inputs.

[CmdletBinding()]
param(
    [string]$BunExe,

    [string]$ArtifactDir,

    [string]$EnvFile,

    [string]$CredentialFile,

    [string]$StudioCacheDir,

    [string]$AuthBrowserExe,

    [switch]$AuthBootstrap,

    [ValidateRange(60, 3600)]
    [int]$SandboxTimeoutSeconds = 3600
)

$ErrorActionPreference = "Stop"

function Resolve-RequiredFile {
    param([string]$Path, [string]$Description)

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
        throw "$Description is not a file: $Path"
    }
    return $resolved.Path
}

function Escape-Xml {
    param([string]$Value)
    return [System.Security.SecurityElement]::Escape($Value)
}

function Read-EnvFile {
    param([string]$Path)

    $values = @{}
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $Path) {
        $lineNumber += 1
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed.StartsWith("export ")) {
            $trimmed = $trimmed.Substring(7).TrimStart()
        }
        $separator = $trimmed.IndexOf("=")
        if ($separator -le 0) {
            throw "Invalid env entry at ${Path}:$lineNumber"
        }
        $name = $trimmed.Substring(0, $separator).Trim()
        if ($name -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
            throw "Invalid env name at ${Path}:$lineNumber"
        }
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2 -and (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        )) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$name] = $value
    }
    return $values
}

if ([string]::IsNullOrWhiteSpace($BunExe)) {
    $bunCommand = Get-Command bun.exe -CommandType Application -All -ErrorAction Stop |
        Where-Object { Test-Path -LiteralPath $_.Source -PathType Leaf } |
        Select-Object -Last 1
    if ($null -eq $bunCommand) {
        throw "Could not resolve an existing Bun executable from PATH."
    }
    $BunExe = $bunCommand.Source
}

$bunPath = Resolve-RequiredFile -Path $BunExe -Description "Bun executable"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..\..")).Path
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $PSScriptRoot ".env.local"
}
$envFileWasExplicit = $PSBoundParameters.ContainsKey("EnvFile")
$credentialFileWasExplicit = $PSBoundParameters.ContainsKey("CredentialFile")
if ([string]::IsNullOrWhiteSpace($CredentialFile)) {
    $CredentialFile = Join-Path $PSScriptRoot ".credential.local"
}
$credentialPath = [System.IO.Path]::GetFullPath($CredentialFile)
$sandboxPath = Join-Path $env:SystemRoot "System32\WindowsSandbox.exe"
if (-not (Test-Path -LiteralPath $sandboxPath -PathType Leaf)) {
    throw @"
Windows Sandbox is not installed or enabled on this machine.
Open PowerShell as Administrator and run:
  Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
Restart Windows if requested, then run:
  bun run test:studio-smoke
"@
}
$sandboxExe = (Resolve-Path -LiteralPath $sandboxPath -ErrorAction Stop).Path
$runtimePreparer = Resolve-RequiredFile `
    -Path (Join-Path $PSScriptRoot "prepare-windows-runtime.ps1") `
    -Description "Windows runtime preparation script"

$authBrowserPath = $null
if ($AuthBootstrap.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($AuthBrowserExe)) {
        $AuthBrowserExe = @(
            "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            "C:\Program Files\Google\Chrome\Application\chrome.exe",
            "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if ([string]::IsNullOrWhiteSpace($AuthBrowserExe)) {
        throw "Studio authentication bootstrap requires Microsoft Edge or Google Chrome on the host."
    }
    $authBrowserPath = Resolve-RequiredFile -Path $AuthBrowserExe -Description "Authentication browser executable"
}

if ([string]::IsNullOrWhiteSpace($ArtifactDir)) {
    $ArtifactDir = Join-Path $repoRoot "artifacts\studio-smoke"
}
$artifactPath = [System.IO.Path]::GetFullPath($ArtifactDir)
if ([string]::IsNullOrWhiteSpace($StudioCacheDir)) {
    $StudioCacheDir = Join-Path $env:LOCALAPPDATA "OVERDARE\studio-smoke-cache"
}
New-Item -ItemType Directory -Path $StudioCacheDir -Force | Out-Null
$studioCachePath = (Resolve-Path -LiteralPath $StudioCacheDir -ErrorAction Stop).Path

$bridgeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("overdare-studio-sandbox-" + [guid]::NewGuid().ToString("N"))
$bridgeArtifacts = Join-Path $bridgeRoot "artifacts"
$bridgeConfig = Join-Path $bridgeRoot "sandbox-env.json"
$bridgeRunner = Join-Path $bridgeRoot "studio-smoke-runner.exe"
$bridgeRuntimeInput = Join-Path $bridgeRoot "runtime-input"
$bridgeCredential = Join-Path $bridgeRoot "studio-credential.local"
$bridgeCapturedCredential = Join-Path $bridgeRoot "captured-credential.local"
$bridgeWindowsRuntime = Join-Path $bridgeRoot "windows-runtime"
$bridgeCancel = Join-Path $bridgeRoot "cancel-requested"
$bridgeBootstrap = Join-Path $bridgeRoot "sandbox-bootstrap.ps1"
$bridgeCredentialTool = Join-Path $bridgeRoot "studio-credential.ps1"
$wsbPath = Join-Path $bridgeRoot "overdare-studio-smoke.wsb"
New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
try {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimePreparer `
        -OutputDir $bridgeWindowsRuntime `
        -DownloadXInputIfMissing
    if ($LASTEXITCODE -ne 0) {
        throw "Could not prepare the app-local Windows runtime bundle."
    }
}
catch {
    $resolvedBridge = [System.IO.Path]::GetFullPath($bridgeRoot)
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedBridge.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedBridge -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "sandbox-bootstrap.ps1") -Destination $bridgeBootstrap -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "studio-credential.ps1") -Destination $bridgeCredentialTool -Force

$forwardedNames = @(
    "OVERDARE_STUDIO_URL",
    "OVERDARE_STUDIO_S3_BUCKET",
    "OVERDARE_STUDIO_S3_REGION",
    "OVERDARE_STUDIO_S3_PREFIX",
    "OVERDARE_STUDIO_SHA256",
    "OVERDARE_STUDIO_RPC_PORT",
    "OVERDARE_STUDIO_ARGS_JSON",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN"
)
$deprecatedNames = @("OVERDARE_STUDIO_EXE_RELATIVE_PATH")

$envFileValues = @{}
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
    $envFileValues = Read-EnvFile -Path (Resolve-Path -LiteralPath $EnvFile).Path
    foreach ($name in $envFileValues.Keys) {
        if ($name -notin $forwardedNames -and $name -notin $deprecatedNames) {
            throw "Unsupported Studio smoke env variable in ${EnvFile}: $name"
        }
    }
}
elseif ($envFileWasExplicit) {
    throw "Studio smoke env file does not exist: $EnvFile"
}

$forwardedEnvironment = @{}
foreach ($name in $forwardedNames) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value) -and $envFileValues.ContainsKey($name)) {
        $value = [string]$envFileValues[$name]
    }
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $forwardedEnvironment[$name] = $value
    }
}
$hasDirectUrl = $forwardedEnvironment.ContainsKey("OVERDARE_STUDIO_URL")
$s3Names = @(
    "OVERDARE_STUDIO_S3_BUCKET",
    "OVERDARE_STUDIO_S3_REGION",
    "OVERDARE_STUDIO_S3_PREFIX",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY"
)
$hasAnyS3Value = @($s3Names | Where-Object { $forwardedEnvironment.ContainsKey($_) }).Count -gt 0
if ($hasDirectUrl -and $hasAnyS3Value) {
    throw "Configure either OVERDARE_STUDIO_URL or the S3 source in $EnvFile, not both."
}
if (-not $hasDirectUrl) {
    foreach ($name in $s3Names) {
        if (-not $forwardedEnvironment.ContainsKey($name)) {
            throw "Missing $name. Copy .env.example to .env.local and fill in the AWS credentials."
        }
    }
}
if (-not $forwardedEnvironment.ContainsKey("OVERDARE_STUDIO_ARGS_JSON")) {
    throw "Missing OVERDARE_STUDIO_ARGS_JSON in the Studio smoke environment."
}
if ($hasDirectUrl -and -not $forwardedEnvironment.ContainsKey("OVERDARE_STUDIO_SHA256")) {
    throw "Direct URL mode requires OVERDARE_STUDIO_SHA256."
}
$forwardedEnvironment["OVERDARE_STUDIO_ARTIFACT_DIR"] = "C:\studio-smoke-bridge\artifacts"
$forwardedEnvironment["OVERDARE_STUDIO_CACHE_DIR"] = "C:\studio-smoke-cache"
$forwardedEnvironment["OVERDARE_STUDIO_WINDOWS_RUNTIME_DIR"] = "C:\studio-smoke-bridge\windows-runtime"
$forwardedEnvironment["OVERDARE_STUDIO_CREDENTIAL_TOOL"] = "C:\studio-smoke-bridge\studio-credential.ps1"
$mode = if ($AuthBootstrap.IsPresent) { "auth-bootstrap" } else { "smoke" }
if ($AuthBootstrap.IsPresent) {
    $forwardedEnvironment["OVERDARE_STUDIO_AUTH_BOOTSTRAP"] = "1"
    $forwardedEnvironment["OVERDARE_STUDIO_AUTH_BROWSER_EXE"] =
        "C:\studio-smoke-browser\$([System.IO.Path]::GetFileName($authBrowserPath))"
}
else {
    $forwardedEnvironment["OVERDARE_SMOKE_RUNTIME_INPUT"] = "C:\studio-smoke-runtime-input"
    if (Test-Path -LiteralPath $credentialPath -PathType Leaf) {
        $credentialTool = Join-Path $PSScriptRoot "studio-credential.ps1"
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $credentialTool `
            -Action Validate -CredentialFile $credentialPath
        if ($LASTEXITCODE -ne 0) {
            throw "The Studio credential fixture is invalid: $credentialPath"
        }
        Copy-Item -LiteralPath $credentialPath -Destination $bridgeCredential -Force
        $forwardedEnvironment["OVERDARE_STUDIO_CREDENTIAL_FILE"] = "C:\studio-smoke-bridge\studio-credential.local"
        $forwardedEnvironment["OVERDARE_STUDIO_CREDENTIAL_EPHEMERAL"] = "1"
    }
    elseif ($credentialFileWasExplicit) {
        throw "Studio credential fixture does not exist: $credentialPath"
    }
}

New-Item -ItemType Directory -Path $bridgeArtifacts -Force | Out-Null
if (-not $AuthBootstrap.IsPresent) {
    $agentExe = Resolve-RequiredFile `
        -Path (Join-Path $repoRoot "apps\overdare-ai-agent\target\release\overdare-ai-agent.exe") `
        -Description "OVERDARE agent executable"
    $sidecarRoot = Join-Path $repoRoot "apps\overdare-ai-agent\.diligent\diagnostics"
    $sidecarExe = Resolve-RequiredFile `
        -Path (Join-Path $sidecarRoot "diligent-web-server.exe") `
        -Description "OVERDARE sidecar executable"
    $webDist = Join-Path $repoRoot "apps\overdare-ai-agent\sidecar\dist\client"
    if (-not (Test-Path -LiteralPath $webDist -PathType Container)) {
        throw "Web distribution is missing. Run 'bun run overdare-ai-agent:web:build' first: $webDist"
    }
    New-Item -ItemType Directory -Path (Join-Path $bridgeRuntimeInput "dist") -Force | Out-Null
    Copy-Item -LiteralPath $agentExe -Destination (Join-Path $bridgeRuntimeInput "overdare-ai-agent.exe") -Force
    Copy-Item -LiteralPath $sidecarExe -Destination (Join-Path $bridgeRuntimeInput "diligent-web-server.exe") -Force
    Copy-Item -LiteralPath $webDist -Destination (Join-Path $bridgeRuntimeInput "dist\client") -Recurse -Force
    if (Test-Path -LiteralPath (Join-Path $sidecarRoot "assets") -PathType Container) {
        Copy-Item -LiteralPath (Join-Path $sidecarRoot "assets") -Destination (Join-Path $bridgeRuntimeInput "assets") -Recurse -Force
    }
}
$compileOutput = & $bunPath build `
    (Join-Path $repoRoot "apps\overdare-ai-agent\test\studio-smoke\run.ts") `
    --compile `
    --target=bun-windows-x64 `
    --outfile $bridgeRunner 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $bridgeRunner -PathType Leaf)) {
    throw "Could not compile the standalone Sandbox smoke runner:`n$($compileOutput -join [Environment]::NewLine)"
}
@{ mode = $mode; environment = $forwardedEnvironment } |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $bridgeConfig -Encoding UTF8

$bridgeXml = Escape-Xml $bridgeRoot
$studioCacheXml = Escape-Xml $studioCachePath
$authBrowserMappingXml = ""
if ($AuthBootstrap.IsPresent) {
    $authBrowserRootXml = Escape-Xml (Split-Path -Parent $authBrowserPath)
    $authBrowserMappingXml = @"
    <MappedFolder>
      <HostFolder>$authBrowserRootXml</HostFolder>
      <SandboxFolder>C:\studio-smoke-browser</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
"@
}
$wsb = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$bridgeXml</HostFolder>
      <SandboxFolder>C:\studio-smoke-bridge</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$studioCacheXml</HostFolder>
      <SandboxFolder>C:\studio-smoke-cache</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
$authBrowserMappingXml
  </MappedFolders>
  <LogonCommand>
    <Command>C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\studio-smoke-bridge\sandbox-bootstrap.ps1 -ConfigPath C:\studio-smoke-bridge\sandbox-env.json</Command>
  </LogonCommand>
</Configuration>
"@
$wsb | Set-Content -LiteralPath $wsbPath -Encoding UTF8

try {
    Start-Process -FilePath "explorer.exe" -ArgumentList ('"' + $wsbPath + '"') | Out-Null
    if ($AuthBootstrap.IsPresent) {
        Write-Host "Windows Sandbox is open. Sign in to Studio with the dedicated automation account."
        Write-Host "The Sandbox will close automatically after the Studio credential is captured."
    }
    $exitCodePath = Join-Path $bridgeRoot "exit-code.txt"
    $deadline = [DateTime]::UtcNow.AddSeconds($SandboxTimeoutSeconds)
    $timedOut = $false
    while (
        -not (Test-Path -LiteralPath $exitCodePath -PathType Leaf) -and
        [DateTime]::UtcNow -lt $deadline
    ) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $exitCodePath -PathType Leaf)) {
        $timedOut = $true
        Set-Content -LiteralPath $bridgeCancel -Value "Host timeout" -Encoding ASCII
        $cancelDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while (
            -not (Test-Path -LiteralPath $exitCodePath -PathType Leaf) -and
            [DateTime]::UtcNow -lt $cancelDeadline
        ) {
            Start-Sleep -Milliseconds 500
        }
    }

    New-Item -ItemType Directory -Path $artifactPath -Force | Out-Null
    foreach ($diagnosticName in @(
        "sandbox-bootstrap-error.txt",
        "sandbox-runner.log",
        "sandbox-runner.stdout.log",
        "sandbox-runner.stderr.log"
    )) {
        $diagnosticPath = Join-Path $bridgeRoot $diagnosticName
        if (Test-Path -LiteralPath $diagnosticPath -PathType Leaf) {
            Copy-Item -LiteralPath $diagnosticPath -Destination $artifactPath -Force
        }
    }
    if (Test-Path -LiteralPath $bridgeArtifacts) {
        Copy-Item -Path (Join-Path $bridgeArtifacts "*") -Destination $artifactPath -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($timedOut) {
        throw "Windows Sandbox did not complete within $SandboxTimeoutSeconds seconds. Check $artifactPath for bootstrap diagnostics."
    }
    # An empty or malformed file must never cast to 0; that would score a failed run as a pass.
    $rawExitCode = (Get-Content -LiteralPath $exitCodePath -Raw)
    if ($null -ne $rawExitCode) { $rawExitCode = $rawExitCode.Trim() }
    if ([string]::IsNullOrWhiteSpace($rawExitCode) -or $rawExitCode -notmatch '^-?\d+$') {
        throw "Windows Sandbox reported an unreadable smoke exit code '$rawExitCode'. Check $artifactPath for diagnostics."
    }
    $testExitCode = [int]$rawExitCode

    if ($testExitCode -ne 0) {
        throw "OVERDARE Studio smoke test failed in Windows Sandbox with exit code $testExitCode."
    }
    if ($AuthBootstrap.IsPresent) {
        if (-not (Test-Path -LiteralPath $bridgeCapturedCredential -PathType Leaf)) {
            throw "Studio login completed without producing a credential fixture."
        }
        $credentialTool = Join-Path $PSScriptRoot "studio-credential.ps1"
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $credentialTool `
            -Action Validate -CredentialFile $bridgeCapturedCredential
        if ($LASTEXITCODE -ne 0) {
            throw "The captured Studio credential fixture is invalid."
        }
        $credentialParent = Split-Path -Parent $credentialPath
        if (-not [string]::IsNullOrWhiteSpace($credentialParent)) {
            New-Item -ItemType Directory -Path $credentialParent -Force | Out-Null
        }
        Move-Item -LiteralPath $bridgeCapturedCredential -Destination $credentialPath -Force
        $acl = Get-Acl -LiteralPath $credentialPath
        $acl.SetAccessRuleProtection($true, $false)
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.SetAccessRule($rule)
        Set-Acl -LiteralPath $credentialPath -AclObject $acl
        Write-Host "Studio credential captured: $credentialPath"
    }
}
finally {
    $resolvedBridge = [System.IO.Path]::GetFullPath($bridgeRoot)
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedBridge.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
        for ($attempt = 0; $attempt -lt 20 -and (Test-Path -LiteralPath $resolvedBridge); $attempt++) {
            Remove-Item -LiteralPath $resolvedBridge -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $resolvedBridge) {
                Start-Sleep -Milliseconds 500
            }
        }
        if (Test-Path -LiteralPath $resolvedBridge) {
            Write-Warning "Could not remove the empty Sandbox bridge after waiting for Windows Sandbox shutdown: $resolvedBridge"
        }
    }
}
