# @summary Build the app-local Microsoft runtime bundle used by Studio smoke tests without installing prerequisites.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDir,

    [string]$RuntimeSourceDir = (Join-Path $env:SystemRoot "System32"),

    [switch]$DownloadXInputIfMissing
)

$ErrorActionPreference = "Stop"
$directXUrl = "https://download.microsoft.com/download/8/4/a/84a35bf1-dafe-4ae8-82af-ad2ae20b6b14/directx_Jun2010_redist.exe"
$directXSha256 = "053F76DCBB28802E23341B6A787E3B0791C0FA5C8D4D011B1044172DBF89C73B"
$runtimeNames = @(
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll"
)

function Assert-MicrosoftSignature {
    param([Parameter(Mandatory = $true)][string]$Path)

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if (
        $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch "(^|,)\s*O=Microsoft Corporation(,|$)"
    ) {
        throw "File does not have a valid Microsoft signature: $Path"
    }
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
$runtimeSource = [System.IO.Path]::GetFullPath($RuntimeSourceDir)

foreach ($name in $runtimeNames) {
    $source = Join-Path $runtimeSource $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing Microsoft Visual C++ runtime: $source"
    }
    Assert-MicrosoftSignature -Path $source
    Copy-Item -LiteralPath $source -Destination (Join-Path $resolvedOutput $name) -Force
}

$xinputSource = Join-Path $runtimeSource "xinput1_3.dll"
$temporaryRoot = $null
try {
    if (-not (Test-Path -LiteralPath $xinputSource -PathType Leaf)) {
        if (-not $DownloadXInputIfMissing.IsPresent) {
            throw "Missing Microsoft XInput 1.3 runtime: $xinputSource"
        }
        $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("studio-xinput-" + [guid]::NewGuid().ToString("N"))
        $redistPath = Join-Path $temporaryRoot "directx_Jun2010_redist.exe"
        $redistFiles = Join-Path $temporaryRoot "redist"
        New-Item -ItemType Directory -Path $redistFiles -Force | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri $directXUrl -OutFile $redistPath
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $redistPath).Hash -ne $directXSha256) {
            throw "Microsoft DirectX redist hash did not match the pinned value."
        }
        Assert-MicrosoftSignature -Path $redistPath
        $extractor = Start-Process `
            -FilePath $redistPath `
            -ArgumentList @("/Q", ('/T:"{0}"' -f $redistFiles)) `
            -PassThru `
            -Wait `
            -WindowStyle Hidden
        if ($extractor.ExitCode -ne 0) {
            throw "Microsoft DirectX redist extraction failed with exit code $($extractor.ExitCode)."
        }
        $cab = Join-Path $redistFiles "APR2007_xinput_x64.cab"
        if (-not (Test-Path -LiteralPath $cab -PathType Leaf)) {
            throw "Microsoft DirectX redist did not contain APR2007_xinput_x64.cab."
        }
        & (Join-Path $env:SystemRoot "System32\expand.exe") $cab -F:xinput1_3.dll $resolvedOutput *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not extract xinput1_3.dll from the Microsoft DirectX redist."
        }
        $xinputSource = Join-Path $resolvedOutput "xinput1_3.dll"
    }
    else {
        Copy-Item -LiteralPath $xinputSource -Destination (Join-Path $resolvedOutput "xinput1_3.dll") -Force
        $xinputSource = Join-Path $resolvedOutput "xinput1_3.dll"
    }
    Assert-MicrosoftSignature -Path $xinputSource
}
finally {
    if ($null -ne $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
