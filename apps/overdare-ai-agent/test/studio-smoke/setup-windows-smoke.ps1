# @summary Prepare a fresh Windows PC for the OVERDARE Studio Sandbox smoke test.

[CmdletBinding()]
param(
    [string]$EnvFile,

    [string]$CredentialFile,

    [string]$AuthBrowserExe,

    [switch]$EnableSandbox,

    [switch]$SkipBuild,

    [switch]$SkipAuthBootstrap,

    [switch]$RunSmoke
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$InstallHint
    )

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        throw "Missing required command '$Name'. $InstallHint"
    }
    return $command.Source
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    Write-Host "==> $Description"
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Read-SetupEnvironment {
    param([Parameter(Mandatory = $true)][string]$Path)

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            continue
        }
        $separator = $trimmed.IndexOf("=")
        if ($separator -le 0) {
            continue
        }
        $name = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim().Trim('"').Trim("'")
        $values[$name] = $value
    }
    return $values
}

function Get-SetupValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][hashtable]$FileValues
    )

    $processValue = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        return $processValue
    }
    if ($FileValues.ContainsKey($Name)) {
        return [string]$FileValues[$Name]
    }
    return ""
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..\..")).Path
$envFileWasExplicit = $PSBoundParameters.ContainsKey("EnvFile")
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $PSScriptRoot ".env.local"
}
if ([string]::IsNullOrWhiteSpace($CredentialFile)) {
    $CredentialFile = Join-Path $PSScriptRoot ".credential.local"
}
$resolvedEnvFile = [System.IO.Path]::GetFullPath($EnvFile)
$resolvedCredentialFile = [System.IO.Path]::GetFullPath($CredentialFile)
$sandboxExe = Join-Path $env:SystemRoot "System32\WindowsSandbox.exe"

if (-not (Test-Path -LiteralPath $sandboxExe -PathType Leaf)) {
    if (-not $EnableSandbox.IsPresent) {
        throw @"
Windows Sandbox is not enabled. Open PowerShell as Administrator and run:
  bun run setup:studio-smoke -- -EnableSandbox
Restart Windows if requested, then run the setup command again.
"@
    }
    if (-not (Test-IsAdministrator)) {
        throw "-EnableSandbox requires an elevated PowerShell window."
    }

    $feature = Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM
    if ($feature.State -ne "Enabled") {
        Write-Host "==> Enabling Windows Sandbox"
        $null = Enable-WindowsOptionalFeature `
            -Online `
            -FeatureName Containers-DisposableClientVM `
            -All `
            -NoRestart
    }

    if (-not (Test-Path -LiteralPath $sandboxExe -PathType Leaf)) {
        Write-Host "Windows Sandbox is enabled. Restart Windows, then run the setup command again."
        exit 3010
    }
}

$bunPath = Resolve-RequiredCommand `
    -Name "bun.exe" `
    -InstallHint "Install Bun and make bun.exe available on PATH."

if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
    if ($envFileWasExplicit) {
        throw "The requested Studio smoke environment file does not exist: $resolvedEnvFile"
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ".env.example") -Destination $resolvedEnvFile
    Write-Host @"
Created $resolvedEnvFile
Fill in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, then run this setup command again.
Set AWS_SESSION_TOKEN as well when using temporary credentials.
"@
    exit 2
}

$fileValues = Read-SetupEnvironment -Path $resolvedEnvFile
$hasDirectSource = -not [string]::IsNullOrWhiteSpace((Get-SetupValue -Name "OVERDARE_STUDIO_URL" -FileValues $fileValues))
$missingValues = [System.Collections.Generic.List[string]]::new()
if ($hasDirectSource) {
    if ([string]::IsNullOrWhiteSpace((Get-SetupValue -Name "OVERDARE_STUDIO_SHA256" -FileValues $fileValues))) {
        $missingValues.Add("OVERDARE_STUDIO_SHA256")
    }
}
else {
    foreach ($name in @(
        "OVERDARE_STUDIO_S3_BUCKET",
        "OVERDARE_STUDIO_S3_REGION",
        "OVERDARE_STUDIO_S3_PREFIX",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY"
    )) {
        if ([string]::IsNullOrWhiteSpace((Get-SetupValue -Name $name -FileValues $fileValues))) {
            $missingValues.Add($name)
        }
    }
}
if ([string]::IsNullOrWhiteSpace((Get-SetupValue -Name "OVERDARE_STUDIO_ARGS_JSON" -FileValues $fileValues))) {
    $missingValues.Add("OVERDARE_STUDIO_ARGS_JSON")
}
if ($missingValues.Count -gt 0) {
    throw "Complete the Studio smoke environment before setup: $($missingValues -join ', ')"
}

Push-Location $repoRoot
try {
    if (-not $SkipBuild.IsPresent) {
        $cargoPath = Resolve-RequiredCommand `
            -Name "cargo.exe" `
            -InstallHint "Install the Rust MSVC toolchain and make cargo.exe available on PATH."
        Invoke-CheckedCommand `
            -FilePath $bunPath `
            -ArgumentList @("install", "--frozen-lockfile") `
            -Description "Installing repository dependencies"
        Invoke-CheckedCommand `
            -FilePath $bunPath `
            -ArgumentList @("run", "--cwd", "packages/web", "build") `
            -Description "Building the web client"
        Invoke-CheckedCommand `
            -FilePath $bunPath `
            -ArgumentList @("run", "overdare-ai-agent:build-sidecar") `
            -Description "Building the packaged web sidecar"
        Invoke-CheckedCommand `
            -FilePath $cargoPath `
            -ArgumentList @(
                "build",
                "--manifest-path",
                "apps/overdare-ai-agent/Cargo.toml",
                "--release"
            ) `
            -Description "Building the OVERDARE Agent"
    }

    $sandboxLauncher = Join-Path $PSScriptRoot "open-windows-sandbox.ps1"
    if (
        -not $SkipAuthBootstrap.IsPresent -and
        -not (Test-Path -LiteralPath $resolvedCredentialFile -PathType Leaf)
    ) {
        Write-Host "==> Starting one-time Studio authentication bootstrap"
        $authArguments = @(
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $sandboxLauncher,
            "-EnvFile",
            $resolvedEnvFile,
            "-CredentialFile",
            $resolvedCredentialFile,
            "-AuthBootstrap"
        )
        if (-not [string]::IsNullOrWhiteSpace($AuthBrowserExe)) {
            $authArguments += @("-AuthBrowserExe", $AuthBrowserExe)
        }
        Invoke-CheckedCommand `
            -FilePath "powershell.exe" `
            -ArgumentList $authArguments `
            -Description "Capturing the Studio automation credential"
        if (-not (Test-Path -LiteralPath $resolvedCredentialFile -PathType Leaf)) {
            throw "Studio authentication completed without creating $resolvedCredentialFile"
        }
    }

    if ($RunSmoke.IsPresent) {
        if (-not (Test-Path -LiteralPath $resolvedCredentialFile -PathType Leaf)) {
            throw "Studio credential is missing. Run setup without -SkipAuthBootstrap first."
        }
        Invoke-CheckedCommand `
            -FilePath "powershell.exe" `
            -ArgumentList @(
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                $sandboxLauncher,
                "-EnvFile",
                $resolvedEnvFile,
                "-CredentialFile",
                $resolvedCredentialFile
            ) `
            -Description "Running the Windows Sandbox Studio smoke test"
    }
}
finally {
    Pop-Location
}

Write-Host "Fresh-PC Studio smoke setup is ready."
if (-not $RunSmoke.IsPresent) {
    Write-Host "Run: bun run test:studio-smoke"
}
